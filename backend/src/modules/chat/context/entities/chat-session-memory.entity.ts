import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChatSessionEntity } from '../../entities/chat-session.entity';

@Entity('chat_session_memories')
export class ChatSessionMemoryEntity {
  @PrimaryColumn({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @OneToOne(() => ChatSessionEntity, (session) => session.memory, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'session_id' })
  session!: ChatSessionEntity;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ name: 'covered_message_count', type: 'integer', default: 0 })
  coveredMessageCount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
