import { Injectable } from '@nestjs/common';
import { WebService } from '../../web/web.service';
import { ChatContextQueryResolverService } from '../context/chat-context-query-resolver.service';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

@Injectable()
export class ChatWebSearchResponderService {
  constructor(
    private readonly webService: WebService,
    private readonly chatContextQueryResolverService: ChatContextQueryResolverService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const resolvedQuestion =
      await this.chatContextQueryResolverService.resolveStandaloneQuestion(
        input.context,
        input.plan.responseLanguage,
      );

    const result = await this.webService.search({
      question: resolvedQuestion,
      locale: input.plan.responseLanguage ?? undefined,
    });

    return {
      content: result.summary,
      ragflowContext: {
        contextReferences: result.contextReferences,
        planner: {
          intent: input.plan.intent,
          responder: input.plan.responder,
          reasoning: input.plan.reasoning,
          capabilityEnabled: input.plan.capabilityEnabled,
          capabilityLabel: input.plan.capabilityLabel,
        },
        web: result.data,
        resolvedQuestion,
      },
    };
  }
}
