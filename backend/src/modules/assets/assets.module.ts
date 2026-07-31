import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ComplianceEventsModule } from '../compliance/compliance-events.module';
import { DocumentEntity } from '../documents/entities/document.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetIdService } from './asset-id.service';
import { AssetImportService } from './asset-import.service';
import { AssetLinksService } from './asset-links.service';
import { AssetServiceRulesService } from './asset-service-rules.service';
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
    // v60 Phase 4: replacing a unit (brand/model/serial change) produces an
    // equipment_replaced compliance event. Leaf-shaped events module —
    // see ComplianceEventsModule on why not the full ComplianceModule.
    ComplianceEventsModule,
  ],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    AssetIdService,
    AssetImportService,
    AssetLinksService,
    AssetServiceRulesService,
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
