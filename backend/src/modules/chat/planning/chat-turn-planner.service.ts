import { Injectable } from '@nestjs/common';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { ChatTurnClassifierService } from './chat-turn-classifier.service';
import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatTurnPlan } from './chat-turn-plan.types';

@Injectable()
export class ChatTurnPlannerService {
  constructor(
    private readonly chatTurnClassifierService: ChatTurnClassifierService,
    private readonly chatCapabilityRegistryService: ChatCapabilityRegistryService,
  ) {}

  async plan(context: ChatConversationContext): Promise<ChatTurnPlan> {
    const classification = await this.chatTurnClassifierService.classify(context);

    return {
      asks: classification.asks.map((ask, index) => {
        const capability = this.chatCapabilityRegistryService.resolve(ask.intent);

        return {
          id: `ask-${index + 1}`,
          intent: capability.intent ?? ChatTurnIntent.SMALL_TALK,
          responder: capability.responder,
          question: ask.question,
          capabilityEnabled: capability.enabled,
          capabilityLabel: capability.label,
          timeMode: ask.timeMode,
          timestamp: ask.timestamp,
        };
      }),
      responseLanguage: classification.responseLanguage,
      reasoning: classification.reasoning,
    };
  }
}
