import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SfiTaxonomyEntity } from './entities/sfi-taxonomy.entity';
import { SfiService } from './sfi.service';
import { SfiController } from './sfi.controller';

@Module({
  imports: [TypeOrmModule.forFeature([SfiTaxonomyEntity])],
  controllers: [SfiController],
  providers: [SfiService],
  exports: [SfiService],
})
export class SfiModule {}
