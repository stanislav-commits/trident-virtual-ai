import { Module } from '@nestjs/common';
import { AssistantTextModule } from '../assistant-text/assistant-text.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { SemanticModule } from '../semantic/semantic.module';
import { TagsModule } from '../tags/tags.module';
import { ChatDocumentationCitationService } from './citations/chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './documentation/chat-documentation-query.service';
import { ChatDocumentationService } from './documentation/chat-documentation.service';
import { ChatReferenceExtractionService } from './documentation/chat-reference-extraction.service';
import { ChatContextService } from './retrieval/chat-context.service';
import { ChatDocumentationScanService } from './retrieval/chat-documentation-scan.service';

@Module({
  imports: [
    PrismaModule,
    RagflowModule,
    SemanticModule,
    TagsModule,
    AssistantTextModule,
  ],
  providers: [
    ChatContextService,
    ChatDocumentationService,
    ChatDocumentationQueryService,
    ChatDocumentationCitationService,
    ChatDocumentationScanService,
    ChatReferenceExtractionService,
  ],
  exports: [
    ChatContextService,
    ChatDocumentationService,
    ChatDocumentationQueryService,
    ChatDocumentationCitationService,
    ChatDocumentationScanService,
    ChatReferenceExtractionService,
  ],
})
export class KnowledgeBaseModule {}
