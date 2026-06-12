import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ComplianceDocMasterEntity } from './entities/compliance-doc-master.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceDocEntity } from './entities/compliance-doc.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ComplianceDocTypeEntity,
      ComplianceDocEntity,
      ComplianceDocMasterEntity,
      ShipEntity,
    ]),
  ],
  controllers: [ComplianceController],
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
