import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';
import { InventoryItemEntity } from './entities/inventory-item.entity';
import { LlmService } from '../../integrations/llm/llm.service';

/** One reviewable stock line in the Trident inventory standard. */
export interface InventoryImportDraft {
  name: string;
  category: string;
  manufacturer?: string | null;
  partNumber?: string | null; // manufacturer part number — dedup key
  barcode?: string | null;
  model?: string | null;
  supplier?: string | null;
  supplPartNo?: string | null;
  quantity?: number | null;
  stockMin?: number | null;
  stockMax?: number | null;
  unit?: string | null;
  valueEur?: number | null;
  location?: string | null;
  assetGroup?: string | null;
  notes?: string | null;
  /** true when an existing item (same part#/name) will be UPDATED on commit. */
  existing?: boolean;
}

export interface InventoryImportPreview {
  drafts: InventoryImportDraft[];
  counts: {
    parsed: number;
    withPartNo: number;
    existing: number;
    groups: number;
  };
  notes: string[];
}

export interface InventoryImportCommitResult {
  created: number;
  updated: number;
}

interface UploadedImportFile {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
}

interface LlmInvItem {
  name?: string;
  manufacturer?: string | null;
  part_number?: string | null;
  barcode?: string | null;
  model?: string | null;
  supplier?: string | null;
  suppl_part_no?: string | null;
  quantity?: number | string | null;
  min?: number | string | null;
  max?: number | string | null;
  unit?: string | null;
  value_eur?: number | string | null;
  location?: string | null;
  asset_group?: string | null;
  category?: string | null;
  notes?: string | null;
}

const MAX_SOURCE = 400_000;
// Stock lines are dense (≈16 fields each), so a chunk's JSON is far larger
// than its input text. Keep chunks small enough that the mapped JSON fits
// inside MAP_MAX_TOKENS without truncating mid-array.
const CHUNK_CHARS = 3500;
const MAP_MAX_TOKENS = 12000;
const MAP_CONCURRENCY = 5;
const MAP_MODEL = 'claude-haiku-4-5';
const CATEGORIES = ['part', 'tool', 'fluid', 'consumable', 'other'];

@Injectable()
export class InventoryImportService {
  private readonly logger = new Logger(InventoryImportService.name);

  constructor(
    @InjectRepository(InventoryItemEntity)
    private readonly itemRepository: Repository<InventoryItemEntity>,
    private readonly llmService: LlmService,
  ) {}

  // ── preview ──

  async preview(
    shipId: string,
    file: UploadedImportFile | null,
    rawText?: string,
  ): Promise<InventoryImportPreview> {
    if (!this.llmService.isConfigured()) {
      throw new ServiceUnavailableException('AI is unavailable.');
    }
    const text = (rawText?.trim() || (await this.extractText(file))).slice(
      0,
      MAX_SOURCE,
    );
    if (!text.trim()) {
      throw new BadRequestException('The file has no extractable text.');
    }

    const chunks = this.chunk(text);
    const items: LlmInvItem[] = [];
    // Map chunks concurrently (bounded) — sequential Haiku calls over a 50-page
    // export are far too slow.
    for (let i = 0; i < chunks.length; i += MAP_CONCURRENCY) {
      const batch = chunks.slice(i, i + MAP_CONCURRENCY);
      const mapped = await Promise.all(batch.map((c) => this.mapChunk(c)));
      for (const m of mapped) if (m) items.push(...m);
    }

    const drafts = this.dedupe(
      items
        .map((i) => this.toDraft(i))
        .filter((d): d is InventoryImportDraft => d != null),
    );

    // Flag drafts that already exist (same ship + part#, else + name) so the
    // review shows what will be updated rather than created.
    await this.annotateExisting(shipId, drafts);

    const groups = new Set(
      drafts.map((d) => d.assetGroup).filter((g): g is string => !!g),
    );
    return {
      drafts,
      counts: {
        parsed: drafts.length,
        withPartNo: drafts.filter((d) => d.partNumber).length,
        existing: drafts.filter((d) => d.existing).length,
        groups: groups.size,
      },
      notes: [
        'Parsed from a stock export — review quantities and part numbers before importing.',
        'Items with a matching part number update the existing stock line instead of duplicating it.',
      ],
    };
  }

  // ── commit (idempotent upsert) ──

  async commit(
    shipId: string,
    drafts: InventoryImportDraft[],
  ): Promise<InventoryImportCommitResult> {
    if (!drafts?.length) throw new BadRequestException('Nothing to import.');

    // Preload existing items once, keyed by part# and by normalized name, so a
    // re-import updates in place instead of creating duplicates.
    // Two disjoint namespaces: numbered items are keyed by part number, the
    // rest by name. Keeping name-keying to part-number-LESS rows stops a
    // nameless "O-ring" from ever colliding with a numbered "O-ring".
    const existing = await this.itemRepository.find({ where: { shipId } });
    const byPartNo = new Map<string, InventoryItemEntity>();
    const byName = new Map<string, InventoryItemEntity>();
    for (const it of existing) {
      const pk = it.partNumber?.trim().toLowerCase();
      if (pk) byPartNo.set(pk, it);
      else byName.set(this.nameKey(it.name), it);
    }

    let created = 0;
    let updated = 0;
    for (const d of drafts) {
      const name = (d.name ?? '').trim();
      if (!name) continue;
      const partKey = d.partNumber?.trim().toLowerCase();
      // Match strictly by part number when one is present; only fall back to
      // the (often generic) name for part-number-less items, so a new numbered
      // part never overwrites a differently-numbered item sharing its name.
      const match = partKey
        ? byPartNo.get(partKey)
        : byName.get(this.nameKey(name));
      const patch = this.toEntityPatch(d);
      if (match) {
        Object.assign(match, patch);
        await this.itemRepository.save(match);
        updated++;
      } else {
        const saved = await this.itemRepository.save(
          this.itemRepository.create({ shipId, ...patch }),
        );
        // Register the newcomer in its namespace so later drafts in the same
        // batch dedup to it (part number if it has one, else name).
        const savedPk = saved.partNumber?.trim().toLowerCase();
        if (savedPk) byPartNo.set(savedPk, saved);
        else byName.set(this.nameKey(saved.name), saved);
        created++;
      }
    }
    return { created, updated };
  }

  // ── mapping helpers ──

  private async mapChunk(
    chunk: string,
    attempt = 0,
  ): Promise<LlmInvItem[] | null> {
    const userPrompt = `Stock export text:\n"""\n${chunk}\n"""`;
    try {
      const result = this.llmService.isAnthropicConfigured()
        ? await this.llmService.createAnthropicJsonCompletion<{
            items?: LlmInvItem[];
          }>({
            model: MAP_MODEL,
            systemPrompt: `${MAP_SYSTEM_PROMPT}\n${SCHEMA_HINT}`,
            userPrompt,
            maxTokens: MAP_MAX_TOKENS,
          })
        : await this.llmService.createJsonChatCompletion<{
            items?: LlmInvItem[];
          }>({
            systemPrompt: `${MAP_SYSTEM_PROMPT}\n${SCHEMA_HINT}`,
            userPrompt,
            temperature: 0.1,
            maxTokens: MAP_MAX_TOKENS,
          });
      if (!result || !Array.isArray(result.items)) return null;
      return result.items;
    } catch (error) {
      if (attempt < 1) return this.mapChunk(chunk, attempt + 1);
      this.logger.warn(
        `inventory mapChunk failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return null;
    }
  }

  private toDraft(i: LlmInvItem): InventoryImportDraft | null {
    const name = (i.name ?? '').trim();
    if (!name) return null;
    const cat = (i.category ?? '').toLowerCase();
    return {
      name: name.slice(0, 200),
      category: CATEGORIES.includes(cat) ? cat : 'part',
      manufacturer: cap(i.manufacturer, 160),
      partNumber: cap(i.part_number, 120),
      barcode: cap(i.barcode, 60),
      model: cap(i.model, 120),
      supplier: cap(i.supplier, 160),
      supplPartNo: cap(i.suppl_part_no, 120),
      quantity: num(i.quantity),
      stockMin: num(i.min),
      stockMax: num(i.max),
      unit: cap(i.unit, 20),
      valueEur: num(i.value_eur),
      location: cap(i.location, 160),
      assetGroup: cap(i.asset_group, 120),
      notes: cap(i.notes, 1000),
    };
  }

  /** Merge duplicate lines: same part# (else same name) collapse into one. */
  private dedupe(drafts: InventoryImportDraft[]): InventoryImportDraft[] {
    const out = new Map<string, InventoryImportDraft>();
    for (const d of drafts) {
      const key = d.partNumber
        ? `p:${d.partNumber.toLowerCase()}`
        : `n:${this.nameKey(d.name)}`;
      const prev = out.get(key);
      if (!prev) {
        out.set(key, d);
        continue;
      }
      // Keep the richer record; fill any blank fields from the duplicate.
      for (const k of Object.keys(d) as (keyof InventoryImportDraft)[]) {
        if (
          (prev[k] === null || prev[k] === undefined || prev[k] === '') &&
          d[k] != null &&
          d[k] !== ''
        ) {
          (prev as unknown as Record<string, unknown>)[k] = d[k];
        }
      }
    }
    return Array.from(out.values());
  }

  private async annotateExisting(
    shipId: string,
    drafts: InventoryImportDraft[],
  ): Promise<void> {
    if (!drafts.length) return;
    const existing = await this.itemRepository.find({
      where: { shipId },
      select: ['id', 'partNumber', 'name'],
    });
    const partNos = new Set(
      existing
        .map((e) => e.partNumber?.trim().toLowerCase())
        .filter((v): v is string => !!v),
    );
    // Only part-number-less rows are matched by name (mirrors commit()).
    const names = new Set(
      existing
        .filter((e) => !e.partNumber?.trim())
        .map((e) => this.nameKey(e.name)),
    );
    for (const d of drafts) {
      const pk = d.partNumber?.trim().toLowerCase();
      // Mirror commit()'s matching: part number is authoritative when present.
      d.existing = pk ? partNos.has(pk) : names.has(this.nameKey(d.name));
    }
  }

  private toEntityPatch(
    d: InventoryImportDraft,
  ): Partial<InventoryItemEntity> {
    // Cap every string to its column width — the commit endpoint takes a plain
    // interface body (no class-validator), so client-supplied drafts bypass the
    // global ValidationPipe and an oversized field would 500 the whole batch.
    return {
      name: d.name.trim().slice(0, 200),
      category: CATEGORIES.includes(d.category) ? d.category : 'part',
      manufacturer: cap(d.manufacturer, 160),
      partNumber: cap(d.partNumber, 120),
      barcode: cap(d.barcode, 60),
      model: cap(d.model, 120),
      supplier: cap(d.supplier, 160),
      supplPartNo: cap(d.supplPartNo, 120),
      quantity: d.quantity != null ? String(d.quantity) : null,
      stockMin: d.stockMin != null ? String(d.stockMin) : null,
      stockMax: d.stockMax != null ? String(d.stockMax) : null,
      unit: cap(d.unit, 20),
      valueEur: d.valueEur != null ? String(d.valueEur) : null,
      location: cap(d.location, 160),
      assetGroup: cap(d.assetGroup, 120),
      notes: d.notes?.trim() || null,
    };
  }

  private nameKey(s: string): string {
    return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // ── text extraction (mirrors the PMS importer) ──

  private async extractText(file: UploadedImportFile | null): Promise<string> {
    if (!file?.buffer) throw new BadRequestException('No file provided.');
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
        return wb.SheetNames.map((sheet) => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet]);
          return `# Sheet: ${sheet}\n${csv}`;
        }).join('\n\n');
      }
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
    // The group a run of items belongs to is printed once as a header
    // ("0212 ENGINES", "*99 BATTERIES") and applies until the next header. When
    // a group spans a chunk boundary the continuation chunk would otherwise
    // lose it, so we re-seed each new chunk with the last header seen.
    let lastHeader = '';
    const seed = () => (lastHeader ? `${lastHeader}\n` : '');
    for (const line of lines) {
      if (buf.length + line.length + 1 > CHUNK_CHARS && buf) {
        chunks.push(buf);
        buf = seed();
      }
      if (isGroupHeader(line)) lastHeader = line.trim();
      buf += line + '\n';
    }
    if (buf.trim()) chunks.push(buf);
    return chunks;
  }
}

/**
 * A group-header line in the stock export: an SFI code followed by an
 * upper-case name, e.g. "0212 ENGINES", "*99 BATTERIES", "0431 BATTERY PACKS".
 * Used to carry the current group across chunk boundaries.
 */
function isGroupHeader(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (/[a-z]/.test(t)) return false; // headers are upper-case
  if (/\d{5,}/.test(t)) return false; // item lines carry a jammed barcode/part#
  // "0212 ENGINES" / "*99 BATTERIES" (SFI-numbered) or "*OILS AND COOLANTS"
  // (star-prefixed, some groups have no SFI number).
  return (
    /^\*?\d{2,6}\s+[A-Z][A-Z0-9 ()/.,&-]{2,}$/.test(t) ||
    /^\*[A-Z][A-Z0-9 ()/.,&-]{2,}$/.test(t)
  );
}

function cap(v: unknown, n: number): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s ? s.slice(0, n) : null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  let s = String(v)
    .replace(/\s/g, '')
    .replace(/[^0-9.,-]/g, ''); // keep digits, both separators, sign
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the RIGHTMOST is the decimal separator, the other groups
    // thousands. "12.500,00" -> 12500.00 ; "1,234.56" -> 1234.56
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // Only a comma — European decimal ("103,49").
    s = s.replace(',', '.');
  }
  // Only a dot (or none) already reads as a JS number.
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MAP_SYSTEM_PROMPT = `You are a marine engineer normalizing another PMS's STOCK / INVENTORY export into Trident's inventory standard. The text was extracted from a PDF, so table columns are jammed together WITHOUT separators — you must split them apart using the anchors below.

LAYOUT of each stock item (fields run together on one or a few lines):
  <Item Name><Barcode><MANUFACTURER><Manuf.Part#><TotalQty><Value><AvgPrice>
  <Model / Type>
  <Storage location, may wrap over 2 lines>
  <Supplier><Suppl.Part#><Min>/<Max><Weight>

Anchors that split the jammed line:
- The MANUFACTURER is UPPERCASE words (e.g. "VOLVO PENTA", "MASTERVOLT", "EXIDE"). Text BEFORE it is the item name + barcode; text AFTER it is the manufacturer part number, then quantity, value, avg price.
- Barcode is a long digit run (often 10-12 digits) attached to the end of the name.
- A "GROUP HEADER" line like "0212 ENGINES", "*99 BATTERIES", "0431 BATTERY PACKS" starts a new group — apply it as asset_group to every item below until the next header. Do NOT emit a header as an item.
- Value uses a comma decimal ("103,49" = 103.49). Min/Max are separated by "/" ("12/24"). "[not set]", "0 EUR", "(total 0)" are noise.
- Supplier codes like "SYS" precede the supplier part number ("SYS00073554").

RULES:
1. One object per DISTINCT stock item. Skip page headers/footers ("Items List", "Page 1 of 50", timestamps, the column-title rows).
2. Never invent a part number. If you cannot confidently separate barcode vs part number, put your best guess in part_number and leave barcode null.
3. Item name: keep it as printed but fix obvious ALL-CAPS to readable case ("GASKET SET" -> "Gasket set"); keep brand names and codes ("Volvo Penta - Fuel Filter" stays).
4. category: part | tool | fluid | consumable | other. "TOOLS" storage or names like "Extractor"/"Guide" -> tool; oils/coolant/grease -> fluid; filters/gaskets/impellers -> part.
5. quantity is the current stock on hand (Total Qty). min/max are the reorder band. value_eur is the unit value.
6. asset_group is the FULL group header text ("0212 ENGINES").`;

const SCHEMA_HINT = `Return ONLY JSON: { "items": [ { "name": string, "manufacturer": string|null, "part_number": string|null, "barcode": string|null, "model": string|null, "supplier": string|null, "suppl_part_no": string|null, "quantity": number|null, "min": number|null, "max": number|null, "unit": string|null, "value_eur": number|null, "location": string|null, "asset_group": string|null, "category": string, "notes": string|null } ] }. No commentary.`;
