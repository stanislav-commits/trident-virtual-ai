import { ChatMessageEntity } from '../entities/chat-message.entity';
import { ChatSessionEntity } from '../entities/chat-session.entity';

export interface ChatConversationContext {
  session: ChatSessionEntity;
  allMessages: ChatMessageEntity[];
  recentMessages: ChatMessageEntity[];
  latestUserMessage: ChatMessageEntity | null;
  summary: string | null;
  coveredMessageCount: number;
}
