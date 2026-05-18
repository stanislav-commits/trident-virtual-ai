import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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
      input.plan.asks.length === 1
        ? await this.chatContextQueryResolverService.resolveStandaloneQuestion(
            input.context,
            input.plan.responseLanguage,
          )
        : input.ask.question;

    let result: Awaited<ReturnType<WebService['search']>>;

    try {
      result = await this.webService.search({
        question: resolvedQuestion,
        locale: input.plan.responseLanguage ?? undefined,
      });
    } catch (error) {
      if (this.isWebSearchUnavailableError(error)) {
        return {
          askId: input.ask.id,
          intent: input.ask.intent,
          responder: input.ask.responder,
          question: input.ask.question,
          capabilityEnabled: input.ask.capabilityEnabled,
          capabilityLabel: input.ask.capabilityLabel,
          summary:
            error instanceof Error && error.message
              ? error.message
              : 'Web search is temporarily unavailable.',
          data: {
            error: 'web_search_unavailable',
            resolvedQuestion,
          },
          contextReferences: [],
        };
      }

      throw error;
    }

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

  private isWebSearchUnavailableError(error: unknown): boolean {
    if (error instanceof ServiceUnavailableException) {
      return true;
    }

    return (
      error instanceof TypeError &&
      /\bfetch\b|\bnetwork\b/iu.test(error.message)
    );
  }
}
