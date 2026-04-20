import { Injectable } from '@nestjs/common';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { ChatTurnClassifierService } from './chat-turn-classifier.service';
import { ChatTurnDecomposerService } from './chat-turn-decomposer.service';
import { ChatMetricsTimeNormalizerService } from './chat-metrics-time-normalizer.service';
import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatTurnPlan } from './chat-turn-plan.types';

@Injectable()
export class ChatTurnPlannerService {
  constructor(
    private readonly chatTurnDecomposerService: ChatTurnDecomposerService,
    private readonly chatTurnClassifierService: ChatTurnClassifierService,
    private readonly chatCapabilityRegistryService: ChatCapabilityRegistryService,
    private readonly chatMetricsTimeNormalizerService: ChatMetricsTimeNormalizerService,
  ) {}

  async plan(context: ChatConversationContext): Promise<ChatTurnPlan> {
    const decomposition = await this.chatTurnDecomposerService.decompose(context);
    const classifiedAsks = await Promise.all(
      decomposition.asks.map((ask) =>
        this.chatTurnClassifierService.classifyAsk({
          context,
          question: ask.question,
        }),
      ),
    );
    const normalizedAsks = await Promise.all(
      classifiedAsks.map((ask) =>
        this.chatMetricsTimeNormalizerService.normalizeAsk(ask, context),
      ),
    );

    return {
      asks: normalizedAsks.map((ask, index) => {
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
          rangeStart: ask.rangeStart,
          rangeEnd: ask.rangeEnd,
        };
      }),
      responseLanguage: decomposition.responseLanguage,
      reasoning: decomposition.reasoning,
    };
  }
}
