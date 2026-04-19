import { ChatMessageEntity } from '../../entities/chat-message.entity';
import { ChatSessionEntity } from '../../entities/chat-session.entity';
import { ChatConversationContext } from '../../context/chat-conversation-context.types';
import { ChatTurnPlan } from '../../planning/chat-turn-plan.types';

export interface ChatTurnResponderInput {
  plan: ChatTurnPlan;
  session: ChatSessionEntity;
  messages: ChatMessageEntity[];
  context: ChatConversationContext;
}

export interface ChatTurnResponderOutput {
  content: string;
  ragflowContext?: Record<string, unknown> | null;
}
