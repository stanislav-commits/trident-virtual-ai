import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { ShipEntity } from '../ships/entities/ship.entity';
import { DocumentEntity } from './entities/document.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsIngestionService } from './ingestion/documents-ingestion.service';
import { DocumentsParseDrainService } from './parsing/documents-parse-drain.service';
import { DocumentsParseDispatcherService } from './parsing/documents-parse-dispatcher.service';
import { DocumentsParseFallbackService } from './parsing/documents-parse-fallback.service';
import { DocumentsParseStatusSyncService } from './parsing/documents-parse-status-sync.service';
import { DocumentsRemoteIngestionDispatcherService } from './ingestion/documents-remote-ingestion-dispatcher.service';
import { DocumentsService } from './documents.service';
import { DocumentsUploadStorageService } from './ingestion/documents-upload-storage.service';
import { VisionExtractionService } from './extraction/vision-extraction.service';
import { DocumentsRetrievalFilterBuilder } from './retrieval/filtering/documents-retrieval-filter-builder';
import { DocumentsRetrievalMapper } from './retrieval/mapping/documents-retrieval-mapper';
import { DocumentsRetrievalNeighborExpander } from './retrieval/expansion/documents-retrieval-neighbor-expander';
import { DocumentsRetrievalReranker } from './retrieval/scoring/documents-retrieval-reranker';
import { DocumentsRetrievalService } from './retrieval/documents-retrieval.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, ShipEntity]),
    IntegrationsModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentsIngestionService,
    DocumentsParseDrainService,
    DocumentsParseDispatcherService,
    DocumentsParseFallbackService,
    DocumentsParseStatusSyncService,
    DocumentsRemoteIngestionDispatcherService,
    DocumentsUploadStorageService,
    VisionExtractionService,
    DocumentsRetrievalFilterBuilder,
    DocumentsRetrievalMapper,
    DocumentsRetrievalNeighborExpander,
    DocumentsRetrievalReranker,
    DocumentsRetrievalService,
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
