import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { ChatV2Controller } from './chat-v2.controller';
import { ChatV2Service } from './chat-v2.service';
import { ChatV2TurnContextService } from './context/chat-v2-turn-context.service';
import { ChatV2TurnClassifierService } from './intake/chat-v2-turn-classifier.service';
import { ChatV2ResponseOrchestratorService } from './orchestration/chat-v2-response-orchestrator.service';
import { ChatV2ChatHistoryResponderService } from './responders/chat-v2-chat-history-responder.service';
import { ChatV2ChatHistorySummaryResponderService } from './responders/chat-v2-chat-history-summary-responder.service';
import { ChatV2GeneralWebResponderService } from './responders/chat-v2-general-web-responder.service';
import { ChatV2SmallTalkResponderService } from './responders/chat-v2-small-talk-responder.service';
import { ChatV2UnsupportedShipTaskResponderService } from './responders/chat-v2-unsupported-ship-task-responder.service';
import { ChatV2TaskRouterService } from './routing/chat-v2-task-router.service';
import { ChatV2OpenAiWebSearchProvider } from './web/chat-v2-openai-web-search.provider';
import { ChatV2WebSearchProvider } from './web/chat-v2-web-search.provider';

@Module({
  imports: [ChatModule],
  controllers: [ChatV2Controller],
  providers: [
    ChatV2Service,
    ChatV2TurnContextService,
    ChatV2TurnClassifierService,
    ChatV2TaskRouterService,
    ChatV2ResponseOrchestratorService,
    ChatV2SmallTalkResponderService,
    ChatV2ChatHistoryResponderService,
    ChatV2ChatHistorySummaryResponderService,
    ChatV2GeneralWebResponderService,
    ChatV2UnsupportedShipTaskResponderService,
    ChatV2OpenAiWebSearchProvider,
    {
      provide: ChatV2WebSearchProvider,
      useExisting: ChatV2OpenAiWebSearchProvider,
    },
  ],
  exports: [ChatV2Service],
})
export class ChatV2Module {}
