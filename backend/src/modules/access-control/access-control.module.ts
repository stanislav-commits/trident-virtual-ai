import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrewMemberEntity } from '../crew/entities/crew-member.entity';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';
import { AccessMatrixCellEntity } from './entities/access-matrix-cell.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AccessMatrixCellEntity, CrewMemberEntity]),
  ],
  controllers: [AccessControlController],
  providers: [AccessControlService],
  exports: [AccessControlService],
})
export class AccessControlModule {}
