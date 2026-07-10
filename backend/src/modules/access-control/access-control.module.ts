import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrewMemberEntity } from '../crew/entities/crew-member.entity';
import { UserEntity } from '../users/entities/user.entity';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';
import { AccessMatrixCellEntity } from './entities/access-matrix-cell.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccessMatrixCellEntity,
      CrewMemberEntity,
      UserEntity,
    ]),
  ],
  controllers: [AccessControlController],
  providers: [AccessControlService],
  exports: [AccessControlService],
})
export class AccessControlModule {}
