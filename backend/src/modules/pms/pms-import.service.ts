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
import { AssetsService } from '../assets/assets.service';
import { InventoryService } from '../inventory/inventory.service';
import { LlmService } from '../../integrations/llm/llm.service';
import { PmsService, UpsertPmsTaskInput } from './pms.service';
import { AssetHoursService } from './asset-hours.service';
import { addInterval } from './date-interval.util';
import { departmentForRole } from '../crew/crew-ranks';

/** A spare part extracted from a task's embedded parts table. */
export interface PmsImportPartDraft {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  manufacturerNo?: string | null;
  supplierNo?: string | null;
}

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
  // the system/group the equipment belongs to, when the source distinguishes it
  assetGroup?: string | null;
  // resolved against the ship's asset register
  assetMatch?: { id: string; name: string; matchType: string } | null;
  // no register match → commit may create the asset (user can veto per row)
  createAsset?: boolean;
  // spare parts pulled out of the description's embedded table
  parts?: PmsImportPartDraft[];
  confidence?: 'high' | 'low';
}

export interface PmsImportPreview {
  drafts: PmsImportDraft[];
  counts: {
    total: number;
    matchedAssets: number;
    lowConfidence: number;
    willCreateAssets: number;
    partsTotal: number;
  };
  sourceChars: number;
  notes: string[];
}

export interface PmsImportCommitResult {
  created: number;
  assetsCreated: number;
  partsCreated: number;
  partsLinked: number;
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

interface LlmPart {
  name?: string;
  quantity?: number | string | null;
  unit?: string | null;
  location?: string | null;
  manufacturer_no?: string | null;
  supplier_no?: string | null;
}

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
  asset_group?: string | null;
  sfi_group?: string | null;
  parts?: LlmPart[] | null;
  // history mode
  completed_date?: string | null;
  hour_counter?: number | string | null;
  performed_by?: string | null;
  spares?: string | null;
}

/** How commit should treat drafts without a register match. */
export interface PmsImportCommitOptions {
  createMissingAssets?: boolean;
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
    private readonly assetsService: AssetsService,
    private readonly inventoryService: InventoryService,
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
      .map((t) => this.toDraft(t, mode))
      .filter((d): d is PmsImportDraft => d != null);

    // Resolve every distinct equipment name against the register: fuzzy token
    // scoring first, an LLM disambiguation pass for the uncertain middle, and
    // createAsset=true for anything the register genuinely doesn't have.
    await this.resolveAssetMatches(drafts, assets, notes);

    return {
      drafts,
      counts: this.buildCounts(drafts),
      sourceChars: text.length,
      notes,
    };
  }

  private buildCounts(drafts: PmsImportDraft[]): PmsImportPreview['counts'] {
    return {
      total: drafts.length,
      matchedAssets: drafts.filter((d) => d.assetMatch).length,
      lowConfidence: drafts.filter((d) => d.confidence === 'low').length,
      willCreateAssets: new Set(
        drafts
          .filter((d) => !d.assetMatch && d.createAsset && d.assetHint)
          .map((d) => this.normalizeAssetKey(d.assetHint as string)),
      ).size,
      partsTotal: drafts.reduce((n, d) => n + (d.parts?.length ?? 0), 0),
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
      .map((t) => this.toDraft(t))
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
        ...this.buildCounts(drafts),
        matchedAssets: drafts.length,
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

  /** Persist confirmed drafts as real PMS tasks (+ assets + spare parts). */
  async commit(
    shipId: string,
    drafts: PmsImportDraft[],
    mode: PmsImportMode = 'tasks',
    opts: PmsImportCommitOptions = {},
  ): Promise<PmsImportCommitResult> {
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new BadRequestException('No tasks to import.');
    }
    if (mode === 'history') {
      const { created } = await this.commitHistory(shipId, drafts);
      return { created, assetsCreated: 0, partsCreated: 0, partsLinked: 0 };
    }

    // 1) Create register assets for unmatched equipment (opt-in), so the
    //    tasks below can link to them. One asset per distinct name.
    const assetsCreated = opts.createMissingAssets
      ? await this.createMissingAssets(shipId, drafts)
      : 0;

    // 2) Anchor each hours-interval task to its asset's CURRENT running hours,
    //    so the hours countdown has a baseline from the moment it's imported.
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

    // 3) Create tasks ONE BY ONE (we need each task's id to link its spare
    //    parts). Mirrors createMany semantics: a bad row is skipped, logged,
    //    and never aborts the batch.
    let created = 0;
    const taskIdByDraft = new Map<PmsImportDraft, string>();
    for (const d of drafts) {
      if (!d.task?.trim()) continue;
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
      const input: UpsertPmsTaskInput = {
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
      try {
        const saved = await this.pmsService.create(shipId, input);
        if (saved?.id) taskIdByDraft.set(d, saved.id);
        created++;
      } catch (error) {
        this.logger.warn(
          `Skipped import task "${input.task}": ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    // 4) Spare parts → inventory items linked to their tasks and assets.
    const { partsCreated, partsLinked } = await this.upsertParts(
      shipId,
      drafts,
      taskIdByDraft,
    );

    return { created, assetsCreated, partsCreated, partsLinked };
  }

  /**
   * Create one register asset per distinct unmatched equipment name (drafts
   * flagged createAsset). Created assets live under the pseudo-SFI sub "PMS"
   * so they're easy to review/re-house later; the source system goes to notes.
   */
  private async createMissingAssets(
    shipId: string,
    drafts: PmsImportDraft[],
  ): Promise<number> {
    const pending = drafts.filter(
      (d) => !d.assetMatch && d.createAsset && d.assetHint,
    );
    if (pending.length === 0) return 0;

    const byName = new Map<string, PmsImportDraft[]>();
    for (const d of pending) {
      const key = this.normalizeAssetKey(d.assetHint as string);
      const arr = byName.get(key) ?? [];
      arr.push(d);
      byName.set(key, arr);
    }

    let createdCount = 0;
    for (const group of byName.values()) {
      const sample = group[0];
      const displayName = (sample.assetHint as string).slice(0, 255);
      try {
        const { assetIdInternal } = await this.assetsService.nextAssetId(
          shipId,
          'PMS',
        );
        if (!assetIdInternal) {
          this.logger.warn(
            `Could not derive an asset id prefix for ship ${shipId}; skipping asset "${displayName}".`,
          );
          continue;
        }
        const asset = await this.assetsService.create(shipId, {
          assetIdInternal,
          displayName,
          sfiSub: 'PMS',
          sfiSubName: 'PMS import',
          notes: sample.assetGroup
            ? `Created by PMS import (system: ${sample.assetGroup})`
            : 'Created by PMS import',
        });
        createdCount++;
        const match = {
          id: asset.id,
          name: asset.displayName,
          matchType: 'created',
        };
        for (const d of group) d.assetMatch = match;
      } catch (error) {
        this.logger.warn(
          `Could not create asset "${displayName}": ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return createdCount;
  }

  /**
   * Upsert extracted spare parts into the ship's inventory. Parts are
   * de-duplicated across the whole import by part number (else normalized
   * name); an existing inventory item just gains the new task/asset links.
   */
  private async upsertParts(
    shipId: string,
    drafts: PmsImportDraft[],
    taskIdByDraft: Map<PmsImportDraft, string>,
  ): Promise<{ partsCreated: number; partsLinked: number }> {
    type Agg = {
      part: PmsImportPartDraft;
      taskIds: Set<string>;
      assetIds: Set<string>;
    };
    const byKey = new Map<string, Agg>();
    for (const d of drafts) {
      if (!d.parts?.length) continue;
      const taskId = taskIdByDraft.get(d);
      for (const p of d.parts) {
        const key = (
          p.manufacturerNo?.toLowerCase() || this.normalizeAssetKey(p.name)
        ).trim();
        if (!key) continue;
        const agg = byKey.get(key) ?? {
          part: p,
          taskIds: new Set<string>(),
          assetIds: new Set<string>(),
        };
        if (taskId) agg.taskIds.add(taskId);
        if (d.assetMatch) agg.assetIds.add(d.assetMatch.id);
        byKey.set(key, agg);
      }
    }
    if (byKey.size === 0) return { partsCreated: 0, partsLinked: 0 };

    // Existing stock: match by part number first, then by normalized name.
    const existing = await this.inventoryService.list(shipId);
    const byPartNo = new Map<string, (typeof existing)[number]>();
    const byName = new Map<string, (typeof existing)[number]>();
    for (const item of existing) {
      if (item.partNumber) byPartNo.set(item.partNumber.toLowerCase(), item);
      byName.set(this.normalizeAssetKey(item.name), item);
    }

    let partsCreated = 0;
    let partsLinked = 0;
    for (const agg of byKey.values()) {
      const { part } = agg;
      const found =
        (part.manufacturerNo &&
          byPartNo.get(part.manufacturerNo.toLowerCase())) ||
        byName.get(this.normalizeAssetKey(part.name));
      try {
        if (found) {
          // Only ADD links — never overwrite stock qty/location of real items.
          const taskIds = [...new Set([...found.taskIds, ...agg.taskIds])];
          const assetIds = [...new Set([...found.assetIds, ...agg.assetIds])];
          await this.inventoryService.update(shipId, found.id, {
            taskIds,
            assetIds,
          });
          partsLinked += agg.taskIds.size;
        } else {
          await this.inventoryService.create(shipId, {
            name: part.name,
            category: 'part',
            partNumber: part.manufacturerNo ?? null,
            location: part.location ?? null,
            quantity: part.quantity ?? null,
            unit: part.unit ?? null,
            notes: part.supplierNo ? `Supplier part#: ${part.supplierNo}` : null,
            assetIds: [...agg.assetIds],
            taskIds: [...agg.taskIds],
          });
          partsCreated++;
          partsLinked += agg.taskIds.size;
        }
      } catch (error) {
        this.logger.warn(
          `Could not upsert part "${part.name}": ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return { partsCreated, partsLinked };
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
    mode: PmsImportMode = 'tasks',
  ): PmsImportDraft | null {
    let task = (t.task ?? '').trim();
    if (!task) return null;
    task = this.titleCaseSmart(task);

    // Defense-in-depth against a common export pathology the LLM may miss:
    // an interval ("5 Years", "1 Years / 500") sitting in the responsible
    // column. Never accept it as a person; recover the interval if absent.
    const rawResponsible = (t.performed_by ?? t.responsible)?.trim() || null;
    const repaired = this.repairResponsible(rawResponsible);
    const responsibleRole = repaired.role;

    const assetHint = this.cleanAssetName(t.asset);
    const assetGroup = this.cleanAssetName(t.asset_group);
    const parts = this.toPartDrafts(t.parts);

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
        assetHint,
        assetGroup,
        assetMatch: null,
        parts,
        confidence: task.length >= 4 && completedAt ? 'high' : 'low',
      };
    }

    const intervalHours = this.toNum(t.interval_hours) ?? repaired.intervalHours;
    const intervalValue = this.toNum(t.interval_value) ?? repaired.intervalValue;
    const intervalUnit =
      t.interval_unit != null || repaired.intervalUnit == null
        ? this.normUnit(t.interval_unit)
        : repaired.intervalUnit;
    return {
      task: task.slice(0, 200),
      category: this.normCategory(t.category),
      planning: 'planned',
      description: t.description?.trim() || null,
      responsibleRole,
      department: departmentForRole(responsibleRole),
      sfiGroup: t.sfi_group?.toString().trim() || null,
      intervalValue,
      intervalUnit,
      intervalHours,
      dueDate: this.normDate(t.due_date),
      lastDoneAt: this.normDate(t.last_done),
      assetHint,
      assetGroup,
      assetMatch: null,
      parts,
      confidence:
        task.length >= 4 && (intervalValue != null || intervalHours != null)
          ? 'high'
          : 'low',
    };
  }

  private toPartDrafts(raw: LlmPart[] | null | undefined): PmsImportPartDraft[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const parts = raw
      .map((p): PmsImportPartDraft | null => {
        const name = (p.name ?? '').trim();
        if (!name) return null;
        return {
          name: this.titleCaseSmart(name).slice(0, 200),
          quantity: this.toNum(p.quantity),
          unit: this.normPartUnit(p.unit),
          location: p.location?.trim().slice(0, 160) || null,
          manufacturerNo: p.manufacturer_no?.trim().slice(0, 120) || null,
          supplierNo: p.supplier_no?.trim().slice(0, 120) || null,
        };
      })
      .filter((p): p is PmsImportPartDraft => p != null);
    return parts.length ? parts : undefined;
  }

  // ── deterministic repairs ──

  /**
   * A "responsible" cell that actually holds an interval ("5 Years",
   * "3 Months", "1 Years / 500", "8 Weeks") or junk ("EUR") is an export
   * column shift — recover the interval, never a person.
   */
  private repairResponsible(raw: string | null): {
    role: string | null;
    intervalValue: number | null;
    intervalUnit: string | null;
    intervalHours: number | null;
  } {
    const none = {
      role: null,
      intervalValue: null,
      intervalUnit: null,
      intervalHours: null,
    };
    const v = (raw ?? '').trim();
    if (!v) return none;
    const m = /^(\d+)\s*(years?|months?|weeks?|days?)(?:\s*\/\s*(\d+))?$/i.exec(v);
    if (m) {
      const unit = m[2].toLowerCase().replace(/s?$/, 's');
      return {
        role: null,
        intervalValue: parseInt(m[1], 10),
        intervalUnit: unit,
        intervalHours: m[3] ? parseInt(m[3], 10) : null,
      };
    }
    // Junk guards: currency codes, lone numbers — not people.
    if (/^[A-Z]{3}$/.test(v) || /^\d+$/.test(v)) return none;
    return { ...none, role: v };
  }

  /** Strip export artifacts from an equipment name; null out pure fragments. */
  private cleanAssetName(raw: string | null | undefined): string | null {
    let v = (raw ?? '').trim();
    if (!v) return null;
    v = v.replace(/^-?\s*Care\b[\s:-]*/i, '').trim(); // report prefix "- Care "
    v = v.replace(/\s+/g, ' ');
    // Report footers / pure fragments are not equipment.
    if (/^approved by:?$/i.test(v)) return null;
    if (/^[)\]]/.test(v)) return null; // "ER)", "(2 PCS)" tails
    if (v.length < 3) return null;
    return this.titleCaseSmart(v).slice(0, 255);
  }

  /**
   * Sentence-case a SHOUTY string while preserving marine/technical tokens
   * (PS, SB, ER, DPF…), codes with digits (EL-11, ACB531) and short unit
   * suffixes. Applied only when the source is (nearly) all-caps.
   */
  private titleCaseSmart(input: string): string {
    const s = input.trim().replace(/\s+/g, ' ');
    if (!s) return s;
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (!letters || letters.toUpperCase() !== letters) return s; // not shouty
    const words = s.split(' ');
    const out = words.map((w, i) => {
      const bare = w.replace(/[^A-Za-z0-9-]/g, '');
      if (MARINE_ABBR.has(bare.toUpperCase())) return w.toUpperCase();
      if (/\d/.test(bare)) return w; // codes like EL-11, ACB531, 6S
      if (/^[A-Z]{1,2}$/.test(bare) && i > 0) return w; // short initials mid-title
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    });
    return out.join(' ');
  }

  private normalizeAssetKey(name: string): string {
    return name
      .toLowerCase()
      .replace(/[\\/;()#,._–-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── register matching (fuzzy scoring + LLM disambiguation) ──

  /** Tokens for fuzzy matching: normalized, synonym-folded, lightly stemmed. */
  private matchTokens(name: string): Set<string> {
    const words = this.normalizeAssetKey(name).split(' ');
    const out = new Set<string>();
    for (const w of words) {
      if (!w) continue;
      const syn = TOKEN_SYNONYMS[w];
      if (syn === '') continue; // dropped filler ("no", "nr")
      let tok = syn ?? w;
      if (tok.length > 3 && tok.endsWith('s')) tok = tok.slice(0, -1);
      out.add(tok);
    }
    return out;
  }

  private scoreTokenSets(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    const jaccard = inter / union;
    const containment = inter / Math.min(a.size, b.size);
    return Math.max(jaccard, containment * 0.9);
  }

  /**
   * Resolve every draft's assetHint against the register.
   * Tier 1: deterministic fuzzy token score (high ⇒ auto-link).
   * Tier 2: LLM picks among the top candidates for the uncertain middle.
   * Unresolved hints get createAsset=true (commit may create them).
   */
  private async resolveAssetMatches(
    drafts: PmsImportDraft[],
    assets: AssetEntity[],
    notes: string[],
  ): Promise<void> {
    const indexed = assets
      .filter((a) => a.displayName)
      .map((a) => ({ a, tokens: this.matchTokens(a.displayName) }));

    // Distinct hints — score once, apply to every draft sharing the hint.
    const byHint = new Map<string, PmsImportDraft[]>();
    for (const d of drafts) {
      if (!d.assetHint) continue;
      const key = this.normalizeAssetKey(
        `${d.assetHint} ${d.assetGroup ?? ''}`,
      );
      const arr = byHint.get(key) ?? [];
      arr.push(d);
      byHint.set(key, arr);
    }

    type Pending = {
      key: string;
      hint: string;
      group: string | null;
      candidates: { id: string; name: string; score: number }[];
    };
    const uncertain: Pending[] = [];

    for (const [key, group] of byHint) {
      const sample = group[0];
      const hintTokens = this.matchTokens(sample.assetHint as string);
      const withGroupTokens = sample.assetGroup
        ? this.matchTokens(`${sample.assetHint} ${sample.assetGroup}`)
        : hintTokens;

      const scored = indexed
        .map(({ a, tokens }) => ({
          id: a.id,
          name: a.displayName,
          score: Math.max(
            this.scoreTokenSets(hintTokens, tokens),
            this.scoreTokenSets(withGroupTokens, tokens),
          ),
        }))
        .sort((x, y) => y.score - x.score)
        .slice(0, 6);

      const best = scored[0];
      if (best && best.score >= 0.72) {
        const match = { id: best.id, name: best.name, matchType: 'fuzzy' };
        for (const d of group) d.assetMatch = match;
      } else if (best && best.score >= 0.4) {
        uncertain.push({
          key,
          hint: sample.assetHint as string,
          group: sample.assetGroup ?? null,
          candidates: scored.filter((c) => c.score >= 0.3),
        });
      } else {
        for (const d of group) d.createAsset = true;
      }
    }

    // Tier 2 — LLM decides the uncertain middle in batches.
    if (uncertain.length > 0 && this.llmService.isConfigured()) {
      const BATCH = 25;
      let resolvedByAi = 0;
      for (let i = 0; i < uncertain.length; i += BATCH) {
        const batch = uncertain.slice(i, i + BATCH);
        const answers = await this.disambiguateBatch(batch);
        for (const item of batch) {
          const pick = answers?.get(item.key);
          const drafts_ = byHint.get(item.key) ?? [];
          if (pick != null && item.candidates[pick]) {
            const c = item.candidates[pick];
            const match = { id: c.id, name: c.name, matchType: 'ai' };
            for (const d of drafts_) d.assetMatch = match;
            resolvedByAi++;
          } else {
            for (const d of drafts_) d.createAsset = true;
          }
        }
      }
      if (resolvedByAi > 0) {
        notes.push(`AI matched ${resolvedByAi} ambiguous equipment names to the register.`);
      }
    } else {
      for (const item of uncertain) {
        for (const d of byHint.get(item.key) ?? []) d.createAsset = true;
      }
    }
  }

  /** Ask the LLM which register candidate (if any) IS the named equipment. */
  private async disambiguateBatch(
    batch: {
      key: string;
      hint: string;
      group: string | null;
      candidates: { id: string; name: string; score: number }[];
    }[],
  ): Promise<Map<string, number | null> | null> {
    const items = batch.map((b, i) => ({
      i,
      name: b.hint,
      system: b.group,
      candidates: b.candidates.map((c, k) => ({ k, name: c.name })),
    }));
    const userPrompt = `Items:\n${JSON.stringify(items, null, 1)}`;
    const result = this.llmService.isAnthropicConfigured()
      ? await this.llmService.createAnthropicJsonCompletion<{
          matches?: { i: number; k: number }[];
        }>({
          model: MAP_MODEL,
          systemPrompt: `${DISAMBIGUATE_PROMPT}\n${DISAMBIGUATE_SCHEMA_HINT}`,
          userPrompt,
          maxTokens: 2000,
        })
      : await this.llmService.createJsonChatCompletion<{
          matches?: { i: number; k: number }[];
        }>({
          systemPrompt: DISAMBIGUATE_PROMPT,
          userPrompt,
          temperature: 0,
          maxTokens: 2000,
          schemaHint: DISAMBIGUATE_SCHEMA_HINT,
        });
    if (!result || !Array.isArray(result.matches)) return null;
    const map = new Map<string, number | null>();
    for (const b of batch) map.set(b.key, null);
    for (const m of result.matches) {
      const b = batch[m.i];
      if (b && Number.isInteger(m.k) && m.k >= 0) map.set(b.key, m.k);
    }
    return map;
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

  /** Normalize a part's unit onto the inventory unit vocabulary. */
  private normPartUnit(raw?: string | null): string | null {
    const v = (raw ?? '').trim().toLowerCase();
    if (!v) return null;
    const map: Record<string, string> = {
      pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', ea: 'pcs',
      set: 'set', sets: 'set', kit: 'kit', kits: 'kit', pair: 'pair',
      box: 'box', boxes: 'box', roll: 'roll',
      l: 'L', lt: 'L', ltr: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L',
      ml: 'ml', kg: 'kg', g: 'g', m: 'm', cm: 'cm',
    };
    return map[v] ?? null;
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

// Marine / technical tokens that must stay uppercase when un-shouting text.
const MARINE_ABBR = new Set([
  'PS', 'SB', 'STBD', 'ER', 'FW', 'SW', 'LO', 'FO', 'BA', 'AC', 'DC', 'DG',
  'DPF', 'OWS', 'OMD', 'UV', 'AHU', 'UTA', 'HVAC', 'CCTV', 'VHF', 'GPS',
  'AIS', 'ECDIS', 'GMDSS', 'EPIRB', 'SART', 'LRIT', 'MOB', 'RIB', 'ISM',
  'SOLAS', 'IMO', 'PMS', 'PTFE', 'LED', 'CO2', 'N2', 'EFP', 'EL', 'AMS',
  'SFI', 'WC', 'AV', 'IT', 'UPS', 'RPM', 'OEM',
]);

// Fuzzy-match token folding: side/position synonyms and dropped fillers.
const TOKEN_SYNONYMS: Record<string, string> = {
  sb: 'stbd', stb: 'stbd', starboard: 'stbd',
  ps: 'port', portside: 'port',
  fwd: 'fwd', forward: 'fwd',
  no: '', nr: '', num: '',
  genset: 'generator', gen: 'generator', dg: 'generator',
  emcy: 'emergency', em: 'emergency',
};

const SCHEMA_HINT =
  '{ "tasks": [ { "task": string, "category": string, "responsible": string|null, ' +
  '"interval_hours": number|null, "interval_value": number|null, ' +
  '"interval_unit": "days"|"weeks"|"months"|"years"|null, "due_date": string|null, ' +
  '"last_done": string|null, "description": string|null, "asset": string|null, ' +
  '"asset_group": string|null, "sfi_group": string|null, ' +
  '"parts": [ { "name": string, "quantity": number|null, "unit": string|null, ' +
  '"location": string|null, "manufacturer_no": string|null, "supplier_no": string|null } ]|null } ] }';

const DISAMBIGUATE_SCHEMA_HINT =
  '{ "matches": [ { "i": number, "k": number } ] } — k is the chosen candidate index, or -1 for none.';

const DISAMBIGUATE_PROMPT = `You match equipment names from a yacht's PMS export to the vessel's asset register. The export names are dirty (truncated, ALL-CAPS, abbreviated); the register names are clean but worded differently.

For each item pick the candidate that IS the same physical equipment, else -1.

Rules:
- PS = Port, SB/STBD = Starboard, ER = engine room, FW = fresh water, LO = lube oil, BA = breathing air.
- Side and number matter: a PORT pump is NOT a STARBOARD pump; pump 1 is NOT pump 2. If the item names a side/number and the only candidates are the other side/number, answer -1.
- A system/group is not its component: "Fuel treatment" system ≠ "Fuel purifier". Prefer the exact component.
- When the item is broader than every candidate (a whole system vs specific parts), answer -1.

Return ONLY JSON: { "matches": [ { "i": <item index>, "k": <candidate index or -1> } ] } — one entry per item, no prose.`;

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

REPAIR RULES: titles/descriptions may be ALL-CAPS — rewrite in sentence case, keeping marine abbreviations (PS, SB, ER, FW, LO, BA), codes and part numbers uppercase. Asset cells may be mangled: strip report prefixes like "- Care "; footers ("Approved by:") and lone fragments ("ER)", "(2 PCS)") are NOT equipment — set asset null unless the full name is recoverable from the pieces present. Never invent names, dates or hours.

Rules: one object per PERFORMED record (there may be many per component, one per date). Do NOT invent dates or hours. Omit header/section rows. Output valid JSON only, no prose.`;

const MAP_SYSTEM_PROMPT = `You convert a vessel's planned-maintenance (PMS) records — in ANY layout (tables, lists, CSV exports, PDFs) — into a single normalized JSON shape. PMS exports are often MANGLED: your job is to map AND repair.

Every PMS row, whatever its format, reduces to: WHAT to do (task), the INTERVAL, WHO does it, on WHICH equipment, and WITH WHICH spare parts.

Return ONLY JSON: { "tasks": [ ... ] }. One object per maintenance task. Fields:
- task (required): the action, concise (e.g. "Replace fuel filters", "Inspect anodes"). Do NOT include the interval or asset name inside task.
- category: one of Inspection, Service, Replacement, Overhaul, Lubrication, Test, Cleaning, Calibration, Survey, Repair, Other. Infer from the action verb.
- responsible: the rank/role/person who performs it, if stated (e.g. "Chief Engineer", "2nd Engineer", "Joseph Helm"). Else null.
- interval_hours: running-hours interval as a number ("every 250h" -> 250, "1 Years / 500" -> 500). Else null.
- interval_value + interval_unit: calendar interval, e.g. "Annually" -> 1 "years"; "Every 3 months" -> 3 "months"; "Weekly" -> 1 "weeks"; "Quarterly" -> 3 "months"; "Biennial" -> 2 "years". If interval is in hours only, leave these null.
- due_date / last_done: ISO date if a concrete date is present (last done or next due). Else null.
- description: the work instructions, else null.
- asset: the specific equipment/component the task is on (see repair rule 3), else null.
- asset_group: the system/group the equipment belongs to, when the source distinguishes one (e.g. "Bilge and fire pumps", "0331 Tenders"), else null.
- sfi_group: an SFI group code if present, else null.
- parts: spare parts for this task extracted from the row (see repair rule 4), else null.

REPAIR RULES — real export defects you MUST fix:
1. SHOUTY TEXT: titles/descriptions may be ALL-CAPS. Rewrite in normal sentence case ("REPLACE PUMP UNIT" -> "Replace pump unit"). KEEP uppercase: marine abbreviations (PS, SB, ER, FW, LO, BA, DPF, OWS, OMD, UV, AC), equipment codes (EL-11, ACB 531), part numbers, and proper brand casing (Volvo Penta, Westfalia).
2. MISPLACED INTERVALS: a "responsible" column sometimes holds an interval ("5 Years", "3 Months", "8 Weeks", "1 Years / 500"). That is the task's repeat interval, NOT a person — move it into interval_value/interval_unit (and a trailing "/ N" into interval_hours); responsible = null. Currency codes ("EUR") or lone numbers are never a responsible.
3. BROKEN EQUIPMENT NAMES: asset cells may arrive mangled:
   - Two pieces of ONE name split and REVERSED around ";" — "BOAT;0331 TENDERS \\ CHASE" is really "0331 TENDERS \\ CHASE BOAT" -> asset "Chase boat", asset_group "0331 Tenders". "FUEL PURIFIER;FUEL TREATMENT" -> asset "Fuel purifier", asset_group "Fuel treatment" (component;its-system).
   - Report artifacts are NOT equipment: strip "- Care " prefixes; "Approved by:", lone fragments like "ER)" or "(2 PCS)" -> asset null unless the full name is recoverable from the pieces present.
   - Reconstruct ONLY from pieces present in the row — never invent a name.
4. EMBEDDED SPARE-PARTS TABLES: a description may embed a parts table, typically after a header like "Spare Name Quantity Location Manufacturer Part# Supplier Part#". Pull EVERY row out into parts[]: name, quantity (number), unit ("20 Lt" -> quantity 20 unit "L"; plain count -> unit "pcs"), location (storage place, e.g. "Box 04 Pumps", "Bilge under beach club"), manufacturer_no (manufacturer part number), supplier_no (supplier part number). REMOVE the table text from description. Part names in sentence case, keep part-number casing.
5. RUN-ON CHECKLISTS: "1. DO X 2. DO Y 3.DO Z" -> one step per line in description: "1. Do x\\n2. Do y\\n3. Do z". Keep manufacturer references (Fig. 82, section numbers).

Rules: omit header/section/total rows that are not tasks. Do not invent intervals — if none is stated, leave all interval fields null. Keep task titles short; move detail into description. Output valid JSON only, no prose.`;

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
