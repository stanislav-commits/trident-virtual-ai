import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';

export interface ChatTurnClassificationAsk {
  intent: ChatTurnIntent;
  question: string;
  timeMode: ChatMetricsAskTimeMode | null;
  timestamp: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
}

export interface ChatTurnClassification {
  asks: ChatTurnClassificationAsk[];
  responseLanguage: string | null;
  reasoning: string;
}
