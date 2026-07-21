import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InventoryItemEntity } from './entities/inventory-item.entity';
import { InventoryItemAssetEntity } from './entities/inventory-item-asset.entity';
import { InventoryItemTaskEntity } from './entities/inventory-item-task.entity';
import { AssetEntity } from '../assets/entities/asset.entity';
import { PmsTaskEntity } from '../pms/entities/pms-task.entity';
import { LlmService } from '../../integrations/llm/llm.service';
import { AdminEventBus } from '../admin-events/admin-event.bus';

const CATEGORIES = ['part', 'tool', 'fluid', 'consumable', 'other'];

export interface UpsertInventoryInput {
  name: string;
  category?: string;
  partNumber?: string | null;
  location?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  quantity?: number | null;
  unit?: string | null;
  assetIds?: string[] | null;
  taskIds?: string[] | null;
  notes?: string | null;
}

export interface InventoryDraft {
  name: string;
  category?: string;
  partNumber?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  notes?: string | null;
  assetIds?: string[] | null;
}

const MAX_SOURCE = 120_000;
const CHUNK = 9000;
const PARTS_SIGNAL =
  /spare part|part number|part no|parts list|catalog|consumable|filter|gasket|seal|impeller|o-ring|bearing|element|kit|lubricant|oil|grease|coolant|fluid|qty|quantity/i;

interface LlmPart {
  name?: string;
  part_number?: string | null;
  manufacturer?: string | null;
  category?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  notes?: string | null;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(InventoryItemEntity)
    private readonly itemRepository: Repository<InventoryItemEntity>,
    @InjectRepository(InventoryItemAssetEntity)
    private readonly linkRepository: Repository<InventoryItemAssetEntity>,
    @InjectRepository(InventoryItemTaskEntity)
    private readonly taskLinkRepository: Repository<InventoryItemTaskEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(PmsTaskEntity)
    private readonly taskRepository: Repository<PmsTaskEntity>,
    private readonly llmService: LlmService,
    private readonly adminEvents: AdminEventBus,
  ) {}

  async list(shipId: string) {
    const items = await this.itemRepository.find({
      where: { shipId },
      order: { name: 'ASC' },
    });
    return this.withLinks(shipId, items);
  }

  async listForAsset(shipId: string, assetId: string) {
    const links = await this.linkRepository.find({ where: { assetId } });
    const itemIds = links.map((l) => l.inventoryItemId);
    if (itemIds.length === 0) return [];
    const items = await this.itemRepository.find({
      where: { shipId, id: In(itemIds) },
      order: { name: 'ASC' },
    });
    return this.withLinks(shipId, items);
  }

  /** Parts linked to one PMS task — feeds the task's parts panel. */
  async listForTask(shipId: string, taskId: string) {
    const links = await this.taskLinkRepository.find({ where: { taskId } });
    const itemIds = links.map((l) => l.inventoryItemId);
    if (itemIds.length === 0) return [];
    const items = await this.itemRepository.find({
      where: { shipId, id: In(itemIds) },
      order: { name: 'ASC' },
    });
    return this.withLinks(shipId, items);
  }

  async create(shipId: string, input: UpsertInventoryInput) {
    if (!input.name?.trim()) {
      throw new BadRequestException('Item name is required');
    }
    const saved = await this.itemRepository.save(
      this.itemRepository.create({ shipId, ...this.mapInput(input) }),
    );
    await this.setAssetLinks(shipId, saved.id, input.assetIds ?? []);
    await this.setTaskLinks(shipId, saved.id, input.taskIds ?? []);
    this.adminEvents.emit({
      domain: 'inventory',
      action: 'created',
      shipId,
      entityId: saved.id,
    });
    return (await this.withLinks(shipId, [saved]))[0];
  }

  async update(shipId: string, id: string, input: Partial<UpsertInventoryInput>) {
    const item = await this.itemRepository.findOne({ where: { id, shipId } });
    if (!item) throw new NotFoundException('Inventory item not found');
    Object.assign(item, this.mapInput(input, item));
    const saved = await this.itemRepository.save(item);
    if (input.assetIds !== undefined) {
      await this.setAssetLinks(shipId, saved.id, input.assetIds ?? []);
    }
    if (input.taskIds !== undefined) {
      await this.setTaskLinks(shipId, saved.id, input.taskIds ?? []);
    }
    this.adminEvents.emit({
      domain: 'inventory',
      action: 'updated',
      shipId,
      entityId: saved.id,
    });
    return (await this.withLinks(shipId, [saved]))[0];
  }

  async remove(shipId: string, id: string): Promise<void> {
    const item = await this.itemRepository.findOne({ where: { id, shipId } });
    if (!item) throw new NotFoundException('Inventory item not found');
    await this.itemRepository.delete(id); // join rows cascade away
    this.adminEvents.emit({
      domain: 'inventory',
      action: 'deleted',
      shipId,
      entityId: id,
    });
  }

  async createMany(shipId: string, drafts: InventoryDraft[]): Promise<{ created: number }> {
    if (!drafts?.length) throw new BadRequestException('Nothing to import.');
    let created = 0;
    for (const d of drafts) {
      if (!d.name?.trim()) continue;
      const saved = await this.itemRepository.save(
        this.itemRepository.create({ shipId, ...this.mapInput(d) }),
      );
      await this.setAssetLinks(shipId, saved.id, d.assetIds ?? []);
      created++;
      // (drafts don't carry task links — those are set later from the task side)
    }
    return { created };
  }

  /** Propose inventory items (parts/consumables) from an asset's manual text. */
  async suggestFromManual(
    shipId: string,
    assetId: string,
    markdown: string,
  ): Promise<{ drafts: InventoryDraft[]; notes: string[] }> {
    if (!this.llmService.isConfigured()) {
      throw new ServiceUnavailableException('AI is unavailable.');
    }
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) throw new BadRequestException('Asset not found on this ship.');
    const text = (markdown ?? '').trim().slice(0, MAX_SOURCE);
    if (!text) throw new BadRequestException('The manual has no extracted text yet.');

    const all = this.chunk(text);
    let chunks = all.filter((c) => PARTS_SIGNAL.test(c));
    if (chunks.length === 0) chunks = all.slice(0, 4);
    chunks = chunks.slice(0, 12);

    const modelLabel = [asset.brand, asset.model]
      .filter(Boolean)
      .join(' ')
      .trim();
    const parts: LlmPart[] = [];
    for (const c of chunks) {
      const r = await this.mapParts(c, asset.displayName, modelLabel);
      if (r) parts.push(...r);
    }
    // De-duplicate by part NAME (normalized). Multi-model tables otherwise
    // produce the same part several times with each model's number; keep the
    // first (its number matches this unit's model per the prompt).
    const seen = new Set<string>();
    const drafts = parts
      .map((p) => this.toDraft(p, assetId))
      .filter((d): d is InventoryDraft => d != null)
      .filter((d) => {
        const key = d.name.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      drafts,
      notes: ['Suggested from the linked manual — review before importing.'],
    };
  }

  // ── helpers ──

  private mapInput(
    input: Partial<UpsertInventoryInput>,
    existing?: InventoryItemEntity,
  ): Partial<InventoryItemEntity> {
    const out: Partial<InventoryItemEntity> = {};
    if (input.name !== undefined) out.name = input.name.trim().slice(0, 200);
    if (input.category !== undefined)
      out.category = CATEGORIES.includes(input.category ?? '') ? input.category! : 'part';
    if (input.partNumber !== undefined) out.partNumber = input.partNumber || null;
    if (input.location !== undefined) out.location = input.location || null;
    if (input.manufacturer !== undefined) out.manufacturer = input.manufacturer || null;
    if (input.supplier !== undefined) out.supplier = input.supplier || null;
    if (input.quantity !== undefined)
      out.quantity = input.quantity != null ? String(input.quantity) : null;
    if (input.unit !== undefined) out.unit = input.unit || null;
    if (input.notes !== undefined) out.notes = input.notes || null;
    void existing;
    return out;
  }

  /** Replace an item's asset links with the given set (only assets on the ship). */
  private async setAssetLinks(
    shipId: string,
    itemId: string,
    assetIds: string[],
  ): Promise<void> {
    const wanted = Array.from(
      new Set((assetIds ?? []).filter((v): v is string => !!v)),
    );
    let valid: string[] = [];
    if (wanted.length) {
      const found = await this.assetRepository.find({
        where: { id: In(wanted), shipId },
        select: ['id'],
      });
      valid = found.map((a) => a.id);
    }
    await this.linkRepository.delete({ inventoryItemId: itemId });
    if (valid.length) {
      await this.linkRepository.insert(
        valid.map((assetId) => ({ inventoryItemId: itemId, assetId })),
      );
    }
  }

  /** Replace an item's task links with the given set (only tasks on the ship). */
  private async setTaskLinks(
    shipId: string,
    itemId: string,
    taskIds: string[],
  ): Promise<void> {
    const wanted = Array.from(
      new Set((taskIds ?? []).filter((v): v is string => !!v)),
    );
    let valid: string[] = [];
    if (wanted.length) {
      const found = await this.taskRepository.find({
        where: { id: In(wanted), shipId },
        select: ['id'],
      });
      valid = found.map((t) => t.id);
    }
    await this.taskLinkRepository.delete({ inventoryItemId: itemId });
    if (valid.length) {
      await this.taskLinkRepository.insert(
        valid.map((taskId) => ({ inventoryItemId: itemId, taskId })),
      );
    }
  }

  /** Set the parts linked to a task (called from the task side). */
  async setLinksForTask(
    shipId: string,
    taskId: string,
    itemIds: string[],
  ): Promise<void> {
    const task = await this.taskRepository.findOne({
      where: { id: taskId, shipId },
      select: ['id'],
    });
    if (!task) throw new NotFoundException('Task not found on this ship');
    const wanted = Array.from(
      new Set((itemIds ?? []).filter((v): v is string => !!v)),
    );
    let valid: string[] = [];
    if (wanted.length) {
      const found = await this.itemRepository.find({
        where: { id: In(wanted), shipId },
        select: ['id'],
      });
      valid = found.map((i) => i.id);
    }
    await this.taskLinkRepository.delete({ taskId });
    if (valid.length) {
      await this.taskLinkRepository.insert(
        valid.map((inventoryItemId) => ({ inventoryItemId, taskId })),
      );
    }
  }

  private async withLinks(shipId: string, items: InventoryItemEntity[]) {
    void shipId;
    const itemIds = items.map((i) => i.id);
    const links = itemIds.length
      ? await this.linkRepository.find({
          where: { inventoryItemId: In(itemIds) },
        })
      : [];
    const taskLinks = itemIds.length
      ? await this.taskLinkRepository.find({
          where: { inventoryItemId: In(itemIds) },
        })
      : [];
    const assetIds = Array.from(new Set(links.map((l) => l.assetId)));
    const taskIds = Array.from(new Set(taskLinks.map((l) => l.taskId)));
    const assets = assetIds.length
      ? await this.assetRepository.find({
          where: { id: In(assetIds) },
          select: ['id', 'displayName'],
        })
      : [];
    const tasks = taskIds.length
      ? await this.taskRepository.find({
          where: { id: In(taskIds) },
          select: ['id', 'task'],
        })
      : [];
    const aMap = new Map(assets.map((a) => [a.id, a.displayName]));
    const tMap = new Map(tasks.map((t) => [t.id, t.task]));
    const assetsByItem = new Map<string, string[]>();
    for (const l of links) {
      const arr = assetsByItem.get(l.inventoryItemId) ?? [];
      arr.push(l.assetId);
      assetsByItem.set(l.inventoryItemId, arr);
    }
    const tasksByItem = new Map<string, string[]>();
    for (const l of taskLinks) {
      const arr = tasksByItem.get(l.inventoryItemId) ?? [];
      arr.push(l.taskId);
      tasksByItem.set(l.inventoryItemId, arr);
    }
    return items.map((i) => {
      const aIds = assetsByItem.get(i.id) ?? [];
      const tIds = tasksByItem.get(i.id) ?? [];
      return {
        id: i.id,
        name: i.name,
        category: i.category,
        partNumber: i.partNumber ?? undefined,
        barcode: i.barcode ?? undefined,
        model: i.model ?? undefined,
        location: i.location ?? undefined,
        manufacturer: i.manufacturer ?? undefined,
        supplier: i.supplier ?? undefined,
        supplPartNo: i.supplPartNo ?? undefined,
        quantity: i.quantity != null ? Number(i.quantity) : undefined,
        stockMin: i.stockMin != null ? Number(i.stockMin) : undefined,
        stockMax: i.stockMax != null ? Number(i.stockMax) : undefined,
        valueEur: i.valueEur != null ? Number(i.valueEur) : undefined,
        unit: i.unit ?? undefined,
        assetGroup: i.assetGroup ?? undefined,
        assetIds: aIds,
        assets: aIds
          .map((id) => ({ id, name: aMap.get(id) ?? null }))
          .filter((a) => a.name != null) as { id: string; name: string }[],
        taskIds: tIds,
        tasks: tIds
          .map((id) => ({ id, name: tMap.get(id) ?? null }))
          .filter((t) => t.name != null) as { id: string; name: string }[],
        notes: i.notes ?? undefined,
      };
    });
  }

  private chunk(text: string): string[] {
    if (text.length <= CHUNK) return [text];
    const lines = text.split('\n');
    const out: string[] = [];
    let buf = '';
    for (const l of lines) {
      if (buf.length + l.length + 1 > CHUNK && buf) {
        out.push(buf);
        buf = '';
      }
      buf += l + '\n';
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  private async mapParts(
    chunk: string,
    assetName: string,
    modelLabel: string,
  ): Promise<LlmPart[] | null> {
    const modelLine = modelLabel
      ? `This unit is model: ${modelLabel}. The parts tables may list SEVERAL models side by side (columns) — for each part, take ONLY the value in the column for THIS model, and output the part once.`
      : `The parts tables may list several models — if a part has more than one number for different models, pick the most likely single value and output the part once.`;
    const r = await this.llmService.createJsonChatCompletion<{ parts?: LlmPart[] }>({
      systemPrompt: PARTS_PROMPT,
      userPrompt: `Equipment: ${assetName}\n${modelLine}\n\nManual excerpt:\n"""\n${chunk}\n"""`,
      temperature: 0.1,
      maxTokens: 4000,
    });
    if (!r || !Array.isArray(r.parts)) return null;
    return r.parts;
  }

  private toDraft(p: LlmPart, assetId: string): InventoryDraft | null {
    const name = (p.name ?? '').trim();
    if (!name) return null;
    const cat = (p.category ?? '').toLowerCase();
    const qty =
      p.quantity == null || p.quantity === ''
        ? null
        : Number(String(p.quantity).replace(/[^0-9.]/g, '')) || null;
    return {
      name: name.slice(0, 200),
      category: CATEGORIES.includes(cat) ? cat : 'part',
      partNumber: p.part_number?.toString().trim() || null,
      manufacturer: p.manufacturer?.trim() || null,
      quantity: qty,
      unit: p.unit?.trim() || null,
      notes: p.notes?.trim() || null,
      assetIds: [assetId],
    };
  }
}

const PARTS_PROMPT = `You are a marine engineer reading an equipment MANUAL excerpt. Extract the SPARE PARTS / CONSUMABLES / FLUIDS catalogue for this equipment — items a vessel would stock for maintenance.

Return ONLY JSON: { "parts": [ ... ] }. One object per DISTINCT part. Fields:
- name (required): the part/consumable name (e.g. "Fuel filter element", "Impeller", "Engine oil 15W-40", "O-ring kit").
- part_number: manufacturer part/catalogue number if given, else null.
- manufacturer: maker if given, else null.
- category: one of part, tool, fluid, consumable, other.
- quantity: number if a recommended/stock quantity is stated, else null.
- unit: e.g. "pcs", "set", "kit", "L", "kg" if stated, else null.
- notes: short spec/usage note (size, type, spec, where used), else null.

READING MULTI-MODEL TABLES (important):
- A parts table often has one row per part and SEVERAL COLUMNS, one per engine/generator model. The SAME part (e.g. "Seawater Pump Impeller Kit") then has DIFFERENT part numbers per model.
- Do NOT emit the same part multiple times with each model's number. Emit each part name ONCE. Use the part number for THIS unit's model (given in the user message); if the model is unknown, pick the single most likely number and put the alternatives in notes.

ONLY include items from a parts list / spare parts / consumables / fluids / maintenance-parts section. IGNORE operating instructions, procedures, specification tables, troubleshooting, wiring. If none, return { "parts": [] }. No duplicate part names. JSON only.`;
