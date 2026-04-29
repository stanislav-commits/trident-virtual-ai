import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { DocumentsModule } from '../documents/documents.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ShipsModule } from '../ships/ships.module';
import { WebModule } from '../web/web.module';
import { ChatController } from './chat.controller';
import { ChatLlmService } from './chat-llm.service';
import { ChatMessagesService } from './chat-messages.service';
import { ChatSessionsService } from './chat-sessions.service';
import { ChatConversationContextService } from './context/chat-conversation-context.service';
import { ChatContextMemoryService } from './context/chat-context-memory.service';
import { ChatContextQueryResolverService } from './context/chat-context-query-resolver.service';
import { ChatSessionMemoryEntity } from './context/entities/chat-session-memory.entity';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatSessionEntity } from './entities/chat-session.entity';
import { ChatTurnOrchestratorService } from './orchestration/chat-turn-orchestrator.service';
import { ChatCapabilityRegistryService } from './planning/chat-capability-registry.service';
import { ChatTurnClassifierService } from './planning/chat-turn-classifier.service';
import { ChatTurnDecomposerService } from './planning/chat-turn-decomposer.service';
import { ChatMetricsTimeNormalizerService } from './planning/chat-metrics-time-normalizer.service';
import { ChatTurnPlannerService } from './planning/chat-turn-planner.service';
import { ChatSemanticRouterService } from './routing/chat-semantic-router.service';
import { ChatDocumentsResponderService } from './responders/chat-documents-responder.service';
import { ChatInDevelopmentResponderService } from './responders/chat-in-development-responder.service';
import { ChatMetricsResponderService } from './responders/chat-metrics-responder.service';
import { ChatSmallTalkResponderService } from './responders/chat-small-talk-responder.service';
import { ChatWebSearchResponderService } from './responders/chat-web-search-responder.service';

@Module({
  imports: [
    IntegrationsModule,
    DocumentsModule,
    MetricsModule,
    ShipsModule,
    WebModule,
    TypeOrmModule.forFeature([
      ChatSessionEntity,
      ChatMessageEntity,
      ChatSessionMemoryEntity,
    ]),
  ],
  controllers: [ChatController],
  providers: [
    ChatSessionsService,
    ChatMessagesService,
    ChatLlmService,
    ChatContextMemoryService,
    ChatConversationContextService,
    ChatContextQueryResolverService,
    ChatCapabilityRegistryService,
    ChatTurnDecomposerService,
    ChatTurnClassifierService,
    ChatMetricsTimeNormalizerService,
    ChatSemanticRouterService,
    ChatTurnPlannerService,
    ChatTurnOrchestratorService,
    ChatSmallTalkResponderService,
    ChatWebSearchResponderService,
    ChatMetricsResponderService,
    ChatDocumentsResponderService,
    ChatInDevelopmentResponderService,
  ],
  exports: [ChatSessionsService, ChatMessagesService],
})
export class ChatModule {}
