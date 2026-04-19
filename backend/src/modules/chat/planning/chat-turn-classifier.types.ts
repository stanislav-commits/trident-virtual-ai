import { ChatTurnIntent } from './chat-turn-intent.enum';

export interface ChatTurnClassification {
  intent: ChatTurnIntent;
  responseLanguage: string | null;
  reasoning: string;
}
