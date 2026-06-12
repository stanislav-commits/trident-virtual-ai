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

  /**
   * Compliance profile — drives which rows of compliance_doc_master apply
   * to this vessel. gt_bucket: lt24 | 24_300 | 300_399 | 400_499 |
   * 500_3000 | gt3000. operation_type: private | commercial.
   * flag_registry: red_ensign | eu | other (nullable = not factored in).
   */
  @Column({ name: 'gt_bucket', type: 'varchar', length: 20, nullable: true })
  gtBucket!: string | null;

  @Column({ name: 'operation_type', type: 'varchar', length: 20, nullable: true })
  operationType!: string | null;

  @Column({ name: 'flag_registry', type: 'varchar', length: 30, nullable: true })
  flagRegistry!: string | null;

  @Column({ name: 'mmsi', type: 'varchar', length: 20, nullable: true })
  mmsi!: string | null;

  @Column({ name: 'call_sign', type: 'varchar', length: 20, nullable: true })
  callSign!: string | null;

  @Column({ name: 'flag', type: 'varchar', length: 80, nullable: true })
  flag!: string | null;

  @Column({ name: 'length_m', type: 'numeric', precision: 6, scale: 2, nullable: true })
  lengthM!: string | null;

  @Column({ name: 'gross_tonnage', type: 'int', nullable: true })
  grossTonnage!: number | null;

  @Column({ name: 'shipyard', type: 'varchar', length: 120, nullable: true })
  shipyard!: string | null;

  @Column({ name: 'class_society', type: 'varchar', length: 120, nullable: true })
  classSociety!: string | null;

  @Column({ name: 'home_port', type: 'varchar', length: 120, nullable: true })
  homePort!: string | null;

  @Column({ name: 'fleet_manager_email', type: 'varchar', length: 160, nullable: true })
  fleetManagerEmail!: string | null;

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
