import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

@Injectable()
export class ChatInDevelopmentResponderService {
  constructor(private readonly chatLlmService: ChatLlmService) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const content = await this.chatLlmService.generateUnavailableCapabilityReply({
      capabilityLabel: input.ask.capabilityLabel,
      responseLanguage: input.plan.responseLanguage,
    });

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: input.ask.responder,
      question: input.ask.question,
      capabilityEnabled: input.ask.capabilityEnabled,
      capabilityLabel: input.ask.capabilityLabel,
      summary: content,
      data: {
        inDevelopment: true,
      },
      contextReferences: [],
    };
  }
}
