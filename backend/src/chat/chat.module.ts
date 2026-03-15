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
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [PrismaModule, RagflowModule, MetricsModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatContextService,
    ChatDocumentationService,
    ChatDocumentationQueryService,
    ChatDocumentationCitationService,
    ChatDocumentationScanService,
    ChatReferenceExtractionService,
    LlmService,
  ],
  exports: [ChatService, ChatContextService, ChatDocumentationService, LlmService],
})
export class ChatModule {}
