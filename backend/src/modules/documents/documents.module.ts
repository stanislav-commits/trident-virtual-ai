import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { ShipEntity } from '../ships/entities/ship.entity';
import { DocumentEntity } from './entities/document.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsIngestionService } from './documents-ingestion.service';
import { DocumentsParseDispatcherService } from './documents-parse-dispatcher.service';
import { DocumentsService } from './documents.service';
import { DocumentsRetrievalFilterBuilder } from './retrieval/documents-retrieval-filter-builder';
import { DocumentsRetrievalMapper } from './retrieval/documents-retrieval-mapper';
import { DocumentsRetrievalReranker } from './retrieval/documents-retrieval-reranker';
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
    DocumentsParseDispatcherService,
    DocumentsRetrievalFilterBuilder,
    DocumentsRetrievalMapper,
    DocumentsRetrievalReranker,
    DocumentsRetrievalService,
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
