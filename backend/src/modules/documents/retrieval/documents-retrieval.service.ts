import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { formatError } from '../../../common/utils/error.utils';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RagService } from '../../../integrations/rag/rag.service';
import { LlmService } from '../../../integrations/llm/llm.service';
import { ShipEntity } from '../../ships/entities/ship.entity';
import { PLATFORM_SHIP_ID } from '../../ships/platform-ship.constants';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { AccessControlService } from '../../access-control/access-control.service';
import { categoryForDocClass } from '../../access-control/access-positions';
import { DocumentRetrievalResponseDto } from '../dto/document-retrieval-response.dto';
import { SearchDocumentsDto } from '../dto/search-documents.dto';
import { assessDocumentRetrievalEvidenceQuality } from './scoring/documents-retrieval-evidence-assessor';
import { DocumentsRetrievalFilterBuilder } from './filtering/documents-retrieval-filter-builder';
import { DocumentsRetrievalMapper } from './mapping/documents-retrieval-mapper';
import { DocumentsRetrievalNeighborExpander } from './expansion/documents-retrieval-neighbor-expander';
import { DocumentsRetrievalReranker } from './scoring/documents-retrieval-reranker';
import {
  RAGFLOW_RETRIEVAL_TOP_K,
  RAGFLOW_VECTOR_SIMILARITY_WEIGHT,
} from './documents-retrieval.types';

@Injectable()
export class DocumentsRetrievalService {
  private readonly logger = new Logger(DocumentsRetrievalService.name);

  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    private readonly ragService: RagService,
    private readonly filterBuilder: DocumentsRetrievalFilterBuilder,
    private readonly reranker: DocumentsRetrievalReranker,
    private readonly neighborExpander: DocumentsRetrievalNeighborExpander,
    private readonly mapper: DocumentsRetrievalMapper,
    private readonly llmService: LlmService,
    private readonly accessControlService: AccessControlService,
  ) {}

  async search(input: SearchDocumentsDto): Promise<DocumentRetrievalResponseDto> {
    const normalizedQuestion = await this.toRetrievalLanguage(
      input.question.trim(),
    );
    // Short core question for scoring; falls back to the retrieval text.
    const assessmentQuestion = input.assessmentQuestion?.trim()
      ? await this.toRetrievalLanguage(input.assessmentQuestion.trim())
      : normalizedQuestion;
    const ship = await this.resolveShip(input.shipId);
    const context = this.filterBuilder.buildContext(input);

    // RBAC: if the viewer is linked to a crew member, drop doc classes their
    // position may not read. Admins / unlinked users → allowed === null → no-op.
    if (input.viewerUserId && input.shipId) {
      const allowed = await this.accessControlService.allowedCategories(
        input.viewerUserId,
        input.shipId,
      );
      if (allowed) {
        context.requestedDocClasses = context.requestedDocClasses.filter(
          (docClass) => {
            const category = categoryForDocClass(docClass);
            return category === null || allowed.has(category);
          },
        );
      }
    }

    // Fleet-wide Publications (platform scope) are unioned into every vessel's
    // retrieval: a ship's chat sees its own KB documents PLUS the shared
    // rules/regs, each living in its own RAGFlow dataset (approach B).
    const platformShip = context.requestedDocClasses.includes(
      DocumentDocClass.PUBLICATION,
    )
      ? await this.shipsRepository.findOne({ where: { id: PLATFORM_SHIP_ID } })
      : null;

    const shipDocuments = ship.ragflowDatasetId
      ? await this.filterBuilder.loadUsableDocuments(
          ship.id,
          ship.ragflowDatasetId,
          context.requestedDocClasses,
        )
      : [];
    const publicationDocuments = platformShip?.ragflowDatasetId
      ? await this.filterBuilder.loadPublicationDocuments(
          platformShip.ragflowDatasetId,
        )
      : [];

    const datasetIds = Array.from(
      new Set(
        [
          ship.ragflowDatasetId,
          publicationDocuments.length ? platformShip?.ragflowDatasetId : null,
        ].filter((id): id is string => Boolean(id)),
      ),
    );

    if (!datasetIds.length) {
      return this.mapper.buildEmptyResponse({
        input,
        normalizedQuestion,
        shipId: ship.id,
        shipDatasetId: null,
        context,
        reason: 'The ship does not have a linked RAGFlow dataset yet.',
      });
    }

    let usableDocuments = [...shipDocuments, ...publicationDocuments];
    if (input.scopeRagflowDocumentIds?.length) {
      const scope = new Set(input.scopeRagflowDocumentIds);
      usableDocuments = usableDocuments.filter(
        (document) =>
          document.ragflowDocumentId && scope.has(document.ragflowDocumentId),
      );
    }
    const metadataMatchedDocuments =
      this.filterBuilder.applyLocalMetadataPrefilter(
        usableDocuments,
        context,
        input.languageHint,
      );
    const retrievalDocuments = metadataMatchedDocuments.length
      ? metadataMatchedDocuments
      : context.requireDocumentTitleMatch
        ? []
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

    const ragflowResponse = await this.retrieveChunksDroppingDeadDatasets(
      normalizedQuestion,
      datasetIds,
      retrievalDocuments,
      context.candidateK,
    );
    const enrichedCandidates = this.reranker.enrichCandidates(
      ragflowResponse.chunks ?? [],
      this.filterBuilder.indexByRagflowDocumentId(usableDocuments),
      context,
      assessmentQuestion,
      input.questionType ?? null,
    );
    const selectedCandidates = this.reranker.selectResults(
      enrichedCandidates,
      context.topK,
      context.allowMultiDocument,
    );
    const initialEvidenceQuality = assessDocumentRetrievalEvidenceQuality({
      candidates: selectedCandidates,
      question: assessmentQuestion,
      questionType: input.questionType ?? null,
    });
    const expandedCandidates = await this.neighborExpander.expand({
      selectedCandidates,
      allCandidates: enrichedCandidates,
      // Neighbor expansion fetches adjacent chunks within one dataset; use the
      // ship's own dataset (publications are short, single-chunk regs that
      // rarely need neighbor stitching). Falls back to the platform dataset for
      // a publications-only ship.
      datasetId: datasetIds[0],
      context,
      question: assessmentQuestion,
      questionType: input.questionType ?? null,
      evidenceQuality: initialEvidenceQuality,
    });
    const orderedExpandedCandidates =
      this.reranker.orderExpandedResultsForPrompt(expandedCandidates);
    const results = this.mapper.toResults(orderedExpandedCandidates);
    const evidenceQuality = assessDocumentRetrievalEvidenceQuality({
      candidates: orderedExpandedCandidates,
      question: assessmentQuestion,
      questionType: input.questionType ?? null,
    });

    return this.mapper.buildResponse({
      input,
      normalizedQuestion,
      shipId: ship.id,
      shipDatasetId: ship.ragflowDatasetId ?? datasetIds[0],
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

  /**
   * RAGFlow fails the WHOLE retrieval when ANY dataset in the list is not
   * owned by the current API key ("You don't own the dataset <id>" — e.g. a
   * dataset created under a rotated key). One stale dataset must not kill
   * ship-document answers: drop the dataset RAGFlow rejects (and its
   * documents) and retry with the rest.
   */
  private async retrieveChunksDroppingDeadDatasets(
    question: string,
    initialDatasetIds: string[],
    initialDocuments: { ragflowDocumentId: string | null; ragflowDatasetId: string | null }[],
    candidateK: number,
  ) {
    let datasetIds = [...initialDatasetIds];
    let documents = initialDocuments;
    for (;;) {
      try {
        return await this.ragService.retrieveChunks({
          question,
          datasetIds,
          documentIds: documents
            .map((document) => document.ragflowDocumentId)
            .filter((id): id is string => Boolean(id)),
          page: 1,
          pageSize: candidateK,
          topK: RAGFLOW_RETRIEVAL_TOP_K,
          vectorSimilarityWeight: RAGFLOW_VECTOR_SIMILARITY_WEIGHT,
          highlight: true,
        });
      } catch (error) {
        const message = formatError(error);
        const dead = /don'?t own the dataset\s*([0-9a-f-]+)/i.exec(message)?.[1];
        if (!dead || !datasetIds.includes(dead) || datasetIds.length <= 1) {
          throw error;
        }
        this.logger.warn(
          `RAGFlow rejected dataset ${dead} (not owned by the current key) — retrying retrieval without it.`,
        );
        datasetIds = datasetIds.filter((id) => id !== dead);
        documents = documents.filter(
          (document) => document.ragflowDatasetId !== dead,
        );
      }
    }
  }

  /**
   * The ship's manuals are English, and the evidence assessor scores
   * candidates by LEXICAL question↔chunk token overlap — a Russian or
   * Ukrainian question scores ~0 against English chunks and the whole
   * retrieval gets dismissed as no_evidence (observed 2026-06-11: «как
   * поменять топливный фильтр» → none, same question in English → weak).
   * Translate non-Latin questions to English for retrieval + assessment;
   * the final user-facing answer is composed in the user's language by
   * the responder regardless.
   */
  private async toRetrievalLanguage(question: string): Promise<string> {
    if (!/[\u0400-\u04FF]/.test(question)) {
      return question; // already Latin-script — assume English-compatible
    }
    const translated = await this.llmService.createChatCompletion({
      systemPrompt:
        'Translate the user text to English for a technical document search. ' +
        'Preserve equipment names, abbreviations and codes verbatim. ' +
        'Return ONLY the translation.',
      userPrompt: question,
      temperature: 0,
      maxTokens: 300,
    });
    return translated?.trim() || question;
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
} from './scoring/documents-retrieval-evidence-assessor';
export {
  scoreDocumentRetrievalCandidate,
} from './scoring/documents-retrieval-reranker';
export type { DocumentRetrievalCandidateScoreInput } from './documents-retrieval.types';
