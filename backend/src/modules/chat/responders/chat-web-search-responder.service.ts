import { Injectable } from '@nestjs/common';
import { ShipContextService } from '../../ships/ship-context.service';
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
    private readonly shipContextService: ShipContextService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const resolvedQuestion =
      input.plan.asks.length === 1
        ? await this.chatContextQueryResolverService.resolveStandaloneQuestion(
            input.context,
            input.plan.responseLanguage,
          )
        : input.ask.question;

    const vesselContext = input.session.shipId
      ? (await this.shipContextService.buildContextString(
          input.session.shipId,
        )) ?? undefined
      : undefined;

    const result = await this.webService.search({
      question: resolvedQuestion,
      locale: input.plan.responseLanguage ?? undefined,
      vesselContext,
    });

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: input.ask.responder,
      question: input.ask.question,
      capabilityEnabled: input.ask.capabilityEnabled,
      capabilityLabel: input.ask.capabilityLabel,
      summary: result.summary,
      data: {
        ...result.data,
        resolvedQuestion,
      },
      contextReferences: result.contextReferences,
    };
  }
}
