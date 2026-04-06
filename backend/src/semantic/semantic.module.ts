import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { ConceptCatalogService } from './concept-catalog.service';
import { DocumentationQuerySemanticNormalizerService } from './documentation-query-semantic-normalizer.service';
import { DocumentationSourceLockService } from './documentation-source-lock.service';
import { ManualSemanticEnrichmentService } from './manual-semantic-enrichment.service';
import { ManualSemanticMatcherService } from './manual-semantic-matcher.service';
import { PageAwareManualRetrieverService } from './page-aware-manual-retriever.service';
import { SemanticLlmService } from './semantic-llm.service';

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
