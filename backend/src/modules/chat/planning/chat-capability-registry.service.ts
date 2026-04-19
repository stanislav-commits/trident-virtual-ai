import { Injectable } from '@nestjs/common';
import { ChatTurnResponderKind } from './chat-turn-responder-kind.enum';
import { ChatTurnIntent } from './chat-turn-intent.enum';

export interface ChatCapabilityDefinition {
  intent: ChatTurnIntent;
  enabled: boolean;
  responder: ChatTurnResponderKind;
  label: string;
}

@Injectable()
export class ChatCapabilityRegistryService {
  private readonly definitions = new Map<ChatTurnIntent, ChatCapabilityDefinition>([
    [
      ChatTurnIntent.SMALL_TALK,
      {
        intent: ChatTurnIntent.SMALL_TALK,
        enabled: true,
        responder: ChatTurnResponderKind.SMALL_TALK,
        label: 'general conversation',
      },
    ],
    [
      ChatTurnIntent.WEB_SEARCH,
      {
        intent: ChatTurnIntent.WEB_SEARCH,
        enabled: true,
        responder: ChatTurnResponderKind.WEB_SEARCH,
        label: 'public information lookup',
      },
    ],
    [
      ChatTurnIntent.DOCUMENTATION,
      {
        intent: ChatTurnIntent.DOCUMENTATION,
        enabled: false,
        responder: ChatTurnResponderKind.IN_DEVELOPMENT,
        label: 'documentation search',
      },
    ],
    [
      ChatTurnIntent.MANUALS,
      {
        intent: ChatTurnIntent.MANUALS,
        enabled: false,
        responder: ChatTurnResponderKind.IN_DEVELOPMENT,
        label: 'manual lookup',
      },
    ],
    [
      ChatTurnIntent.LIVE_METRICS,
      {
        intent: ChatTurnIntent.LIVE_METRICS,
        enabled: false,
        responder: ChatTurnResponderKind.IN_DEVELOPMENT,
        label: 'live metrics',
      },
    ],
    [
      ChatTurnIntent.HISTORICAL_METRICS,
      {
        intent: ChatTurnIntent.HISTORICAL_METRICS,
        enabled: false,
        responder: ChatTurnResponderKind.IN_DEVELOPMENT,
        label: 'historical metrics',
      },
    ],
  ]);

  getDefinitions(): ChatCapabilityDefinition[] {
    return [...this.definitions.values()];
  }

  resolve(intent: ChatTurnIntent): ChatCapabilityDefinition {
    return (
      this.definitions.get(intent) ??
      this.definitions.get(ChatTurnIntent.SMALL_TALK)!
    );
  }
}
