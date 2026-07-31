import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PmsTaskEntity } from '../pms/entities/pms-task.entity';
import { ComplianceEventsService } from './compliance-events.service';
import { ComplianceDocEntity } from './entities/compliance-doc.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceEventEntity } from './entities/compliance-event.entity';
import { ComplianceTypeRelationEntity } from './entities/compliance-type-relation.entity';
import { DocAssetLinkEntity } from './entities/doc-asset-link.entity';

/**
 * Deliberately its own module with ENTITY imports only — no PmsModule, no
 * ComplianceModule. The producers live in ShipsModule and AssetsModule, and
 * routing them through ComplianceModule closes the loop
 * Ships → Compliance → Pms → Crew → Users → Ships that killed the boot
 * (UndefinedModuleException in CrewModule, 2026-08-01). Keeping this module
 * leaf-shaped means anyone may import it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ComplianceEventEntity,
      ComplianceTypeRelationEntity,
      ComplianceDocTypeEntity,
      ComplianceDocEntity,
      DocAssetLinkEntity,
      PmsTaskEntity,
    ]),
  ],
  providers: [ComplianceEventsService],
  exports: [ComplianceEventsService],
})
export class ComplianceEventsModule {}
