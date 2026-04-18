import {
  PendingClarification,
  PendingClarificationDomain,
  PendingClarificationKind,
  PendingClarificationOption,
} from '../../chat-shared/clarification/pending-clarification.types';
import { ChatV2TurnClassification } from '../chat-v2.types';

export type ChatV2PendingClarificationDomain = PendingClarificationDomain;
export type ChatV2PendingClarificationKind = PendingClarificationKind;
export type ChatV2PendingClarificationOption = PendingClarificationOption;
export type ChatV2PendingClarification = PendingClarification;

export type ChatV2ClarificationContinuationIntent =
  | 'show_options'
  | 'select_option'
  | 'new_request'
  | 'unknown';

export interface ChatV2ClarificationContinuationDecision {
  intent: ChatV2ClarificationContinuationIntent;
  selectedOptionId?: string | null;
  reason: string;
}

export interface ChatV2ClarificationContinuationResult {
  handled: boolean;
  draft?: {
    content: string;
    classification: ChatV2TurnClassification;
    answerRoute: 'metrics_v2';
    usedLlm: boolean;
    usedCurrentTelemetry?: boolean;
    usedHistoricalTelemetry?: boolean;
    sourceOfTruth: 'current_metrics' | 'historical_metrics' | 'mixed_metrics';
    extraContext?: Record<string, unknown>;
  };
}
