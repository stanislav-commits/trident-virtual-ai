import { Module } from '@nestjs/common';
import { AssetEntity } from '../assets/entities/asset.entity';
import { AssetDocumentLinkEntity } from '../assets/entities/asset-document-link.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { ShipEntity } from '../ships/entities/ship.entity';
import { DocumentEntity } from './entities/document.entity';
import { DocumentFormLinkEntity } from './entities/document-form-link.entity';
import { PublicationCatalogEntity } from './entities/publication-catalog.entity';
import { PublicationNodeEntity } from './entities/publication-node.entity';
import { PublicationShelfEntity } from './entities/publication-shelf.entity';
import { PublicationFigureLookupService } from './publications/publication-figure-lookup.service';
import { PublicationTreeService } from './publications/publication-tree.service';
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
import { DocumentsFileLookupService } from './retrieval/documents-file-lookup.service';
import { PublicationCatalogService } from './publications/publication-catalog.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, DocumentFormLinkEntity, PublicationCatalogEntity, PublicationNodeEntity, PublicationShelfEntity, ShipEntity, AssetEntity, AssetDocumentLinkEntity]),
    IntegrationsModule,
    AccessControlModule,
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
    DocumentsFileLookupService,
    PublicationCatalogService,
    PublicationFigureLookupService,
    PublicationTreeService,
  ],
  exports: [
    DocumentsService,
    DocumentsFileLookupService,
    PublicationFigureLookupService,
  ],
})
export class DocumentsModule {}
