import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ChatMessageRole } from '../enums/chat-message-role.enum';
import { ChatSessionEntity } from './chat-session.entity';

@Entity('chat_messages')
export class ChatMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @ManyToOne(() => ChatSessionEntity, (session) => session.messages, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'session_id' })
  session!: ChatSessionEntity;

  @Column({ type: 'enum', enum: ChatMessageRole })
  role!: ChatMessageRole;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'ragflow_context', type: 'jsonb', nullable: true })
  ragflowContext!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date | null;
}
