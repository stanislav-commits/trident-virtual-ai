import { ChatMessageEntity } from '../../entities/chat-message.entity';
import { ChatSessionEntity } from '../../entities/chat-session.entity';
import { ChatConversationContext } from '../../context/chat-conversation-context.types';
import { ChatTurnPlan, ChatTurnPlanAsk } from '../../planning/chat-turn-plan.types';

export interface ChatTurnResponderInput {
  plan: ChatTurnPlan;
  ask: ChatTurnPlanAsk;
  session: ChatSessionEntity;
  messages: ChatMessageEntity[];
  context: ChatConversationContext;
}

export interface ChatTurnAskResult {
  askId: string;
  intent: string;
  responder: string;
  question: string;
  capabilityEnabled: boolean;
  capabilityLabel: string;
  summary: string;
  data?: Record<string, unknown> | null;
  contextReferences?: unknown[];
}

export interface ChatTurnResponderOutput extends ChatTurnAskResult {}
