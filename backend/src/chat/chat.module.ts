import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LlmService } from './llm/llm.service';
import { ChatQueryPlannerService } from './query/chat-query-planner.service';
import { ChatTurnContextService } from './context/chat-turn-context.service';
import { ChatSessionService } from './session/chat-session.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { MetricsModule } from '../metrics/metrics.module';
import { SystemPromptModule } from '../system-prompt/system-prompt.module';
import { TagsModule } from '../tags/tags.module';
import { SemanticModule } from '../semantic/semantic.module';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Module({
  imports: [
    PrismaModule,
    RagflowModule,
    MetricsModule,
    SystemPromptModule,
    TagsModule,
    SemanticModule,
    KnowledgeBaseModule,
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatTurnContextService,
    ChatQueryPlannerService,
    ChatSessionService,
    LlmService,
  ],
  exports: [
    ChatService,
    ChatTurnContextService,
    ChatSessionService,
    KnowledgeBaseModule,
    ChatQueryPlannerService,
    LlmService,
  ],
})
export class ChatModule {}
