import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { BulkUpdateAssetsDto } from './dto/bulk-update.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { AssetSnapshotEntity } from './entities/asset-snapshot.entity';
import { AssetEntity } from './entities/asset.entity';
import { AssetIdService } from './asset-id.service';
import {
  isValidDeckRoleCode,
  isValidZoneCode,
} from './enums/asset-location-vocab';
import { AdminEventBus } from '../admin-events/admin-event.bus';
import { AssetSnapshotService } from './asset-snapshot.service';
import {
  buildRegisterWorkbook,
  naturalCompareIds,
} from './asset-xlsx.codec';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(AssetSnapshotEntity)
    private readonly assetSnapshotRepository: Repository<AssetSnapshotEntity>,
    private readonly assetIdService: AssetIdService,
    private readonly adminEvents: AdminEventBus,
    private readonly snapshots: AssetSnapshotService,
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
    const snapshotId = await this.snapshots.create(
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

  private async assertShipExists(shipId: string): Promise<void> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }
  }
}
