import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ComplianceDocMasterEntity } from './entities/compliance-doc-master.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceDocEntity } from './entities/compliance-doc.entity';
import { DocAssetLinkEntity } from './entities/doc-asset-link.entity';
import { AssetEntity } from '../assets/entities/asset.entity';
import { PmsModule } from '../pms/pms.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { ComplianceExtractionService } from './compliance-extraction.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ComplianceDocTypeEntity,
      ComplianceDocEntity,
      ComplianceDocMasterEntity,
      DocAssetLinkEntity,
      AssetEntity,
      ShipEntity,
    ]),
    PmsModule,
    IntegrationsModule,
  ],
  controllers: [ComplianceController],
  providers: [ComplianceService, ComplianceExtractionService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
