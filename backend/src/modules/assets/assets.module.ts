import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from '../documents/entities/document.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetIdService } from './asset-id.service';
import { AssetImportService } from './asset-import.service';
import { AssetLinksService } from './asset-links.service';
import { AssetSnapshotService } from './asset-snapshot.service';
import { AssetDocumentLinkEntity } from './entities/asset-document-link.entity';
import { AssetSnapshotEntity } from './entities/asset-snapshot.entity';
import { AssetEntity } from './entities/asset.entity';
import { ServiceRuleEntity } from './entities/service-rule.entity';
import { SfiModule } from '../sfi/sfi.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssetEntity,
      AssetDocumentLinkEntity,
      AssetSnapshotEntity,
      ServiceRuleEntity,
      ShipEntity,
      ShipMetricCatalogEntity,
      DocumentEntity,
    ]),
    SfiModule,
  ],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    AssetIdService,
    AssetImportService,
    AssetLinksService,
    AssetSnapshotService,
  ],
  exports: [
    AssetsService,
    AssetIdService,
    AssetImportService,
    AssetLinksService,
  ],
})
export class AssetsModule {}
