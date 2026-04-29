import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatTurnResponderKind } from './chat-turn-responder-kind.enum';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';
import { ChatSemanticRouteDecision } from '../routing/chat-semantic-router.types';

export interface ChatTurnPlanAsk {
  id: string;
  intent: ChatTurnIntent;
  responder: ChatTurnResponderKind;
  question: string;
  capabilityEnabled: boolean;
  capabilityLabel: string;
  timeMode: ChatMetricsAskTimeMode | null;
  timestamp: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  semanticRoute: ChatSemanticRouteDecision;
}

export interface ChatTurnPlan {
  asks: ChatTurnPlanAsk[];
  responseLanguage: string | null;
  reasoning: string;
}
