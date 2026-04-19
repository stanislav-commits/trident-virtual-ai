import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

@Injectable()
export class ChatSmallTalkResponderService {
  constructor(private readonly chatLlmService: ChatLlmService) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const summary = await this.chatLlmService.generateConversationReply({
      session: input.session,
      context: input.context,
    });

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: input.ask.responder,
      question: input.ask.question,
      capabilityEnabled: input.ask.capabilityEnabled,
      capabilityLabel: input.ask.capabilityLabel,
      summary,
      data: null,
      contextReferences: [],
    };
  }
}
