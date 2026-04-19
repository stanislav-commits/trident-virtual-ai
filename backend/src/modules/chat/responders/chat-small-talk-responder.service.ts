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
    const content = await this.chatLlmService.generateConversationReply({
      session: input.session,
      context: input.context,
    });

    return {
      content,
      ragflowContext: {
        planner: {
          intent: input.plan.intent,
          responder: input.plan.responder,
          reasoning: input.plan.reasoning,
          capabilityEnabled: input.plan.capabilityEnabled,
          capabilityLabel: input.plan.capabilityLabel,
        },
      },
    };
  }
}
