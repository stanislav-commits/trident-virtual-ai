import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as XLSX from 'xlsx';
import pdfParse from 'pdf-parse';
import { AssetEntity } from '../assets/entities/asset.entity';
import { LlmService } from '../../integrations/llm/llm.service';
import { PmsService, UpsertPmsTaskInput } from './pms.service';
import { AssetHoursService } from './asset-hours.service';
import { addInterval } from './date-interval.util';
import { departmentForRole } from '../crew/crew-ranks';

/** A single normalized task the LLM extracted from a heterogeneous PMS file. */
export interface PmsImportDraft {
  task: string;
  category?: string;
  planning?: string;
  description?: string | null;
  responsibleRole?: string | null;
  department?: string | null;
  sfiGroup?: string | null;
  intervalValue?: number | null;
  intervalUnit?: string | null;
  intervalHours?: number | null;
  dueDate?: string | null;
  lastDoneAt?: string | null;
  // history mode: when the work was performed + the hour-counter reading then
  completedAt?: string | null;
  lastDoneHours?: number | null;
  completedByName?: string | null;
  // source equipment name as written in the file
  assetHint?: string | null;
  // resolved against the ship's asset register
  assetMatch?: { id: string; name: string; matchType: string } | null;
  confidence?: 'high' | 'low';
}

export interface PmsImportPreview {
  drafts: PmsImportDraft[];
  counts: { total: number; matchedAssets: number; lowConfidence: number };
  sourceChars: number;
  notes: string[];
}

const CATEGORIES = [
  'Inspection',
  'Service',
  'Replacement',
  'Overhaul',
  'Lubrication',
  'Test',
  'Cleaning',
  'Calibration',
  'Survey',
  'Repair',
  'Other',
];

// Heterogeneous PMS sheets are messy; keep each LLM batch small enough that
// the JSON response fits comfortably under the token cap.
// Smaller chunks keep each batch's task list well under the 4000-token output
// cap — dense batches used to overflow it, truncating the JSON and dropping the
// whole batch. Fewer tasks per batch also means faster, more reliable mapping.
const CHUNK_CHARS = 4500;
const MAX_SOURCE_CHARS = 120_000; // safety cap on a single import
const MAP_CONCURRENCY = 10; // chunks mapped in parallel (keeps the request fast)
// Route the tabular mapping through Claude Haiku — fast + high throughput, far
// quicker than the OpenAI sub-model endpoint for a multi-batch import.
const MAP_MODEL = 'claude-haiku-4-5';

interface LlmTask {
  task?: string;
  category?: string;
  responsible?: string;
  interval_hours?: number | string | null;
  interval_value?: number | string | null;
  interval_unit?: string | null;
  due_date?: string | null;
  last_done?: string | null;
  description?: string | null;
  asset?: string | null;
  sfi_group?: string | null;
  // history mode
  completed_date?: string | null;
  hour_counter?: number | string | null;
  performed_by?: string | null;
  spares?: string | null;
}

export type PmsImportMode = 'tasks' | 'history';

@Injectable()
export class PmsImportService {
  private readonly logger = new Logger(PmsImportService.name);

  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    private readonly llmService: LlmService,
    private readonly pmsService: PmsService,
    private readonly assetHoursService: AssetHoursService,
  ) {}

  // ── public API ──

  /** Parse a file (PDF / XLSX / CSV / text) into a confirmable preview. */
  async preview(
    shipId: string,
    file: { buffer?: Buffer; originalname?: string; mimetype?: string } | null,
    rawText?: string,
    mode: PmsImportMode = 'tasks',
  ): Promise<PmsImportPreview> {
    const text = (rawText?.trim() || (await this.extractText(file))).slice(
      0,
      MAX_SOURCE_CHARS,
    );
    if (!text.trim()) {
      throw new BadRequestException(
        'No readable text found in the uploaded file.',
      );
    }
    if (!this.llmService.isConfigured()) {
      throw new ServiceUnavailableException(
        'AI mapping is unavailable (LLM not configured).',
      );
    }

    const assets = await this.assetRepository.find({
      where: { shipId },
      select: ['id', 'displayName', 'brand', 'model'],
    });

    const notes: string[] = [];
    const llmTasks: LlmTask[] = [];
    const chunks = this.chunk(text);
    if (chunks.length > 1) {
      notes.push(`Source split into ${chunks.length} batches for mapping.`);
    }
    // Map chunks with bounded concurrency — a large task list is ~10 batches;
    // running them sequentially made the request time out. Order is preserved
    // so the "batch N could not be mapped" notes stay meaningful.
    const results: (LlmTask[] | null)[] = [];
    for (let i = 0; i < chunks.length; i += MAP_CONCURRENCY) {
      const batch = chunks.slice(i, i + MAP_CONCURRENCY);
      results.push(
        ...(await Promise.all(batch.map((c) => this.mapChunk(c, mode)))),
      );
    }
    results.forEach((part, i) => {
      if (part == null) {
        notes.push(`Batch ${i + 1} could not be mapped by the AI.`);
      } else {
        llmTasks.push(...part);
      }
    });

    const drafts = llmTasks
      .map((t) => this.toDraft(t, assets, mode))
      .filter((d): d is PmsImportDraft => d != null);

    return {
      drafts,
      counts: {
        total: drafts.length,
        matchedAssets: drafts.filter((d) => d.assetMatch).length,
        lowConfidence: drafts.filter((d) => d.confidence === 'low').length,
      },
      sourceChars: text.length,
      notes,
    };
  }

  /**
   * Propose PMS tasks for ONE asset from its equipment manual's text. Same
   * draft shape as import, but every task is pre-linked to the asset (the
   * manual is about that equipment). Intervals are suggestions to review.
   */
  async suggestFromManual(
    shipId: string,
    assetId: string,
    markdown: string,
  ): Promise<PmsImportPreview> {
    if (!this.llmService.isConfigured()) {
      throw new ServiceUnavailableException(
        'AI is unavailable (LLM not configured).',
      );
    }
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) throw new BadRequestException('Asset not found on this ship.');
    const text = (markdown ?? '').trim().slice(0, MAX_SOURCE_CHARS);
    if (!text) {
      throw new BadRequestException(
        'The manual has no readable extracted text yet.',
      );
    }
    const assets = await this.assetRepository.find({
      where: { shipId },
      select: ['id', 'displayName', 'brand', 'model'],
    });

    const notes: string[] = [
      'Suggested from the linked manual — review intervals before importing.',
    ];
    // A manual is mostly operation/specs/troubleshooting — only the chunks
    // that actually look like a maintenance schedule are worth sending.
    const allChunks = this.chunk(text);
    let chunks = allChunks.filter((c) => MAINTENANCE_SIGNAL.test(c));
    if (chunks.length === 0) chunks = allChunks.slice(0, 4);
    chunks = chunks.slice(0, 12); // cap LLM calls on huge manuals

    const llmTasks: LlmTask[] = [];
    for (const chunk of chunks) {
      const part = await this.mapChunkSuggest(chunk, asset.displayName);
      if (part) llmTasks.push(...part);
    }

    // Every suggestion belongs to this asset; de-duplicate across chunks.
    const seen = new Set<string>();
    const actions = llmTasks
      .map((t) => this.toDraft(t, assets))
      .filter((d): d is PmsImportDraft => d != null)
      // Keep ONLY tasks with a real interval — interval-less items are the
      // generic / invented noise the user doesn't want.
      .filter((d) => d.intervalHours != null || d.intervalValue != null)
      .filter((d) => {
        const key = `${d.task.toLowerCase().trim()}|${
          d.intervalHours ?? ''
        }|${d.intervalValue ?? ''}${d.intervalUnit ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    // Merge every action that shares the same interval into ONE task with a
    // checklist description (e.g. "Weekly inspection" listing all weekly jobs).
    const drafts = this.groupByInterval(actions, asset.displayName).map((d) => ({
      ...d,
      assetHint: asset.displayName,
      assetMatch: {
        id: asset.id,
        name: asset.displayName,
        matchType: 'manual',
      },
    }));
    notes.push(
      'Actions sharing an interval are merged into one task (see the checklist in each description).',
    );
    if (drafts.length === 0) {
      notes.push(
        'No maintenance schedule with intervals was found in this manual.',
      );
    }

    return {
      drafts,
      counts: {
        total: drafts.length,
        matchedAssets: drafts.length,
        lowConfidence: drafts.filter((d) => d.confidence === 'low').length,
      },
      sourceChars: text.length,
      notes,
    };
  }

  /**
   * Collapse many single-action drafts into one task per distinct interval.
   * The merged task's title names the interval + equipment ("Weekly Port
   * Genset inspection"); its description is a checklist of the actions.
   */
  private groupByInterval(
    actions: PmsImportDraft[],
    assetName: string,
  ): PmsImportDraft[] {
    const groups = new Map<string, PmsImportDraft[]>();
    for (const a of actions) {
      const key = `${a.intervalHours ?? ''}|${a.intervalValue ?? ''}|${
        a.intervalValue != null ? a.intervalUnit ?? 'months' : ''
      }`;
      const arr = groups.get(key) ?? [];
      arr.push(a);
      groups.set(key, arr);
    }
    const out: PmsImportDraft[] = [];
    for (const items of groups.values()) {
      if (items.length === 1) {
        out.push(items[0]);
        continue;
      }
      const head = items[0];
      const label = this.intervalLabel(
        head.intervalHours ?? null,
        head.intervalValue ?? null,
        head.intervalUnit ?? null,
      );
      const verb = this.dominantVerb(items);
      const title = `${label} ${assetName} ${verb}`.replace(/\s+/g, ' ').trim();
      const checklist = items
        .map((it) => `- ${it.task}${it.description ? ` — ${it.description}` : ''}`)
        .join('\n');
      out.push({
        ...head,
        task: title.slice(0, 200),
        category: this.dominantCategory(items),
        description: checklist,
      });
    }
    return out;
  }

  /** Human label for an interval, e.g. "Weekly", "6-monthly / 250 h", "Annual". */
  private intervalLabel(
    hours: number | null,
    value: number | null,
    unit: string | null,
  ): string {
    let cal = '';
    if (value != null) {
      const u = unit ?? 'months';
      if (value === 1 && u === 'days') cal = 'Daily';
      else if (value === 1 && u === 'weeks') cal = 'Weekly';
      else if (value === 1 && u === 'months') cal = 'Monthly';
      else if (value === 3 && u === 'months') cal = 'Quarterly';
      else if (value === 6 && u === 'months') cal = '6-monthly';
      else if (value === 1 && u === 'years') cal = 'Annual';
      else if (value === 2 && u === 'years') cal = 'Biennial';
      else cal = `Every ${value} ${u}`;
    }
    const hrs = hours != null ? `${hours} h` : '';
    if (cal && hrs) return `${cal} / ${hrs}`;
    return cal || (hrs ? `Every ${hrs}` : 'Scheduled');
  }

  private dominantCategory(items: PmsImportDraft[]): string {
    const counts = new Map<string, number>();
    for (const it of items) {
      const c = it.category ?? 'Service';
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Service';
  }

  /** A noun for the merged title based on the dominant category. */
  private dominantVerb(items: PmsImportDraft[]): string {
    const cat = this.dominantCategory(items).toLowerCase();
    const map: Record<string, string> = {
      inspection: 'inspection',
      cleaning: 'cleaning',
      lubrication: 'lubrication',
      test: 'test',
      calibration: 'calibration',
      replacement: 'service',
      overhaul: 'overhaul',
      survey: 'survey',
      repair: 'service',
    };
    return map[cat] ?? 'service';
  }

  private async mapChunkSuggest(
    chunk: string,
    assetName: string,
  ): Promise<LlmTask[] | null> {
    const result = await this.llmService.createJsonChatCompletion<{
      tasks?: LlmTask[];
    }>({
      systemPrompt: SUGGEST_SYSTEM_PROMPT,
      userPrompt: `Equipment: ${assetName}\n\nManual excerpt:\n"""\n${chunk}\n"""`,
      temperature: 0.2,
      maxTokens: 4000,
      schemaHint: SCHEMA_HINT,
    });
    if (!result || !Array.isArray(result.tasks)) return null;
    return result.tasks;
  }

  /** Persist confirmed drafts as real PMS tasks. */
  async commit(
    shipId: string,
    drafts: PmsImportDraft[],
    mode: PmsImportMode = 'tasks',
  ): Promise<{ created: number }> {
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new BadRequestException('No tasks to import.');
    }
    if (mode === 'history') return this.commitHistory(shipId, drafts);
    // Anchor each hours-interval task to its asset's CURRENT running hours, so
    // the hours countdown has a baseline from the moment it's imported.
    const matchedAssetIds = [
      ...new Set(
        drafts.map((d) => d.assetMatch?.id).filter((v): v is string => !!v),
      ),
    ];
    const hoursByAsset = new Map<string, number | null>();
    await Promise.all(
      matchedAssetIds.map(async (id) => {
        hoursByAsset.set(
          id,
          await this.assetHoursService.currentHours(shipId, id),
        );
      }),
    );

    const inputs: UpsertPmsTaskInput[] = drafts
      .filter((d) => d.task?.trim())
      .map((d) => {
        const planned =
          d.planning === 'unplanned'
            ? 'unplanned'
            : d.intervalValue != null || d.intervalHours != null
              ? 'planned'
              : (d.planning ?? 'planned');
        const assetHours = d.assetMatch
          ? (hoursByAsset.get(d.assetMatch.id) ?? null)
          : null;
        // First calendar due: a stated date, else one interval from today, so
        // the calendar side is active (and on dual-interval tasks both the
        // calendar and the hours clock run — whichever is nearer wins).
        const dueDate =
          d.dueDate ??
          (d.intervalValue != null
            ? addInterval(
                this.todayIso(),
                d.intervalValue,
                d.intervalUnit ?? 'months',
              )
            : null);
        return {
          task: d.task.trim().slice(0, 200),
          category: this.normCategory(d.category),
          planning: planned,
          description: d.description ?? null,
          responsibleRole: d.responsibleRole?.slice(0, 80) ?? null,
          department: d.department ?? null,
          sfiGroup: d.sfiGroup ?? null,
          priority: 'medium',
          dueDate,
          repeatDate: d.intervalValue != null,
          intervalValue: d.intervalValue ?? null,
          intervalUnit: d.intervalUnit ?? 'months',
          intervalHours: d.intervalHours ?? null,
          // Baseline so "every N hours" starts counting from today's hours.
          startHours: d.intervalHours != null ? assetHours : null,
          lastDoneAt: d.lastDoneAt ?? null,
          assetIds: d.assetMatch ? [d.assetMatch.id] : [],
          source: 'import',
        };
      });
    const created = await this.pmsService.createMany(shipId, inputs);
    return { created };
  }

  /**
   * Persist history drafts as COMPLETED records (they land in the History tab).
   * Each is a one-off with completedAt + the hour-counter reading; no schedule.
   */
  private async commitHistory(
    shipId: string,
    drafts: PmsImportDraft[],
  ): Promise<{ created: number }> {
    const inputs: UpsertPmsTaskInput[] = drafts
      .filter((d) => d.task?.trim())
      .map((d) => ({
        task: d.task.trim().slice(0, 200),
        category: this.normCategory(d.category),
        planning: 'unplanned',
        description: d.description ?? null,
        responsibleRole: d.responsibleRole?.slice(0, 80) ?? null,
        department: d.department ?? null,
        sfiGroup: d.sfiGroup ?? null,
        priority: 'medium',
        dueDate: null,
        repeatDate: false,
        intervalValue: null,
        intervalHours: null,
        lastDoneAt: d.completedAt ?? d.lastDoneAt ?? null,
        lastDoneHours: d.lastDoneHours ?? null,
        completedAt: d.completedAt ?? d.lastDoneAt ?? null,
        completedByName: d.completedByName ?? null,
        assetIds: d.assetMatch ? [d.assetMatch.id] : [],
        source: 'import-history',
      }));
    const created = await this.pmsService.createMany(shipId, inputs);
    return { created };
  }

  // ── text extraction ──

  private async extractText(
    file: { buffer?: Buffer; originalname?: string; mimetype?: string } | null,
  ): Promise<string> {
    if (!file?.buffer) {
      throw new BadRequestException('No file provided.');
    }
    const name = (file.originalname ?? '').toLowerCase();
    const mime = file.mimetype ?? '';
    try {
      if (mime.includes('pdf') || name.endsWith('.pdf')) {
        const parsed = await pdfParse(file.buffer);
        return parsed.text ?? '';
      }
      if (
        mime.includes('sheet') ||
        mime.includes('excel') ||
        name.endsWith('.xlsx') ||
        name.endsWith('.xls')
      ) {
        const wb = XLSX.read(file.buffer, { type: 'buffer' });
        // Flatten every sheet to CSV so the LLM sees all tabs.
        return wb.SheetNames.map((sheet) => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet]);
          return `# Sheet: ${sheet}\n${csv}`;
        }).join('\n\n');
      }
      // csv / tsv / txt
      return file.buffer.toString('utf8');
    } catch (error) {
      this.logger.warn(
        `extractText failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new BadRequestException(
        'Could not read the file. Supported: PDF, XLSX, CSV, or plain text.',
      );
    }
  }

  private chunk(text: string): string[] {
    if (text.length <= CHUNK_CHARS) return [text];
    const lines = text.split('\n');
    const chunks: string[] = [];
    let buf = '';
    for (const line of lines) {
      if (buf.length + line.length + 1 > CHUNK_CHARS && buf) {
        chunks.push(buf);
        buf = '';
      }
      buf += line + '\n';
    }
    if (buf.trim()) chunks.push(buf);
    return chunks;
  }

  // ── LLM mapping ──

  private async mapChunk(
    chunk: string,
    mode: PmsImportMode = 'tasks',
    attempt = 0,
  ): Promise<LlmTask[] | null> {
    const systemPrompt =
      mode === 'history' ? MAP_HISTORY_SYSTEM_PROMPT : MAP_SYSTEM_PROMPT;
    const schemaHint = mode === 'history' ? HISTORY_SCHEMA_HINT : SCHEMA_HINT;
    const userPrompt = `Maintenance source data:\n"""\n${chunk}\n"""`;
    // Prefer Claude (fast, high throughput); fall back to the OpenAI sub-model.
    const result = this.llmService.isAnthropicConfigured()
      ? await this.llmService.createAnthropicJsonCompletion<{
          tasks?: LlmTask[];
        }>({
          model: MAP_MODEL,
          systemPrompt: `${systemPrompt}\n${schemaHint}`,
          userPrompt,
          maxTokens: 8000,
        })
      : await this.llmService.createJsonChatCompletion<{
          tasks?: LlmTask[];
        }>({
          systemPrompt,
          userPrompt,
          temperature: 0.1,
          maxTokens: 4000,
          schemaHint,
        });
    if (!result || !Array.isArray(result.tasks)) {
      // Retry a couple of times — a transient null (rate limit / occasional
      // malformed JSON) shouldn't silently drop a whole batch of tasks.
      if (attempt < 2) return this.mapChunk(chunk, mode, attempt + 1);
      return null;
    }
    return result.tasks;
  }

  private toDraft(
    t: LlmTask,
    assets: AssetEntity[],
    mode: PmsImportMode = 'tasks',
  ): PmsImportDraft | null {
    const task = (t.task ?? '').trim();
    if (!task) return null;
    const match = this.matchAsset(t.asset, assets);
    const responsibleRole = (t.performed_by ?? t.responsible)?.trim() || null;

    if (mode === 'history') {
      // A performed-maintenance record → a COMPLETED entry (History tab).
      const completedAt = this.normDate(t.completed_date ?? t.last_done);
      const lastDoneHours = this.toNum(t.hour_counter);
      const descParts = [
        t.description?.trim(),
        t.spares?.trim() ? `Spares: ${t.spares.trim()}` : null,
        responsibleRole ? `By: ${responsibleRole}` : null,
      ].filter(Boolean);
      return {
        task: task.slice(0, 200),
        category: this.normCategory(t.category),
        planning: 'unplanned',
        description: descParts.join(' · ') || null,
        responsibleRole,
        department: departmentForRole(responsibleRole),
        sfiGroup: t.sfi_group?.toString().trim() || null,
        intervalValue: null,
        intervalUnit: null,
        intervalHours: null,
        dueDate: null,
        lastDoneAt: completedAt,
        completedAt,
        lastDoneHours,
        completedByName: t.performed_by?.trim() || null,
        assetHint: t.asset?.trim() || null,
        assetMatch: match,
        confidence: task.length >= 4 && completedAt ? 'high' : 'low',
      };
    }

    const intervalHours = this.toNum(t.interval_hours);
    const intervalValue = this.toNum(t.interval_value);
    return {
      task: task.slice(0, 200),
      category: this.normCategory(t.category),
      planning:
        intervalValue != null || intervalHours != null ? 'planned' : 'planned',
      description: t.description?.trim() || null,
      responsibleRole,
      department: departmentForRole(responsibleRole),
      sfiGroup: t.sfi_group?.toString().trim() || null,
      intervalValue,
      intervalUnit: this.normUnit(t.interval_unit),
      intervalHours,
      dueDate: this.normDate(t.due_date),
      lastDoneAt: this.normDate(t.last_done),
      assetHint: t.asset?.trim() || null,
      assetMatch: match,
      confidence:
        task.length >= 4 && (intervalValue != null || intervalHours != null)
          ? 'high'
          : 'low',
    };
  }

  // ── normalizers / matching ──

  private matchAsset(
    hint: string | null | undefined,
    assets: AssetEntity[],
  ): { id: string; name: string; matchType: string } | null {
    const q = (hint ?? '').trim().toLowerCase();
    if (!q) return null;
    // exact display name
    let a = assets.find((x) => x.displayName?.toLowerCase() === q);
    if (a) return { id: a.id, name: a.displayName, matchType: 'exact' };
    // contains either way
    a = assets.find(
      (x) =>
        x.displayName &&
        (x.displayName.toLowerCase().includes(q) ||
          q.includes(x.displayName.toLowerCase())),
    );
    if (a) return { id: a.id, name: a.displayName, matchType: 'partial' };
    // brand/model token overlap
    a = assets.find((x) =>
      [x.brand, x.model]
        .filter(Boolean)
        .some((v) => q.includes((v as string).toLowerCase())),
    );
    if (a) return { id: a.id, name: a.displayName, matchType: 'brand-model' };
    return null;
  }

  private normCategory(raw?: string | null): string {
    const v = (raw ?? '').trim().toLowerCase();
    return CATEGORIES.find((c) => c.toLowerCase() === v) ?? 'Service';
  }

  private normUnit(raw?: string | null): string {
    const v = (raw ?? '').trim().toLowerCase();
    const units = ['days', 'weeks', 'months', 'years'];
    return units.find((u) => u === v || u.slice(0, -1) === v) ?? 'months';
  }

  private normDate(raw?: string | null): string | null {
    const v = (raw ?? '').trim();
    if (!v) return null;
    const iso = /^\d{4}-\d{2}-\d{2}/.exec(v);
    if (iso) return iso[0];
    const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(v);
    if (dmy) {
      const [, d, m, y] = dmy;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return null;
  }

  private toNum(raw: number | string | null | undefined): number | null {
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  private todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

}

const SCHEMA_HINT =
  '{ "tasks": [ { "task": string, "category": string, "responsible": string, ' +
  '"interval_hours": number|null, "interval_value": number|null, ' +
  '"interval_unit": "days"|"weeks"|"months"|"years"|null, "due_date": string|null, ' +
  '"last_done": string|null, "description": string|null, "asset": string|null, ' +
  '"sfi_group": string|null } ] }';

const HISTORY_SCHEMA_HINT =
  '{ "tasks": [ { "task": string, "category": string, "asset": string|null, ' +
  '"completed_date": string|null, "hour_counter": number|null, ' +
  '"performed_by": string|null, "spares": string|null, ' +
  '"description": string|null, "sfi_group": string|null } ] }';

const MAP_HISTORY_SYSTEM_PROMPT = `You convert a vessel's MAINTENANCE HISTORY (a log of work that has ALREADY been performed — in ANY layout) into a single normalized JSON shape. Each record is one completed maintenance action.

Return ONLY JSON: { "tasks": [ ... ] }. One object per performed record. Fields:
- task (required): the maintenance action that was done, concise (e.g. "Replace 5 micron cartridge filters", "Overhaul pump"). Do not include the equipment name or date inside task.
- category: one of Inspection, Service, Replacement, Overhaul, Lubrication, Test, Cleaning, Calibration, Survey, Repair, Other.
- asset: the equipment/component name exactly as written (e.g. "WATERMAKER 2", "Port Generator"), else null.
- completed_date: the date the work was performed (the record's Date / performed / approved-at), ISO YYYY-MM-DD, else null.
- hour_counter: the running-hours reading at completion as a number, else null.
- performed_by: who performed/approved it, else null.
- spares: the used spares/parts as a short text (name + qty), else null.
- description: the record's notes / instructions text, else null.
- sfi_group: an SFI group or Reference ID if present, else null.

Rules: one object per PERFORMED record (there may be many per component, one per date). Do NOT invent dates or hours. Omit header/section rows. Output valid JSON only, no prose.`;

const MAP_SYSTEM_PROMPT = `You convert a vessel's planned-maintenance (PMS) records — in ANY layout (tables, lists, exports) — into a single normalized JSON shape.

Every PMS row, whatever its format, reduces to: WHAT to do (task), the INTERVAL, WHO does it, and on WHICH equipment.

Return ONLY JSON: { "tasks": [ ... ] }. One object per maintenance task. Fields:
- task (required): the action, concise (e.g. "Replace fuel filters", "Inspect anodes"). Do NOT include the interval or asset name inside task.
- category: one of Inspection, Service, Replacement, Overhaul, Lubrication, Test, Cleaning, Calibration, Survey, Repair, Other. Infer from the action verb.
- responsible: the rank/role/person who performs it, if stated (e.g. "Chief Engineer", "2nd Engineer", "Deck"). Else null.
- interval_hours: running-hours interval as a number, if the interval is in hours (e.g. "every 250h" -> 250). Else null.
- interval_value + interval_unit: calendar interval, e.g. "Annually" -> value 1 unit "years"; "Every 3 months" -> 3 "months"; "Weekly" -> 1 "weeks"; "Quarterly" -> 3 "months"; "Biennial" -> 2 "years". If interval is in hours only, leave these null.
- due_date / last_done: ISO date if a concrete date is present (last done or next due). Else null.
- description: extra detail/notes, else null.
- asset: the equipment/component name exactly as written in the source (e.g. "Port Generator", "Main Engine"), else null.
- sfi_group: an SFI group code if present, else null.

Rules: omit header/section/total rows that are not tasks. Do not invent intervals — if none is stated, leave both interval fields null. Keep task titles short; move detail into description. Output valid JSON only, no prose.`;

// Schedule/interval signals — deliberately NOT generic verbs (check/test/…)
// which appear all over a manual; the interval requirement does the rest.
const MAINTENANCE_SIGNAL =
  /maintenance schedule|service interval|service schedule|periodic|maintenance interval|every\s*\d|after\s*\d+\s*h|running hours|\b\d+\s*h(?:rs?|ours?)?\b|\b(annual|monthly|weekly|daily|yearly|biennial|quarterly)\b|replace|renew|overhaul|lubricat|grease/i;

const SUGGEST_SYSTEM_PROMPT = `You are a marine engineer reading an equipment MANUAL excerpt. Extract ONLY the manufacturer's PLANNED / PERIODIC MAINTENANCE tasks — the entries from a maintenance schedule, service-interval table, or periodic-maintenance list.

STRICT RULES:
- ONLY extract tasks that come from a maintenance schedule with a STATED INTERVAL (hours or calendar). Strongly prefer tasks that have an interval.
- IGNORE everything else: operating instructions, start/stop procedures, specifications, wiring, troubleshooting, safety warnings, parts catalogues, general descriptions.
- If this excerpt contains NO maintenance schedule, return exactly { "tasks": [] }.
- Do NOT invent tasks or intervals. No duplicates.

Return ONLY JSON: { "tasks": [ ... ] }. One object per task. Fields:
- task (required): the maintenance action, concise (e.g. "Replace fuel filter", "Renew impeller", "Check valve clearances"). No interval or equipment name inside task.
- category: one of Inspection, Service, Replacement, Overhaul, Lubrication, Test, Cleaning, Calibration, Survey, Repair, Other.
- responsible: rank/role if implied, else null.
- interval_hours: running-hours interval as a number ("every 500 hours" -> 500), else null.
- interval_value + interval_unit: calendar interval ("annually" -> 1 "years"; "every 6 months" -> 6 "months"), else null.
- DUAL INTERVALS: many schedules state BOTH, e.g. "Monthly or 50 Hrs", "6 Months or 250 Hrs", "Yearly or 500 Hrs". For these, fill BOTH interval_value/interval_unit AND interval_hours (e.g. 6 "months" AND 250). Whichever comes first will trigger the task.
- due_date / last_done: null.
- description: the manufacturer's note / spec / part number for this task, else null.
- asset: null. sfi_group: null.

Output valid JSON only, no prose.`;
