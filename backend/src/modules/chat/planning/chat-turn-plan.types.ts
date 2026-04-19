import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatTurnResponderKind } from './chat-turn-responder-kind.enum';

export interface ChatTurnPlan {
  intent: ChatTurnIntent;
  responder: ChatTurnResponderKind;
  responseLanguage: string | null;
  reasoning: string;
  capabilityEnabled: boolean;
  capabilityLabel: string;
}
