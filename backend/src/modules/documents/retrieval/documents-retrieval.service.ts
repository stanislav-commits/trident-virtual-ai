import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RagService } from '../../../integrations/rag/rag.service';
import { ShipEntity } from '../../ships/entities/ship.entity';
import { DocumentRetrievalResponseDto } from '../dto/document-retrieval-response.dto';
import { SearchDocumentsDto } from '../dto/search-documents.dto';
import { assessDocumentRetrievalEvidenceQuality } from './documents-retrieval-evidence-assessor';
import { DocumentsRetrievalFilterBuilder } from './documents-retrieval-filter-builder';
import { DocumentsRetrievalMapper } from './documents-retrieval-mapper';
import { DocumentsRetrievalReranker } from './documents-retrieval-reranker';
import { RAGFLOW_RETRIEVAL_TOP_K } from './documents-retrieval.types';

@Injectable()
export class DocumentsRetrievalService {
  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    private readonly ragService: RagService,
    private readonly filterBuilder: DocumentsRetrievalFilterBuilder,
    private readonly reranker: DocumentsRetrievalReranker,
    private readonly mapper: DocumentsRetrievalMapper,
  ) {}

  async search(input: SearchDocumentsDto): Promise<DocumentRetrievalResponseDto> {
    const normalizedQuestion = input.question.trim();
    const ship = await this.resolveShip(input.shipId);
    const context = this.filterBuilder.buildContext(input);

    if (!ship.ragflowDatasetId) {
      return this.mapper.buildEmptyResponse({
        input,
        normalizedQuestion,
        shipId: ship.id,
        shipDatasetId: null,
        context,
        reason: 'The ship does not have a linked RAGFlow dataset yet.',
      });
    }

    const usableDocuments = await this.filterBuilder.loadUsableDocuments(
      ship.id,
      ship.ragflowDatasetId,
      context.requestedDocClasses,
    );
    const metadataMatchedDocuments =
      this.filterBuilder.applyLocalMetadataPrefilter(
        usableDocuments,
        context,
        input.languageHint,
      );
    const retrievalDocuments = metadataMatchedDocuments.length
      ? metadataMatchedDocuments
      : usableDocuments;

    if (!retrievalDocuments.length) {
      return this.mapper.buildEmptyResponse({
        input,
        normalizedQuestion,
        shipId: ship.id,
        shipDatasetId: ship.ragflowDatasetId,
        context,
        reason:
          usableDocuments.length === 0
            ? 'No parsed documents matched the requested ship and document classes.'
            : 'No parsed documents matched the requested metadata hints.',
        usableDocumentCount: usableDocuments.length,
      });
    }

    const ragflowResponse = await this.ragService.retrieveChunks({
      question: normalizedQuestion,
      datasetIds: [ship.ragflowDatasetId],
      documentIds: retrievalDocuments
        .map((document) => document.ragflowDocumentId)
        .filter((id): id is string => Boolean(id)),
      page: 1,
      pageSize: context.candidateK,
      topK: RAGFLOW_RETRIEVAL_TOP_K,
      highlight: true,
    });
    const enrichedCandidates = this.reranker.enrichCandidates(
      ragflowResponse.chunks ?? [],
      this.filterBuilder.indexByRagflowDocumentId(usableDocuments),
      context,
      input.questionType ?? null,
    );
    const selectedCandidates = this.reranker.selectResults(
      enrichedCandidates,
      context.topK,
      context.allowMultiDocument,
    );
    const results = this.mapper.toResults(selectedCandidates);
    const evidenceQuality = assessDocumentRetrievalEvidenceQuality({
      candidates: selectedCandidates,
      question: normalizedQuestion,
      questionType: input.questionType ?? null,
    });

    return this.mapper.buildResponse({
      input,
      normalizedQuestion,
      shipId: ship.id,
      shipDatasetId: ship.ragflowDatasetId,
      context,
      retrievalDocuments,
      metadataMatchedDocumentCount: metadataMatchedDocuments.length,
      usableDocumentCount: usableDocuments.length,
      retrievedCandidateCount: ragflowResponse.chunks?.length ?? 0,
      enrichedCandidateCount: enrichedCandidates.length,
      ragflowTotal:
        typeof ragflowResponse.total === 'number' ? ragflowResponse.total : null,
      evidenceQuality,
      results,
    });
  }

  private async resolveShip(shipId: string | undefined): Promise<ShipEntity> {
    if (!shipId?.trim()) {
      throw new BadRequestException('shipId is required for document retrieval.');
    }

    const ship = await this.shipsRepository.findOne({
      where: { id: shipId.trim() },
    });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return ship;
  }
}

export {
  assessDocumentRetrievalEvidenceQuality,
} from './documents-retrieval-evidence-assessor';
export {
  scoreDocumentRetrievalCandidate,
} from './documents-retrieval-reranker';
export type { DocumentRetrievalCandidateScoreInput } from './documents-retrieval.types';
