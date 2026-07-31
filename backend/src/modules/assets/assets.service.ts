import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { DocumentEntity } from '../documents/entities/document.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { ImportResultDto } from './dto/import-result.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { BulkUpdateAssetsDto } from './dto/bulk-update.dto';
import { RelatedAssetResult } from './dto/related-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { AssetDocumentLinkEntity } from './entities/asset-document-link.entity';
import { AssetSnapshotEntity } from './entities/asset-snapshot.entity';
import { AssetEntity } from './entities/asset.entity';
import { SfiService } from '../sfi/sfi.service';
import { AssetIdService } from './asset-id.service';
import { ServiceRuleEntity } from './entities/service-rule.entity';
import type {
  CompleteServiceRuleDto,
  CreateServiceRuleDto,
  UpdateServiceRuleDto,
} from './dto/service-rule.dto';
import type {
  ImportPreviewResult,
  ImportPreviewRename,
  ImportPreviewSfiWarning,
} from './dto/import-preview.dto';
import type { CommitImportDto } from './dto/commit-import.dto';
import {
  isValidDeckRoleCode,
  isValidZoneCode,
} from './enums/asset-location-vocab';
import { lowerTrim } from './assets.normalization';
import { AdminEventBus } from '../admin-events/admin-event.bus';
import {
  buildRegisterWorkbook,
  naturalCompareIds,
  parseXlsxToDrafts,
} from './asset-xlsx.codec';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly metricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(AssetDocumentLinkEntity)
    private readonly assetDocLinkRepository: Repository<AssetDocumentLinkEntity>,
    @InjectRepository(AssetSnapshotEntity)
    private readonly assetSnapshotRepository: Repository<AssetSnapshotEntity>,
    @InjectRepository(ServiceRuleEntity)
    private readonly serviceRuleRepository: Repository<ServiceRuleEntity>,
    private readonly sfiService: SfiService,
    private readonly assetIdService: AssetIdService,
    private readonly adminEvents: AdminEventBus,
  ) {}

  private emitChange(
    shipId: string,
    action: 'created' | 'updated' | 'deleted',
    entityId?: string,
  ): void {
    this.adminEvents.emit({ domain: 'assets', action, shipId, entityId });
  }

  async list(shipId: string, query: QueryAssetsDto) {
    await this.assertShipExists(shipId);

    const limit = Math.min(query.limit ?? 200, 2000);
    const offset = query.offset ?? 0;

    const qb = this.assetRepository
      .createQueryBuilder('a')
      .where('a.ship_id = :shipId', { shipId });

    if (query.sfiGroup) {
      qb.andWhere('a.sfi_group = :sfiGroup', { sfiGroup: query.sfiGroup });
    }
    if (query.sfiSub) {
      qb.andWhere('a.sfi_sub = :sfiSub', { sfiSub: query.sfiSub });
    }

    if (query.assetIdPrefix) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('a.asset_id_internal = :exact', { exact: query.assetIdPrefix })
            .orWhere('a.asset_id_internal LIKE :prefix', {
              prefix: `${query.assetIdPrefix}.%`,
            })
            .orWhere('a.asset_id_internal LIKE :prefix2', {
              prefix2: `${query.assetIdPrefix}-%`,
            }),
        ),
      );
    }

    if (query.search) {
      const like = `%${query.search}%`;
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('a.asset_id_internal ILIKE :like', { like })
            .orWhere('a.display_name ILIKE :like', { like })
            .orWhere('a.brand ILIKE :like', { like })
            .orWhere('a.model ILIKE :like', { like })
            .orWhere('a.serial_no ILIKE :like', { like })
            .orWhere('a.sfi_sub_name ILIKE :like', { like }),
        ),
      );
    }

    qb.orderBy('a.asset_id_internal', 'ASC');
    qb.skip(offset).take(limit);

    const [items, total] = await qb.getManyAndCount();

    // Coverage counts so the register can show which assets have a manual
    // and/or bound telemetry (manuals via the asset_documents junction,
    // metrics via ship_metric_catalog.bound_asset_id).
    const assetIds = items.map((a) => a.id);
    const manualCounts = new Map<string, number>();
    const metricCounts = new Map<string, number>();
    if (assetIds.length) {
      const mc: Array<{ asset_id: string; cnt: number }> =
        await this.assetRepository.manager.query(
          // link_type='excluded' rows are suppressed auto-matches (the manual
          // does NOT apply to this asset) — the drawer skips them, so coverage
          // must too, else an unlinked manual leaves a phantom yellow accent.
          `SELECT ad.asset_id, COUNT(*)::int AS cnt
             FROM asset_documents ad
             JOIN documents d ON d.id = ad.document_id
            WHERE d.doc_class = 'manual' AND ad.asset_id = ANY($1)
              AND ad.link_type IS DISTINCT FROM 'excluded'
            GROUP BY ad.asset_id`,
          [assetIds],
        );
      for (const r of mc) manualCounts.set(r.asset_id, r.cnt);
      const kc: Array<{ bound_asset_id: string; cnt: number }> =
        await this.assetRepository.manager.query(
          `SELECT bound_asset_id, COUNT(*)::int AS cnt
             FROM ship_metric_catalog
            WHERE bound_asset_id = ANY($1) AND is_enabled = true
            GROUP BY bound_asset_id`,
          [assetIds],
        );
      for (const r of kc) metricCounts.set(r.bound_asset_id, r.cnt);
    }

    // The SQL sort is lexical ("SWX.10" < "SWX.2", "sub 10" < "sub 2"), so
    // the register read as group 10 → 2. Re-sort numerically. Safe because
    // the admin loads the whole register in one page (limit 2000 ≥ fleet);
    // if true offset pagination is ever enabled for >2000-asset vessels,
    // move this into SQL so page boundaries stay correct.
    items.sort((a, b) =>
      naturalCompareIds(a.assetIdInternal, b.assetIdInternal),
    );
    return {
      items: items.map((a) => ({
        ...a,
        manualCount: manualCounts.get(a.id) ?? 0,
        metricCount: metricCounts.get(a.id) ?? 0,
      })),
      total,
      limit,
      offset,
    };
  }

  async getOne(shipId: string, assetId: string): Promise<AssetEntity> {
    await this.assertShipExists(shipId);
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found on ship ${shipId}`);
    }
    return asset;
  }

  /**
   * Fetch the asset + everything bound to it: AI-bound metrics (via
   * ship_metric_catalog.bound_asset_id FK) and documents that match the
   * asset's brand+model (loose match — RAGFlow-style equipment retrieval).
   * Used by the admin Asset Register UI to render the side detail panel.
   */
  async getRelated(
    shipId: string,
    assetId: string,
  ): Promise<RelatedAssetResult> {
    const asset = await this.getOne(shipId, assetId);

    // 1. Metrics bound by AI via bound_asset_id FK.
    const metrics = await this.metricCatalogRepository.find({
      where: { shipId, boundAssetId: asset.id },
      order: { key: 'ASC' as const },
    });

    // 2. Documents matching this asset's manufacturer/model. The RAGFlow
    // chat tool uses brand+model+displayName at query time; we mirror that
    // matching logic for the admin view but with a fuzzy-loose AND (brand
    // must match if present; model is bonus).
    // (a) Explicitly linked documents via asset_documents junction
    const explicitLinks = await this.assetDocLinkRepository.find({
      where: { assetId: asset.id },
      relations: { document: true },
      order: { createdAt: 'DESC' },
    });
    const explicit = explicitLinks
      .filter((l) => l.linkType !== 'excluded')
      .map((l) => l.document)
      .filter((d): d is DocumentEntity => Boolean(d));

    // No live brand/model auto-match here: it produced dozens of wrong hits
    // (a FURUNO manual matched every FURUNO asset; a Gianneschi boiler manual
    // every Gianneschi tank) that the operator couldn't see or control.
    // Manuals are linked to assets ONCE at upload by the extractor's strict
    // brand+model match (real pinned links), and thereafter only explicitly.
    const explicitIds = new Set(explicit.map((d) => d.id));

    // PLANS live in their own list: they are file pointers (never parsed),
    // shown on the Overview — the Manuals tab is manuals/procedures only.
    const isPlan = (d: DocumentEntity) => d.docClass === 'plan';
    const nonPlan = explicit.filter((d) => !isPlan(d));

    // Drawings: explicit plan links only. Plans are drawing-code auto-linked
    // ONCE at upload as real pinned links (see autoLinkPlanByDrawingCode), so
    // there is no live phantom match here — what shows is real and editable.
    const drawingDocs: DocumentEntity[] = explicit.filter(isPlan);

    const documents = nonPlan;

    return {
      asset,
      metrics: metrics.map((m) => {
        // key is formatted "bucket::measurement::field" — parse the
        // middle segment so the frontend has a clean display value.
        const parts = m.key.split('::');
        const measurement = parts.length >= 3 ? parts[1] : m.bucket;
        return {
          id: m.id,
          key: m.key,
          bucket: m.bucket,
          measurement,
          field: m.field,
          aiDescription: m.aiDescription,
          aiKind: m.aiKind,
          aiUnit: m.aiUnit,
          aiBoundConfidence: m.aiBoundConfidence,
          aiGeneratedAt: m.aiGeneratedAt,
        };
      }),
      documents: documents.map((d) => ({
        id: d.id,
        originalFileName: d.originalFileName,
        manufacturer: d.manufacturer,
        model: d.model,
        equipmentName: d.equipmentName,
        docClass: d.docClass,
        parseStatus: d.parseStatus,
        createdAt: d.createdAt,
        linkSource: explicitIds.has(d.id) ? 'explicit' as const : 'auto' as const,
      })),
      drawings: drawingDocs.map((d) => ({
        id: d.id,
        originalFileName: d.originalFileName,
        manufacturer: d.manufacturer,
        model: d.model,
        equipmentName: d.equipmentName,
        docClass: d.docClass,
        parseStatus: d.parseStatus,
        createdAt: d.createdAt,
        linkSource: explicitIds.has(d.id) ? 'explicit' as const : 'auto' as const,
      })),
    };
  }

  /**
   * Pin a document to an asset (explicit link via asset_documents junction).
   * Idempotent — if the link already exists we silently no-op so the UI can
   * click "+ Link" without checking first.
   */
  async linkDocument(
    shipId: string,
    assetId: string,
    documentId: string,
    userId: string | null,
  ): Promise<void> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

    const doc = await this.documentRepository.findOne({
      where: { id: documentId, shipId },
    });
    if (!doc) {
      throw new NotFoundException(
        `Document ${documentId} not found on ship ${shipId}`,
      );
    }

    const existing = await this.assetDocLinkRepository.findOne({
      where: { assetId, documentId },
    });
    if (existing?.linkType === 'pinned') return; // idempotent
    // Re-linking an excluded document flips the suppression back to a pin.
    await this.assetDocLinkRepository.save({
      assetId,
      documentId,
      linkType: 'pinned',
      createdByUserId: userId,
    });
  }

  /**
   * Detach a document from an asset. For a pinned link this deletes the
   * row; for an auto-match (no pinned row) it saves an 'excluded'
   * suppression so the fuzzy matcher stops re-attaching the document.
   */
  async unlinkDocument(
    shipId: string,
    assetId: string,
    documentId: string,
  ): Promise<void> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, shipId },
    });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

    const existing = await this.assetDocLinkRepository.findOne({
      where: { assetId, documentId },
    });

    if (existing?.linkType === 'pinned') {
      await this.assetDocLinkRepository.delete({ assetId, documentId });
      return;
    }

    const doc = await this.documentRepository.findOne({
      where: { id: documentId, shipId },
    });
    if (!doc) {
      throw new NotFoundException(
        `Document ${documentId} not found on ship ${shipId}`,
      );
    }

    await this.assetDocLinkRepository.save({
      assetId,
      documentId,
      linkType: 'excluded',
    });
  }

  /**
   * Next free asset id for a sub-group: `<PREFIX>.<sub>.<NN>` where PREFIX is
   * the ship's register prefix (taken from its existing ids, e.g. SWX) and NN
   * is one past the highest sequence already used under that sub. Drives the
   * auto-filled ID in the "Add asset" modal — the operator picks group→sub
   * and gets a ready id.
   */
  async nextAssetId(
    shipId: string,
    sfiSub: string,
  ): Promise<{ assetIdInternal: string | null; prefix: string | null }> {
    const sub = sfiSub.trim();
    if (!sub) return { assetIdInternal: null, prefix: null };

    // Register prefix = the token before the first dot, majority-voted over
    // the ship's existing ids (SWX.1.10.01 → SWX).
    const rows: Array<{ id: string }> = await this.assetRepository
      .createQueryBuilder('a')
      .select('a.asset_id_internal', 'id')
      .where('a.ship_id = :shipId', { shipId })
      .getRawMany();
    const counts = new Map<string, number>();
    for (const r of rows) {
      const m = /^([A-Za-z][A-Za-z0-9]*)\./.exec(r.id);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const prefix =
      [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!prefix) return { assetIdInternal: null, prefix: null };

    // Highest existing sequence under `<PREFIX>.<sub>.` (suffixes like -PS
    // after the number are fine — we only parse the leading digits).
    const head = `${prefix}.${sub}.`;
    let max = 0;
    for (const r of rows) {
      if (!r.id.startsWith(head)) continue;
      const m = /^(\d+)/.exec(r.id.slice(head.length));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const seq = String(max + 1).padStart(2, '0');
    return { assetIdInternal: `${head}${seq}`, prefix };
  }

  /**
   * Create an asset, with an answer ready for the id already being taken.
   *
   * Register ids are positional — SWX.4.1.05 is the fifth battery pack, not an
   * arbitrary key — so an operator adding a unit that belongs at 05 is making a
   * real request, not a mistake. `onConflict` says which of the two honest
   * outcomes they mean:
   *   'shift'   — insert here and move 05..N up one place, references included
   *   'replace' — this physical unit replaced the one on file: overwrite the
   *               existing row, keeping its uuid so documents, metrics, tasks
   *               and certificates stay attached to the position
   * Without it, a taken id is still a 409 — silently doing either would be
   * worse than refusing.
   */
  async create(
    shipId: string,
    input: CreateAssetDto,
    onConflict?: 'shift' | 'replace',
  ): Promise<AssetEntity> {
    await this.assertShipExists(shipId);
    const existing = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal: input.assetIdInternal },
    });
    if (existing && onConflict === 'replace') {
      // Same row, new equipment: the position and everything linked to it
      // survive, the identity fields do not.
      Object.assign(existing, this.createPayload(input));
      const replaced = await this.assetRepository.save(existing);
      this.emitChange(shipId, 'updated', replaced.id);
      return replaced;
    }
    if (existing && onConflict === 'shift') {
      return this.assetRepository.manager.transaction(async (tx) => {
        const repo = tx.getRepository(AssetEntity);
        await this.assetIdService.shiftUp(tx, shipId, input.assetIdInternal);
        const inserted = await repo.save(
          repo.create({ shipId, ...this.createPayload(input) }),
        );
        this.emitChange(shipId, 'created', inserted.id);
        return inserted;
      });
    }
    if (existing) {
      throw new ConflictException(
        `Asset ${input.assetIdInternal} already exists on this ship`,
      );
    }

    const entity = this.assetRepository.create({
      shipId,
      ...this.createPayload(input),
    });

    const saved = await this.assetRepository.save(entity);
    this.emitChange(shipId, 'created', saved.id);
    return saved;
  }

  /**
   * The create DTO as entity columns. One place, so the three ways in — plain
   * create, insert-with-shift, and replace-in-place — cannot drift apart the
   * way the import mappers already have.
   */
  private createPayload(input: CreateAssetDto): Partial<AssetEntity> {
    return {
      assetIdInternal: input.assetIdInternal,
      displayName: input.displayName,
      sfiGroup: input.sfiGroup ?? null,
      sfiGroupName: input.sfiGroupName ?? null,
      sfiSub: input.sfiSub ?? null,
      sfiSubName: input.sfiSubName ?? null,
      drawingCode: input.drawingCode ?? null,
      parentAssetId: input.parentAssetId ?? null,
      servedByAssetId: input.servedByAssetId ?? null,
      locationAssetId: input.locationAssetId ?? null,
      brand: input.brand ?? null,
      model: input.model ?? null,
      serialNo: input.serialNo ?? null,
      criticality: input.criticality ?? null,
      commissionedDate: input.commissionedDate ?? null,
      location: input.location ?? null,
      department: input.department ?? null,
      rinaRef: input.rinaRef ?? null,
      notes: input.notes ?? null,
    };
  }

  async update(
    shipId: string,
    assetUuid: string,
    input: UpdateAssetDto,
  ): Promise<AssetEntity> {
    const asset = await this.getOne(shipId, assetUuid);

    if (
      input.assetIdInternal !== undefined &&
      input.assetIdInternal !== asset.assetIdInternal
    ) {
      const clash = await this.assetRepository.findOne({
        where: { shipId, assetIdInternal: input.assetIdInternal },
      });
      if (clash) {
        throw new ConflictException(
          `Cannot change asset_id to ${input.assetIdInternal} — another asset uses it`,
        );
      }
      asset.assetIdInternal = input.assetIdInternal;
    }

    if (input.displayName !== undefined) asset.displayName = input.displayName;
    if (input.sfiGroup !== undefined) asset.sfiGroup = input.sfiGroup;
    if (input.sfiGroupName !== undefined) asset.sfiGroupName = input.sfiGroupName;
    if (input.sfiSub !== undefined) asset.sfiSub = input.sfiSub;
    if (input.sfiSubName !== undefined) asset.sfiSubName = input.sfiSubName;
    if (input.drawingCode !== undefined) asset.drawingCode = input.drawingCode;
    if (input.parentAssetId !== undefined) asset.parentAssetId = input.parentAssetId;
    if (input.servedByAssetId !== undefined) asset.servedByAssetId = input.servedByAssetId;
    if (input.locationAssetId !== undefined) asset.locationAssetId = input.locationAssetId;
    if (input.brand !== undefined) asset.brand = input.brand;
    if (input.model !== undefined) asset.model = input.model;
    if (input.serialNo !== undefined) asset.serialNo = input.serialNo;
    if (input.criticality !== undefined) asset.criticality = input.criticality;
    if (input.commissionedDate !== undefined) asset.commissionedDate = input.commissionedDate;
    if (input.location !== undefined) asset.location = input.location;
    if (input.department !== undefined) asset.department = input.department;
    if (input.rinaRef !== undefined) asset.rinaRef = input.rinaRef;
    if (input.notes !== undefined) asset.notes = input.notes;
    // v14.6 fields
    if (input.zone !== undefined) {
      const z = input.zone?.toUpperCase() ?? null;
      asset.zone = z && isValidZoneCode(z) ? z : input.zone === null ? null : asset.zone;
    }
    if (input.deckRole !== undefined) {
      const d = input.deckRole?.toUpperCase() ?? null;
      asset.deckRole = d && isValidDeckRoleCode(d) ? d : input.deckRole === null ? null : asset.deckRole;
    }
    if (input.spaceInstance !== undefined) asset.spaceInstance = input.spaceInstance;
    if (input.spaceLabel !== undefined) asset.spaceLabel = input.spaceLabel;
    if (input.drawingRef !== undefined) asset.drawingRef = input.drawingRef;
    if (input.inspectionObligation !== undefined) {
      asset.inspectionObligation = input.inspectionObligation;
    }

    const saved = await this.assetRepository.save(asset);
    this.emitChange(shipId, 'updated', assetUuid);
    return saved;
  }

  /**
   * Set one value on many assets at once.
   *
   * Scoped to the ship in the WHERE clause, not just checked beforehand: the ids
   * come from a browser and a stale or forged one must not reach another
   * vessel's register. Returns the number actually changed rather than the
   * number asked for, so the caller reports what happened.
   */
  async bulkUpdate(
    shipId: string,
    input: BulkUpdateAssetsDto,
  ): Promise<{ updated: number }> {
    await this.assertShipExists(shipId);
    const { assetIds, ...fields } = input;

    const patch: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      // '' from a cleared form field means "empty this", same as null.
      patch[key] =
        typeof value === 'string' && value.trim() === '' ? null : (value as string | null);
    }
    if (!Object.keys(patch).length) {
      throw new BadRequestException('No fields to apply.');
    }

    const result = await this.assetRepository
      .createQueryBuilder()
      .update(AssetEntity)
      .set(patch)
      .where('ship_id = :shipId', { shipId })
      .andWhere('id IN (:...assetIds)', { assetIds })
      .execute();

    const updated = result.affected ?? 0;
    if (updated > 0) this.emitChange(shipId, 'updated');
    return { updated };
  }

  async remove(shipId: string, assetUuid: string): Promise<void> {
    const asset = await this.getOne(shipId, assetUuid);
    await this.assetRepository.remove(asset);
    this.emitChange(shipId, 'deleted', assetUuid);
  }

  /**
   * Wipe every asset on a ship. Snapshots first (rollback insurance) — this
   * also SET NULLs metric bindings and CASCADE-deletes service rules +
   * document links, so the snapshot is the only undo. Returns how many were
   * removed and the snapshot id (null when there was nothing to clear).
   */
  async clearAll(
    shipId: string,
    userId: string | null,
  ): Promise<{ deleted: number; snapshotId: string | null }> {
    await this.assertShipExists(shipId);
    const deleted = await this.assetRepository.count({ where: { shipId } });
    if (deleted === 0) {
      return { deleted: 0, snapshotId: null };
    }
    const snapshotId = await this.createSnapshot(
      shipId,
      `pre-clear-all (${new Date().toISOString().slice(0, 10)})`,
      userId,
    );
    await this.assetRepository.delete({ shipId });
    this.emitChange(shipId, 'deleted');
    return { deleted, snapshotId };
  }

  /**
   * Export the whole register as an xlsx, ready to be edited and imported
   * back. The sheet itself is built by the codec; all this does is fetch the
   * rows and name the file after the vessel.
   */
  async exportXlsx(
    shipId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }
    const assets = await this.assetRepository.find({ where: { shipId } });
    return buildRegisterWorkbook(ship.name, assets);
  }

  /**


  /**
   * Dry-run an import: parse the file, compute create/update/orphan/
   * rename diffs against current DB state, return them WITHOUT writing.
   * Lets the admin UI show a confirmation modal before commit.
   */
  async previewImportFromXlsx(
    shipId: string,
    buffer: Buffer,
  ): Promise<ImportPreviewResult> {
    await this.assertShipExists(shipId);
    const { drafts, parseErrors, totalRows } = parseXlsxToDrafts(buffer);

    const existing = await this.assetRepository.find({ where: { shipId } });
    const existingByCode = new Map(
      existing.map((a) => [a.assetIdInternal, a]),
    );
    const incomingByCode = new Map(drafts.map((d) => [d.draft.assetIdInternal!, d.draft]));

    const create: ImportPreviewResult['create'] = [];
    const update: ImportPreviewResult['update'] = [];

    for (const { draft } of drafts) {
      const code = draft.assetIdInternal!;
      const current = existingByCode.get(code);
      if (!current) {
        create.push({
          assetIdInternal: code,
          displayName: draft.displayName!,
          sfiGroup: draft.sfiGroup ?? null,
          brand: draft.brand ?? null,
          model: draft.model ?? null,
        });
        continue;
      }
      const changes = this.diffAssetFields(current, draft);
      if (changes.length > 0) {
        update.push({
          assetIdInternal: code,
          displayName: draft.displayName!,
          changes,
        });
      }
    }

    // Orphans = current assets that are NOT mentioned in the file.
    const orphans = existing.filter((a) => !incomingByCode.has(a.assetIdInternal));

    // Rename candidates = orphan + new-create with matching display_name
    // + brand + model (or weaker tiers). Conservative: don't propose if
    // displayName is missing on either side.
    const renames: ImportPreviewRename[] = [];
    const norm = lowerTrim;
    for (const o of orphans) {
      if (!o.displayName) continue;
      for (const c of create) {
        if (norm(c.displayName) !== norm(o.displayName)) continue;
        const brandMatch =
          o.brand && c.brand && norm(o.brand) === norm(c.brand);
        const modelMatch =
          o.model && c.model && norm(o.model) === norm(c.model);
        let score: ImportPreviewRename['matchScore'];
        if (brandMatch && modelMatch) score = 'exact-name-brand-model';
        else if (brandMatch) score = 'exact-name-brand';
        else score = 'exact-name';
        renames.push({
          oldAssetIdInternal: o.assetIdInternal,
          newAssetIdInternal: c.assetIdInternal,
          displayName: o.displayName,
          matchScore: score,
        });
        break; // one match per orphan is enough for the UI
      }
    }

    // Bound metric + linked doc counts per orphan — admin wants to know
    // what data they'd lose by deleting.
    const orphanIds = orphans.map((o) => o.id);
    let metricCounts = new Map<string, number>();
    let docCounts = new Map<string, number>();
    if (orphanIds.length > 0) {
      const mc = await this.metricCatalogRepository
        .createQueryBuilder('m')
        .select('m.bound_asset_id', 'asset_id')
        .addSelect('COUNT(*)', 'cnt')
        .where('m.bound_asset_id IN (:...ids)', { ids: orphanIds })
        .groupBy('m.bound_asset_id')
        .getRawMany<{ asset_id: string; cnt: string }>();
      metricCounts = new Map(mc.map((r) => [r.asset_id, parseInt(r.cnt, 10)]));
      const dc = await this.assetDocLinkRepository
        .createQueryBuilder('l')
        .select('l.asset_id', 'asset_id')
        .addSelect('COUNT(*)', 'cnt')
        .where('l.asset_id IN (:...ids)', { ids: orphanIds })
        .groupBy('l.asset_id')
        .getRawMany<{ asset_id: string; cnt: string }>();
      docCounts = new Map(dc.map((r) => [r.asset_id, parseInt(r.cnt, 10)]));
    }

    const orphansOut = orphans.map((o) => ({
      assetIdInternal: o.assetIdInternal,
      displayName: o.displayName,
      sfiGroup: o.sfiGroup,
      brand: o.brand,
      model: o.model,
      boundMetricCount: metricCounts.get(o.id) ?? 0,
      linkedDocumentCount: docCounts.get(o.id) ?? 0,
    }));
    // Suppress orphans that have a rename candidate from the orphans list
    // — UI shows them in the "potentialRenames" bucket instead so admin
    // doesn't get confused.
    const renameOldCodes = new Set(renames.map((r) => r.oldAssetIdInternal));
    const orphansFinal = orphansOut.filter(
      (o) => !renameOldCodes.has(o.assetIdInternal),
    );

    // SFI validation against the loaded taxonomy — flag drafts whose
    // sfi_sub isn't a known catalog code (off-standard / typo) or is
    // missing entirely. Non-blocking; surfaced in the preview modal.
    const validSfi = new Set((await this.sfiService.all()).map((n) => n.code));
    const sfiWarnings: ImportPreviewSfiWarning[] = [];
    for (const { draft } of drafts) {
      const sub = draft.sfiSub ?? null;
      if (!sub) {
        sfiWarnings.push({
          assetIdInternal: draft.assetIdInternal!,
          sfiSub: null,
          reason: 'missing',
        });
      } else if (!validSfi.has(sub)) {
        sfiWarnings.push({
          assetIdInternal: draft.assetIdInternal!,
          sfiSub: sub,
          reason: 'unknown-code',
        });
      }
    }

    return {
      totalRows,
      parseErrors,
      create,
      update,
      orphans: orphansFinal,
      potentialRenames: renames,
      sfiWarnings,
      counts: {
        create: create.length,
        update: update.length,
        orphans: orphansFinal.length,
        renames: renames.length,
        parseErrors: parseErrors.length,
        sfiWarnings: sfiWarnings.length,
      },
    };
  }

  private diffAssetFields(
    current: AssetEntity,
    draft: Partial<CreateAssetDto>,
  ): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
    const out: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
    // List of fields to diff. Skip extras (jsonb) — it's merged, not
    // replaced, so a per-key diff would be noisy. Skip auto-populated
    // provenance flags too.
    const fields: Array<[keyof CreateAssetDto, keyof AssetEntity]> = [
      ['displayName', 'displayName'],
      ['sfiGroup', 'sfiGroup'],
      ['sfiSub', 'sfiSub'],
      ['sfiSubName', 'sfiSubName'],
      ['parentAssetId', 'parentAssetId'],
      ['servedByAssetId', 'servedByAssetId'],
      ['locationAssetId', 'locationAssetId'],
      ['brand', 'brand'],
      ['model', 'model'],
      ['serialNo', 'serialNo'],
      ['location', 'location'],
      ['rinaRef', 'rinaRef'],
      ['notes', 'notes'],
      ['zone', 'zone'],
      ['deckRole', 'deckRole'],
      ['spaceInstance', 'spaceInstance'],
      ['spaceLabel', 'spaceLabel'],
      ['drawingRef', 'drawingRef'],
      ['inspectionObligation', 'inspectionObligation'],
    ];
    for (const [draftKey, entityKey] of fields) {
      const next = (draft[draftKey] as unknown as string | undefined) ?? null;
      const cur = (current[entityKey] as unknown as string | null | undefined) ?? null;
      // null in draft means "missing in file" — we preserve current, no
      // change. Only diff when draft has a non-null new value.
      if (next === null) continue;
      if (String(next).trim() === String(cur ?? '').trim()) continue;
      out.push({
        field: String(draftKey),
        oldValue: cur === null ? null : String(cur),
        newValue: String(next),
      });
    }
    // Numbers
    if (
      draft.criticality !== undefined &&
      draft.criticality !== null &&
      draft.criticality !== current.criticality
    ) {
      out.push({
        field: 'criticality',
        oldValue: current.criticality?.toString() ?? null,
        newValue: draft.criticality.toString(),
      });
    }
    if (
      draft.deckLevel !== undefined &&
      draft.deckLevel !== null &&
      draft.deckLevel !== current.deckLevel
    ) {
      out.push({
        field: 'deckLevel',
        oldValue: current.deckLevel?.toString() ?? null,
        newValue: draft.deckLevel.toString(),
      });
    }
    return out;
  }

  /**
   * Save a JSONB snapshot of every asset for this ship. Returns the
   * snapshot id so callers can reference it in audit logs.
   */
  async createSnapshot(
    shipId: string,
    reason: string,
    userId: string | null,
  ): Promise<string> {
    const assets = await this.assetRepository.find({ where: { shipId } });
    const saved = await this.assetSnapshotRepository.save(
      this.assetSnapshotRepository.create({
        shipId,
        reason: reason.slice(0, 80),
        assetCount: assets.length,
        createdByUserId: userId,
        payload: assets,
      }),
    );
    return saved.id;
  }

  /**
   * Commit an import. The buffer is parsed AGAIN here (rather than
   * passed from preview) — keeps the API stateless and avoids storing
   * uploaded files between requests. The drafts go through the same
   * upsert as the legacy flow; orphan delete + rename merge happen in
   * the same transaction so the operation is all-or-nothing.
   */
  async commitImportFromXlsx(
    shipId: string,
    buffer: Buffer,
    opts: CommitImportDto,
    userId: string | null,
  ): Promise<ImportResultDto & { snapshotId: string | null; deleted: number; merged: number }> {
    await this.assertShipExists(shipId);

    let snapshotId: string | null = null;
    if (opts.snapshotBefore !== false) {
      // Default to TRUE — admins explicitly opt out, not opt in. The
      // table is cheap and the rollback option is precious.
      snapshotId = await this.createSnapshot(
        shipId,
        `pre-import (${new Date().toISOString().slice(0, 10)})`,
        userId,
      );
    }

    const { drafts, parseErrors, totalRows } = parseXlsxToDrafts(buffer);
    const result: ImportResultDto = {
      totalRows,
      inserted: 0,
      updated: 0,
      skipped: parseErrors.length,
      errors: parseErrors.map((e) => ({ row: e.row, reason: e.reason })),
    };

    // Compute renames + orphans BEFORE the upsert so we can act on them
    // after using the new-asset UUIDs.
    const existing = await this.assetRepository.find({ where: { shipId } });
    const existingByCode = new Map(existing.map((a) => [a.assetIdInternal, a]));
    const incomingCodes = new Set(drafts.map((d) => d.draft.assetIdInternal!));
    const orphansBefore = existing.filter((a) => !incomingCodes.has(a.assetIdInternal));

    const renames: Array<{ oldId: string; newCode: string }> = [];
    if (opts.mergeRenames) {
      const norm = lowerTrim;
      for (const o of orphansBefore) {
        if (!o.displayName) continue;
        for (const d of drafts) {
          if (existingByCode.has(d.draft.assetIdInternal!)) continue; // not a new create
          if (norm(d.draft.displayName) !== norm(o.displayName)) continue;
          renames.push({
            oldId: o.id,
            newCode: d.draft.assetIdInternal!,
          });
          break;
        }
      }
    }

    let mergedCount = 0;
    let deletedCount = 0;

    await this.assetRepository.manager.transaction(async (tx) => {
      const txRepo = tx.getRepository(AssetEntity);
      for (const { rowNum, draft } of drafts) {
        try {
          const existingRow = await txRepo.findOne({
            where: { shipId, assetIdInternal: draft.assetIdInternal },
          });
          if (existingRow) {
            this.applyDraftToExisting(existingRow, draft);
            await txRepo.save(existingRow);
            result.updated += 1;
          } else {
            await txRepo.save(
              txRepo.create({
                shipId,
                ...this.draftToCreatePayload(draft),
              }),
            );
            result.inserted += 1;
          }
        } catch (err) {
          result.errors.push({
            row: rowNum,
            sfiCode: draft.assetIdInternal,
            reason: (err as Error).message,
          });
          result.skipped += 1;
        }
      }

      // Renames — repoint metric bindings and asset_documents to the
      // new asset, then delete the old.
      for (const r of renames) {
        const newAsset = await txRepo.findOne({
          where: { shipId, assetIdInternal: r.newCode },
        });
        if (!newAsset) continue;
        await tx.getRepository(ShipMetricCatalogEntity)
          .createQueryBuilder()
          .update()
          .set({ boundAssetId: newAsset.id })
          .where('bound_asset_id = :old', { old: r.oldId })
          .execute();
        await tx.getRepository(AssetDocumentLinkEntity)
          .createQueryBuilder()
          .update()
          .set({ assetId: newAsset.id })
          .where('asset_id = :old', { old: r.oldId })
          .execute();
        await txRepo.delete({ id: r.oldId });
        mergedCount += 1;
      }

      // Orphan deletion. Skip orphans already merged via rename above.
      if (opts.deleteOrphans) {
        const mergedIds = new Set(renames.map((r) => r.oldId));
        const orphansToDelete = orphansBefore
          .filter((o) => !mergedIds.has(o.id))
          .map((o) => o.id);
        if (orphansToDelete.length > 0) {
          await txRepo
            .createQueryBuilder()
            .delete()
            .where('id IN (:...ids)', { ids: orphansToDelete })
            .execute();
          deletedCount = orphansToDelete.length;
        }
      }
    });

    return { ...result, snapshotId, deleted: deletedCount, merged: mergedCount };
  }

  /** Apply a parsed draft to an existing entity, preserving non-null
   * existing values when the draft is null. Extracted so the same
   * upsert logic is shared between preview-driven commit and the
   * legacy single-shot import path. */
  private applyDraftToExisting(
    existing: AssetEntity,
    draft: Partial<CreateAssetDto>,
  ): void {
    Object.assign(existing, {
      displayName: draft.displayName,
      sfiGroup: draft.sfiGroup ?? existing.sfiGroup,
      sfiGroupName: draft.sfiGroupName ?? existing.sfiGroupName,
      sfiSub: draft.sfiSub ?? existing.sfiSub,
      sfiSubName: draft.sfiSubName ?? existing.sfiSubName,
      drawingCode: draft.drawingCode ?? existing.drawingCode,
      parentAssetId: draft.parentAssetId ?? existing.parentAssetId,
      servedByAssetId: draft.servedByAssetId ?? existing.servedByAssetId,
      locationAssetId: draft.locationAssetId ?? existing.locationAssetId,
      brand: draft.brand ?? existing.brand,
      model: draft.model ?? existing.model,
      serialNo: draft.serialNo ?? existing.serialNo,
      criticality: draft.criticality ?? existing.criticality,
      commissionedDate: draft.commissionedDate ?? existing.commissionedDate,
      location: draft.location ?? existing.location,
      department: draft.department ?? existing.department,
      rinaRef: draft.rinaRef ?? existing.rinaRef,
      notes: draft.notes ?? existing.notes,
      zone: draft.zone ?? existing.zone,
      deckRole: draft.deckRole ?? existing.deckRole,
      deckLevel: draft.deckLevel ?? existing.deckLevel,
      spaceInstance: draft.spaceInstance ?? existing.spaceInstance,
      spaceLabel: draft.spaceLabel ?? existing.spaceLabel,
      drawingRef: draft.drawingRef ?? existing.drawingRef,
      inspectionObligation:
        draft.inspectionObligation ?? existing.inspectionObligation,
      parentAutoPopulated:
        draft.parentAutoPopulated ?? existing.parentAutoPopulated,
      criticalityAutoPopulated:
        draft.criticalityAutoPopulated ?? existing.criticalityAutoPopulated,
      sourceSheet: draft.sourceSheet ?? existing.sourceSheet,
      extras: draft.extras
        ? { ...(existing.extras ?? {}), ...draft.extras }
        : existing.extras,
    });
  }

  private draftToCreatePayload(draft: Partial<CreateAssetDto>): Partial<AssetEntity> {
    return {
      assetIdInternal: draft.assetIdInternal,
      displayName: draft.displayName,
      sfiGroup: draft.sfiGroup,
      sfiSub: draft.sfiSub,
      sfiSubName: draft.sfiSubName,
      parentAssetId: draft.parentAssetId,
      servedByAssetId: draft.servedByAssetId,
      locationAssetId: draft.locationAssetId,
      brand: draft.brand,
      model: draft.model,
      serialNo: draft.serialNo,
      criticality: draft.criticality,
      commissionedDate: draft.commissionedDate,
      location: draft.location,
      rinaRef: draft.rinaRef,
      notes: draft.notes,
      zone: draft.zone,
      deckRole: draft.deckRole,
      deckLevel: draft.deckLevel,
      spaceInstance: draft.spaceInstance,
      spaceLabel: draft.spaceLabel,
      drawingRef: draft.drawingRef,
      inspectionObligation: draft.inspectionObligation,
      parentAutoPopulated: draft.parentAutoPopulated,
      criticalityAutoPopulated: draft.criticalityAutoPopulated,
      sourceSheet: draft.sourceSheet,
      extras: draft.extras,
    };
  }

  /**
   * Legacy single-shot import — preserved for backward compat with the
   * existing controller route. Behaves like a commit with all flags
   * defaulted (snapshot=true, deleteOrphans=false, mergeRenames=false).
   */
  async importFromXlsx(
    shipId: string,
    buffer: Buffer,
  ): Promise<ImportResultDto> {
    const out = await this.commitImportFromXlsx(
      shipId,
      buffer,
      { snapshotBefore: true },
      null,
    );
    return {
      totalRows: out.totalRows,
      inserted: out.inserted,
      updated: out.updated,
      skipped: out.skipped,
      errors: out.errors,
    };
  }


  // ── Service rules (PMS core) ─────────────────────────────────────────────

  async listServiceRules(
    shipId: string,
    assetUuid: string,
  ): Promise<ServiceRuleEntity[]> {
    await this.getOne(shipId, assetUuid); // asserts ship + asset
    return this.serviceRuleRepository.find({
      where: { shipId, assetId: assetUuid },
      order: { taskName: 'ASC' },
    });
  }

  async createServiceRule(
    shipId: string,
    assetUuid: string,
    dto: CreateServiceRuleDto,
  ): Promise<ServiceRuleEntity> {
    await this.getOne(shipId, assetUuid);
    if (dto.intervalHours == null && dto.intervalMonths == null) {
      throw new BadRequestException(
        'At least one of intervalHours / intervalMonths is required',
      );
    }
    const existing = await this.serviceRuleRepository.findOne({
      where: { assetId: assetUuid, taskName: dto.taskName },
    });
    if (existing) {
      throw new ConflictException(
        `Rule "${dto.taskName}" already exists for this asset`,
      );
    }
    return this.serviceRuleRepository.save(
      this.serviceRuleRepository.create({
        shipId,
        assetId: assetUuid,
        taskName: dto.taskName,
        intervalHours: dto.intervalHours ?? null,
        intervalMonths: dto.intervalMonths ?? null,
        lastDoneAt: dto.lastDoneAt ? new Date(dto.lastDoneAt) : null,
        lastDoneRuntimeHours: dto.lastDoneRuntimeHours ?? null,
        source: dto.source ?? 'manual',
        notes: dto.notes ?? null,
      }),
    );
  }

  async updateServiceRule(
    shipId: string,
    ruleId: string,
    dto: UpdateServiceRuleDto,
  ): Promise<ServiceRuleEntity> {
    const rule = await this.serviceRuleRepository.findOne({
      where: { id: ruleId, shipId },
    });
    if (!rule) throw new NotFoundException(`Service rule ${ruleId} not found`);
    if (dto.taskName !== undefined) rule.taskName = dto.taskName;
    if (dto.intervalHours !== undefined) rule.intervalHours = dto.intervalHours;
    if (dto.intervalMonths !== undefined) rule.intervalMonths = dto.intervalMonths;
    if (dto.lastDoneAt !== undefined) {
      rule.lastDoneAt = dto.lastDoneAt ? new Date(dto.lastDoneAt) : null;
    }
    if (dto.lastDoneRuntimeHours !== undefined) {
      rule.lastDoneRuntimeHours = dto.lastDoneRuntimeHours;
    }
    if (dto.notes !== undefined) rule.notes = dto.notes;
    if (rule.intervalHours == null && rule.intervalMonths == null) {
      throw new BadRequestException(
        'Rule must keep at least one of intervalHours / intervalMonths',
      );
    }
    // Any manual edit confirms the rule — clear the ai_extracted flag so
    // it counts as human-verified from here on.
    rule.source = 'manual';
    return this.serviceRuleRepository.save(rule);
  }

  /** "Mark done": stamps the completion baseline. */
  async completeServiceRule(
    shipId: string,
    ruleId: string,
    dto: CompleteServiceRuleDto,
  ): Promise<ServiceRuleEntity> {
    const rule = await this.serviceRuleRepository.findOne({
      where: { id: ruleId, shipId },
    });
    if (!rule) throw new NotFoundException(`Service rule ${ruleId} not found`);
    rule.lastDoneAt = dto.doneAt ? new Date(dto.doneAt) : new Date();
    if (dto.runtimeHours !== undefined) {
      rule.lastDoneRuntimeHours = dto.runtimeHours;
    }
    if (dto.notes) {
      rule.notes = rule.notes
        ? `${rule.notes}\n[done ${rule.lastDoneAt.toISOString().slice(0, 10)}] ${dto.notes}`
        : `[done ${rule.lastDoneAt.toISOString().slice(0, 10)}] ${dto.notes}`;
    }
    return this.serviceRuleRepository.save(rule);
  }

  async deleteServiceRule(shipId: string, ruleId: string): Promise<void> {
    const rule = await this.serviceRuleRepository.findOne({
      where: { id: ruleId, shipId },
    });
    if (!rule) throw new NotFoundException(`Service rule ${ruleId} not found`);
    await this.serviceRuleRepository.remove(rule);
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async assertShipExists(shipId: string): Promise<void> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }
  }
}
