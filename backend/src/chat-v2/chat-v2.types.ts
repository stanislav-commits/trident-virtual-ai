import { ChatCitation } from '../chat-shared/chat.types';
import { ChatV2TaskRoute } from './routing/chat-v2-task-route.types';

export type ChatV2TurnKind = 'small_talk' | 'task_request';

export type ChatV2LanguageHint = string | null;

export interface ChatV2TurnClassification {
  kind: ChatV2TurnKind;
  confidence: number;
  language: ChatV2LanguageHint;
  reason: string;
  userTask?: string;
}

export type ChatV2AnswerRoute =
  | 'small_talk'
  | 'chat_history'
  | 'general_web'
  | 'metrics_v2'
  | 'ship_task_placeholder'
  | 'unknown_task'
  | 'error_fallback';

export type ChatV2SourceOfTruth =
  | 'small_talk'
  | 'chat_history'
  | 'web_search'
  | 'current_metrics'
  | 'historical_metrics'
  | 'mixed_metrics'
  | 'ship_task_placeholder'
  | 'unknown';

export interface ChatV2AssistantDraft {
  content: string;
  answerRoute: ChatV2AnswerRoute;
  classification: ChatV2TurnClassification;
  taskRoute?: ChatV2TaskRoute;
  usedLlm: boolean;
  usedChatHistory?: boolean;
  usedWebSearch?: boolean;
  usedChatHistorySummary?: boolean;
  usedCurrentTelemetry?: boolean;
  usedHistoricalTelemetry?: boolean;
  sourceOfTruth: ChatV2SourceOfTruth;
  contextReferences?: ChatCitation[];
  extraContext?: Record<string, unknown>;
}
