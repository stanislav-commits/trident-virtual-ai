import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChatSessionMemoryEntity } from '../context/entities/chat-session-memory.entity';
import { ShipEntity } from '../../ships/entities/ship.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { ChatMessageEntity } from './chat-message.entity';

@Entity('chat_sessions')
export class ChatSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title!: string | null;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, (user) => user.chatSessions, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({ name: 'ship_id', type: 'uuid', nullable: true })
  shipId!: string | null;

  @ManyToOne(() => ShipEntity, (ship) => ship.chatSessions, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'ship_id' })
  ship!: ShipEntity | null;

  @Column({ name: 'pinned_at', type: 'timestamptz', nullable: true })
  pinnedAt!: Date | null;

  @OneToMany(() => ChatMessageEntity, (message) => message.session)
  messages!: ChatMessageEntity[];

  @OneToOne(() => ChatSessionMemoryEntity, (memory) => memory.session)
  memory!: ChatSessionMemoryEntity | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date | null;
}
