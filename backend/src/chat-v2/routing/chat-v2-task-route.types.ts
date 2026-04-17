export type ChatV2TaskDomain =
  | 'chat_history'
  | 'general_web'
  | 'ship_task'
  | 'unknown';

export type ChatV2HistoryIntent =
  | 'latest_user_message_before_current'
  | 'latest_assistant_message_before_current'
  | 'previous_user_question_before_current'
  | 'conversation_summary'
  | 'unknown';

export interface ChatV2TaskRoute {
  domain: ChatV2TaskDomain;
  confidence: number;
  shipRelated: boolean;
  needsFreshExternalData: boolean;
  reason: string;
  historyIntent?: ChatV2HistoryIntent;
  webSearchQuery?: string;
}
