import { ChatV2PendingClarification } from '../clarification/chat-v2-clarification.types';

export type ChatV2ConversationRole = 'user' | 'assistant' | 'system';

export interface ChatV2ConversationMessage {
  role: ChatV2ConversationRole;
  content: string;
  ragflowContext?: unknown;
}

export interface ChatV2TurnContext {
  sessionId: string;
  shipId?: string;
  shipName?: string;
  shipOrganizationName?: string;
  userQuery: string;
  messageHistory: ChatV2ConversationMessage[];
  previousMessages: ChatV2ConversationMessage[];
  latestAssistantLlmResponseId?: string;
  latestUserMessageBeforeCurrent?: ChatV2ConversationMessage;
  latestAssistantMessageBeforeCurrent?: ChatV2ConversationMessage;
  activeClarification?: ChatV2PendingClarification;
}
