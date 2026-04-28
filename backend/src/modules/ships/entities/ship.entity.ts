import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChatSessionEntity } from '../../chat/entities/chat-session.entity';
import { UserEntity } from '../../users/entities/user.entity';

@Check(`"build_year" IS NULL OR ("build_year" >= 1800 AND "build_year" <= 3000)`)
@Entity('ships')
export class ShipEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({
    name: 'organization_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  organizationName!: string | null;

  @Column({
    name: 'imo_number',
    type: 'varchar',
    length: 7,
    nullable: true,
  })
  imoNumber!: string | null;

  @Column({
    name: 'build_year',
    type: 'integer',
    nullable: true,
  })
  buildYear!: number | null;

  @Column({
    name: 'ragflow_dataset_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  ragflowDatasetId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => UserEntity, (user) => user.ship)
  users!: UserEntity[];

  @OneToMany(() => ChatSessionEntity, (session) => session.ship)
  chatSessions!: ChatSessionEntity[];
}
