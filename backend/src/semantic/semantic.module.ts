import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { ConceptCatalogService } from './catalog/concept-catalog.service';
import { DocumentationQuerySemanticNormalizerService } from './documentation/documentation-query-semantic-normalizer.service';
import { DocumentationSourceLockService } from './documentation/documentation-source-lock.service';
import { ManualSemanticEnrichmentService } from './manuals/manual-semantic-enrichment.service';
import { ManualSemanticMatcherService } from './manuals/manual-semantic-matcher.service';
import { PageAwareManualRetrieverService } from './manuals/page-aware-manual-retriever.service';
import { SemanticLlmService } from './llm/semantic-llm.service';

@Module({
  imports: [PrismaModule, RagflowModule],
  providers: [
    ConceptCatalogService,
    DocumentationQuerySemanticNormalizerService,
    DocumentationSourceLockService,
    ManualSemanticEnrichmentService,
    ManualSemanticMatcherService,
    PageAwareManualRetrieverService,
    SemanticLlmService,
  ],
  exports: [
    ConceptCatalogService,
    DocumentationQuerySemanticNormalizerService,
    DocumentationSourceLockService,
    ManualSemanticEnrichmentService,
    ManualSemanticMatcherService,
    PageAwareManualRetrieverService,
    SemanticLlmService,
  ],
})
export class SemanticModule {}
