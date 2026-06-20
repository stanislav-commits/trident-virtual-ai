import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryItemEntity } from './entities/inventory-item.entity';
import { InventoryItemAssetEntity } from './entities/inventory-item-asset.entity';
import { InventoryItemTaskEntity } from './entities/inventory-item-task.entity';
import { AssetEntity } from '../assets/entities/asset.entity';
import { PmsTaskEntity } from '../pms/entities/pms-task.entity';
import { IntegrationsModule } from '../../integrations/integrations.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryItemEntity,
      InventoryItemAssetEntity,
      InventoryItemTaskEntity,
      AssetEntity,
      PmsTaskEntity,
    ]),
    IntegrationsModule,
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
