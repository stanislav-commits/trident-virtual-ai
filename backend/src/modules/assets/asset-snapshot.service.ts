import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetSnapshotEntity } from './entities/asset-snapshot.entity';
import { AssetEntity } from './entities/asset.entity';

/**
 * A copy of the whole register, taken before anything destructive.
 *
 * Its own service because both callers — the bulk import and "clear all" —
 * are the operations that can lose the most work in one click, and neither
 * should have to reach into the other to take the copy.
 */
@Injectable()
export class AssetSnapshotService {
  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetSnapshotEntity)
    private readonly assetSnapshotRepository: Repository<AssetSnapshotEntity>,
  ) {}

  /**
   * Save a JSONB snapshot of every asset for this ship. Returns the snapshot
   * id so callers can reference it in audit logs.
   */
  async create(
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
}
