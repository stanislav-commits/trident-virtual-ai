import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../../../common/enums/user-role.enum';
import { ChatSessionEntity } from '../../chat/entities/chat-session.entity';
import { ShipEntity } from '../../ships/entities/ship.entity';

@Check(`("role" = 'admin' AND "ship_id" IS NULL) OR ("role" = 'user' AND "ship_id" IS NOT NULL)`)
@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'varchar', length: 100, unique: true })
  userId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role!: UserRole;

  @Column({ name: 'ship_id', type: 'uuid', nullable: true })
  shipId!: string | null;

  @ManyToOne(() => ShipEntity, (ship) => ship.users, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'ship_id' })
  ship!: ShipEntity | null;

  @OneToMany(() => ChatSessionEntity, (session) => session.user)
  chatSessions!: ChatSessionEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
