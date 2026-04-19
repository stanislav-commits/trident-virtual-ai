import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatTurnResponderKind } from './chat-turn-responder-kind.enum';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';

export interface ChatTurnPlanAsk {
  id: string;
  intent: ChatTurnIntent;
  responder: ChatTurnResponderKind;
  question: string;
  capabilityEnabled: boolean;
  capabilityLabel: string;
  timeMode: ChatMetricsAskTimeMode | null;
  timestamp: string | null;
}

export interface ChatTurnPlan {
  asks: ChatTurnPlanAsk[];
  responseLanguage: string | null;
  reasoning: string;
}
