import { Injectable } from '@nestjs/common';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatMessageEntity } from '../entities/chat-message.entity';
import { ChatSessionEntity } from '../entities/chat-session.entity';
import { ChatTurnPlannerService } from '../planning/chat-turn-planner.service';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatInDevelopmentResponderService } from '../responders/chat-in-development-responder.service';
import { ChatSmallTalkResponderService } from '../responders/chat-small-talk-responder.service';
import { ChatWebSearchResponderService } from '../responders/chat-web-search-responder.service';

@Injectable()
export class ChatTurnOrchestratorService {
  constructor(
    private readonly chatTurnPlannerService: ChatTurnPlannerService,
    private readonly chatSmallTalkResponderService: ChatSmallTalkResponderService,
    private readonly chatWebSearchResponderService: ChatWebSearchResponderService,
    private readonly chatInDevelopmentResponderService: ChatInDevelopmentResponderService,
  ) {}

  async respond(input: {
    session: ChatSessionEntity;
    messages: ChatMessageEntity[];
    context: ChatConversationContext;
  }): Promise<{
    content: string;
    ragflowContext: Record<string, unknown> | null;
  }> {
    const plan = await this.chatTurnPlannerService.plan(input.context);
    const normalize = (result: {
      content: string;
      ragflowContext?: Record<string, unknown> | null;
    }) => ({
      content: result.content,
      ragflowContext: result.ragflowContext ?? null,
    });

    switch (plan.responder) {
      case ChatTurnResponderKind.WEB_SEARCH:
        return normalize(await this.chatWebSearchResponderService.respond({
          plan,
          session: input.session,
          messages: input.messages,
          context: input.context,
        }));
      case ChatTurnResponderKind.IN_DEVELOPMENT:
        return normalize(await this.chatInDevelopmentResponderService.respond({
          plan,
          session: input.session,
          messages: input.messages,
          context: input.context,
        }));
      case ChatTurnResponderKind.SMALL_TALK:
      default:
        return normalize(await this.chatSmallTalkResponderService.respond({
          plan,
          session: input.session,
          messages: input.messages,
          context: input.context,
        }));
    }
  }
}
