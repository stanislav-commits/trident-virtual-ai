import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { buildVesselContextString } from '../../common/vessel-context.util';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ShipEntity } from './entities/ship.entity';

/**
 * NestJS-friendly wrapper around the pure `buildVesselContextString` helper.
 * Both this and `MetricAnalyzerResponderService` reuse the same util to avoid
 * code duplication while staying clear of a metrics ↔ ships circular dep.
 */
@Injectable()
export class ShipContextService {
  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
  ) {}

  buildContextString(shipId: string): Promise<string | null> {
    return buildVesselContextString(
      this.shipRepository,
      this.assetRepository,
      shipId,
    );
  }
}
