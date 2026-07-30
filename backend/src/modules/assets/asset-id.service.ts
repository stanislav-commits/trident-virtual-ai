import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AssetEntity } from './entities/asset.entity';

/**
 * Register numbering: SWX.<group>.<sub>.<seq>, e.g. SWX.4.1.05.
 *
 * The sequence is dense — 93 of 96 sub-groups on the production register run
 * 01..N with no holes — which is what makes "insert at 05" a meaningful request
 * rather than "pick the next free number".
 */
const ID_PATTERN = /^([A-Za-z0-9]+\.\d+\.\d+)\.(\d+)([A-Za-z-]*)$/;

export interface ParsedAssetId {
  /** Everything before the sequence, e.g. "SWX.4.1". */
  subPrefix: string;
  seq: number;
  /** Trailing qualifier some ids carry after the number, e.g. "-PS". */
  suffix: string;
  /** Width of the printed sequence, so 05 does not become 5. */
  width: number;
}

/** The three columns that point at another asset BY ITS PRINTED ID, not by uuid. */
const REFERENCE_COLUMNS = [
  'parent_asset_id',
  'served_by_asset_id',
  'location_asset_id',
] as const;

export interface IdAvailability {
  assetIdInternal: string;
  free: boolean;
  /** The asset sitting on this id, when it is taken. */
  occupiedBy: { id: string; displayName: string } | null;
  /** What "insert here" would do: these ids each move up by one. */
  shift: {
    subPrefix: string;
    affected: number;
    /** Human preview, e.g. "SWX.4.1.05 → SWX.4.1.06 … SWX.4.1.62 → SWX.4.1.63". */
    firstMove: string | null;
    lastMove: string | null;
    /** References that get rewritten along with the ids. */
    referencesRewritten: number;
  } | null;
}

/**
 * Everything about the printed asset id: parsing it, telling a caller whether it
 * is free, and inserting into the middle of a sub-group by moving the rest up.
 *
 * Kept apart from AssetsService because the shift is the only operation in the
 * register that rewrites identifiers other rows point at, and it must be read
 * as one piece to be trusted.
 */
@Injectable()
export class AssetIdService {
  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
  ) {}

  static parse(assetIdInternal: string): ParsedAssetId | null {
    const m = ID_PATTERN.exec(assetIdInternal.trim());
    if (!m) return null;
    return {
      subPrefix: m[1],
      seq: Number.parseInt(m[2], 10),
      suffix: m[3] ?? '',
      width: m[2].length,
    };
  }

  static format(parsed: ParsedAssetId, seq: number): string {
    return `${parsed.subPrefix}.${String(seq).padStart(parsed.width, '0')}${parsed.suffix}`;
  }

  /**
   * Is this id free, and if not, what would inserting here cost?
   *
   * Answered before the operator commits, because the two ways out of a
   * collision — take the row over, or push the rest of the sub-group up — are
   * not interchangeable and the second one touches other rows.
   */
  async checkAvailability(
    shipId: string,
    assetIdInternal: string,
  ): Promise<IdAvailability> {
    const wanted = assetIdInternal.trim();
    const occupant = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal: wanted },
      select: { id: true, displayName: true },
    });

    if (!occupant) {
      return { assetIdInternal: wanted, free: true, occupiedBy: null, shift: null };
    }

    const parsed = AssetIdService.parse(wanted);
    if (!parsed) {
      // A hand-written id outside the numbering scheme can still be replaced;
      // there is simply no sequence to shift.
      return {
        assetIdInternal: wanted,
        free: false,
        occupiedBy: { id: occupant.id, displayName: occupant.displayName },
        shift: null,
      };
    }

    const moving = await this.movingRows(shipId, parsed);
    const renames = this.renameMap(parsed, moving);
    const referencesRewritten = await this.countReferences(
      shipId,
      [...renames.keys()],
    );

    const first = moving[0];
    const last = moving[moving.length - 1];
    return {
      assetIdInternal: wanted,
      free: false,
      occupiedBy: { id: occupant.id, displayName: occupant.displayName },
      shift: {
        subPrefix: parsed.subPrefix,
        affected: moving.length,
        firstMove: first
          ? `${first.assetIdInternal} → ${renames.get(first.assetIdInternal)}`
          : null,
        lastMove: last
          ? `${last.assetIdInternal} → ${renames.get(last.assetIdInternal)}`
          : null,
        referencesRewritten,
      },
    };
  }

  /**
   * Free up `assetIdInternal` by moving it and everything after it one place up.
   *
   * Renumbering runs from the highest sequence down: the ids are unique per
   * ship, so moving 05 to 06 before 06 has left would collide. The printed id
   * is also how three columns point at an asset, so those are rewritten in the
   * same transaction — 174 rows on production carry a served_by reference, and
   * a shift that ignored them would quietly break every one it touched.
   */
  async shiftUp(
    manager: EntityManager,
    shipId: string,
    assetIdInternal: string,
  ): Promise<{ moved: number; referencesRewritten: number }> {
    const parsed = AssetIdService.parse(assetIdInternal);
    if (!parsed) {
      throw new BadRequestException(
        `"${assetIdInternal}" is not a numbered register id, so there is nothing to shift.`,
      );
    }

    const repo = manager.getRepository(AssetEntity);
    const moving = await this.movingRows(shipId, parsed, manager);
    if (!moving.length) return { moved: 0, referencesRewritten: 0 };

    const renames = this.renameMap(parsed, moving);

    // Highest first — see the method comment.
    for (const row of [...moving].reverse()) {
      const next = renames.get(row.assetIdInternal);
      if (!next) continue;
      await repo.update({ id: row.id }, { assetIdInternal: next });
    }

    // One statement per column, not one per rename: applied as a sequence of
    // updates the renames chase each other (05→06 lands a row on 06, then the
    // 06→07 pass moves that same row again) and every reference ends up on the
    // last id in the sub-group. A single CASE decides each row exactly once.
    const froms = [...renames.keys()];
    const cases = froms
      .map((_, i) => `WHEN :from${i} THEN :to${i}`)
      .join(' ');
    const params: Record<string, string> = { shipId };
    froms.forEach((from, i) => {
      params[`from${i}`] = from;
      params[`to${i}`] = renames.get(from) as string;
    });

    let referencesRewritten = 0;
    for (const column of REFERENCE_COLUMNS) {
      const result = await manager
        .createQueryBuilder()
        .update(AssetEntity)
        .set({
          [this.propertyFor(column)]: () => `CASE ${column} ${cases} END`,
        })
        .where('ship_id = :shipId')
        .andWhere(`${column} IN (:...froms)`, { froms })
        .setParameters(params)
        .execute();
      referencesRewritten += result.affected ?? 0;
    }

    return { moved: moving.length, referencesRewritten };
  }

  /** Rows at or after the requested sequence, in the same sub-group, ascending. */
  private async movingRows(
    shipId: string,
    parsed: ParsedAssetId,
    manager?: EntityManager,
  ): Promise<AssetEntity[]> {
    const repo = manager
      ? manager.getRepository(AssetEntity)
      : this.assetRepository;
    const rows = await repo
      .createQueryBuilder('a')
      .where('a.ship_id = :shipId', { shipId })
      .andWhere('a.asset_id_internal LIKE :head', {
        head: `${parsed.subPrefix}.%`,
      })
      .getMany();

    return rows
      .map((row) => ({ row, parsed: AssetIdService.parse(row.assetIdInternal) }))
      .filter(
        (x): x is { row: AssetEntity; parsed: ParsedAssetId } =>
          x.parsed !== null &&
          x.parsed.subPrefix === parsed.subPrefix &&
          x.parsed.seq >= parsed.seq,
      )
      .sort((a, b) => a.parsed.seq - b.parsed.seq)
      .map((x) => x.row);
  }

  /** old printed id → new printed id, for the rows being moved. */
  private renameMap(
    parsed: ParsedAssetId,
    moving: AssetEntity[],
  ): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of moving) {
      const rowParsed = AssetIdService.parse(row.assetIdInternal);
      if (!rowParsed) continue;
      out.set(
        row.assetIdInternal,
        AssetIdService.format(rowParsed, rowParsed.seq + 1),
      );
    }
    return out;
  }

  private async countReferences(
    shipId: string,
    ids: string[],
  ): Promise<number> {
    if (!ids.length) return 0;
    const conditions = REFERENCE_COLUMNS.map(
      (column) => `${column} IN (:...ids)`,
    ).join(' OR ');
    const [{ count }]: Array<{ count: string }> = await this.assetRepository
      .createQueryBuilder('a')
      .select('COUNT(*)', 'count')
      .where('a.ship_id = :shipId', { shipId })
      .andWhere(`(${conditions})`, { ids })
      .getRawMany();
    return Number(count ?? 0);
  }

  private propertyFor(column: (typeof REFERENCE_COLUMNS)[number]): string {
    switch (column) {
      case 'parent_asset_id':
        return 'parentAssetId';
      case 'served_by_asset_id':
        return 'servedByAssetId';
      case 'location_asset_id':
        return 'locationAssetId';
    }
  }
}
