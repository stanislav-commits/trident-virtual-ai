import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatContextService } from './chat-context.service';
import { LlmService } from './llm.service';
import { ChatDocumentationService } from './chat-documentation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';
import { ChatQueryPlannerService } from './chat-query-planner.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { MetricsModule } from '../metrics/metrics.module';
import { SystemPromptModule } from '../system-prompt/system-prompt.module';
import { TagsModule } from '../tags/tags.module';
import { SemanticModule } from '../semantic/semantic.module';

@Module({
  imports: [
    PrismaModule,
    RagflowModule,
    MetricsModule,
    SystemPromptModule,
    TagsModule,
    SemanticModule,
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatContextService,
    ChatDocumentationService,
    ChatDocumentationQueryService,
    ChatDocumentationCitationService,
    ChatDocumentationScanService,
    ChatReferenceExtractionService,
    ChatQueryPlannerService,
    LlmService,
  ],
  exports: [
    ChatService,
    ChatContextService,
    ChatDocumentationService,
    ChatQueryPlannerService,
    LlmService,
  ],
})
export class ChatModule {}
