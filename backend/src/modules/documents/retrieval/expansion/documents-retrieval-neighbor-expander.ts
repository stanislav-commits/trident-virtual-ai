import { Injectable, Logger } from '@nestjs/common';
import { RagService } from '../../../../integrations/rag/rag.service';
import { RagflowRetrievalChunk } from '../../../../integrations/rag/ragflow.types';
import { DocumentRetrievalEvidenceQuality } from '../../dto/document-retrieval-response.dto';
import { DocumentRetrievalQuestionType } from '../../enums/document-retrieval-question-type.enum';
import { getQuestionSupportSignals } from '../scoring/documents-retrieval-text-signals';
import {
  getQuestionContentSignalBonus,
  isFuelFilterReplacementQuestion,
  isMaintenanceScheduleQuestion,
} from '../scoring/documents-retrieval-query-signals';
import { extractChunkPages } from '../chunks/documents-retrieval-chunk-utils';
import {
  DocumentRetrievalFilterContext,
  EnrichedDocumentRetrievalCandidate,
} from '../documents-retrieval.types';

const MAX_EXPANSION_ANCHORS = 3;
const PREVIOUS_CHUNK_COUNT = 1;
const NEXT_CHUNK_COUNT = 2;
const DOCUMENT_CHUNKS_PAGE_SIZE = 100;
const DOCUMENT_CHUNKS_MAX_PAGES = 50;
const MAX_EXPANDED_RESULT_COUNT = 10;
const MIN_ANCHOR_RERANK_SCORE = 0.32;
const MIN_ANCHOR_RETRIEVAL_SCORE = 0.16;

type NeighborExpansionReason =
  NonNullable<EnrichedDocumentRetrievalCandidate['expansion']>['reason'];

interface ExpandNeighborsInput {
  selectedCandidates: EnrichedDocumentRetrievalCandidate[];
  allCandidates: EnrichedDocumentRetrievalCandidate[];
  datasetId: string;
  context: DocumentRetrievalFilterContext;
  question: string;
  questionType: DocumentRetrievalQuestionType | null;
  evidenceQuality: DocumentRetrievalEvidenceQuality;
}

@Injectable()
export class DocumentsRetrievalNeighborExpander {
  private readonly logger = new Logger(DocumentsRetrievalNeighborExpander.name);

  constructor(private readonly ragService: RagService) {}

  async expand(
    input: ExpandNeighborsInput,
  ): Promise<EnrichedDocumentRetrievalCandidate[]> {
    if (!this.shouldConsiderExpansion(input)) {
      return input.selectedCandidates;
    }

    const anchorReasons = new Map<string, NeighborExpansionReason>();

    for (const candidate of input.selectedCandidates) {
      const reason = this.getExpansionReason(input, candidate);

      if (reason) {
        anchorReasons.set(candidate.chunk.id, reason);
      }

      if (anchorReasons.size >= MAX_EXPANSION_ANCHORS) {
        break;
      }
    }

    if (!anchorReasons.size) {
      return input.selectedCandidates;
    }

    try {
      return await this.expandFromAnchors(input, anchorReasons);
    } catch (error) {
      this.logger.warn(
        `Document neighbor expansion skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return input.selectedCandidates;
    }
  }

  private async expandFromAnchors(
    input: ExpandNeighborsInput,
    anchorReasons: Map<string, NeighborExpansionReason>,
  ): Promise<EnrichedDocumentRetrievalCandidate[]> {
    const existingCandidatesByChunkId = new Map(
      input.allCandidates.map((candidate) => [candidate.chunk.id, candidate]),
    );
    const orderedChunksByDocumentId = await this.loadOrderedChunksForAnchors(
      input.datasetId,
      input.selectedCandidates.filter((candidate) =>
        anchorReasons.has(candidate.chunk.id),
      ),
    );
    const expanded: EnrichedDocumentRetrievalCandidate[] = [];
    const seenChunkIds = new Set<string>();
    const maxResultCount = Math.max(
      input.selectedCandidates.length,
      Math.min(MAX_EXPANDED_RESULT_COUNT, input.context.topK + 4),
    );

    for (const candidate of input.selectedCandidates) {
      this.pushCandidate(expanded, seenChunkIds, candidate, maxResultCount);

      const reason = anchorReasons.get(candidate.chunk.id);
      const orderedChunks = orderedChunksByDocumentId.get(
        candidate.document.ragflowDocumentId ?? '',
      );

      if (!reason || !orderedChunks || expanded.length >= maxResultCount) {
        continue;
      }

      const neighborChunks = this.getNeighborChunks(
        candidate.chunk,
        orderedChunks,
        reason,
      );

      for (const neighborChunk of neighborChunks) {
        const neighborCandidate =
          existingCandidatesByChunkId.get(neighborChunk.id) ??
          this.buildExpandedCandidate(candidate, neighborChunk, reason);

        this.pushCandidate(
          expanded,
          seenChunkIds,
          neighborCandidate,
          maxResultCount,
        );

        if (expanded.length >= maxResultCount) {
          break;
        }
      }
    }

    return expanded;
  }

  private shouldConsiderExpansion(input: ExpandNeighborsInput): boolean {
    if (!input.selectedCandidates.length) {
      return false;
    }

    const normalizedQuestion = input.question.toLocaleLowerCase();

    return (
      input.evidenceQuality !== 'strong' ||
      this.isProcedureLikeQuestion(input.question, input.questionType) ||
      isMaintenanceScheduleQuestion(normalizedQuestion) ||
      this.isTableValueQuestion(normalizedQuestion) ||
      Boolean(input.context.documentTitleHint)
    );
  }

  private getExpansionReason(
    input: ExpandNeighborsInput,
    candidate: EnrichedDocumentRetrievalCandidate,
  ): NeighborExpansionReason | null {
    if (!this.isSupportedAnchor(input.question, candidate)) {
      return null;
    }

    const normalizedQuestion = input.question.toLocaleLowerCase();
    const content = candidate.chunk.content ?? '';

    if (this.isProcedureLikeQuestion(input.question, input.questionType)) {
      return 'procedure_continuation';
    }

    if (
      isMaintenanceScheduleQuestion(normalizedQuestion) ||
      this.isTableValueQuestion(normalizedQuestion)
    ) {
      return 'table_context';
    }

    if (input.context.documentTitleHint && input.evidenceQuality !== 'strong') {
      return 'exact_title_weak_evidence';
    }

    if (this.hasSectionContextSignal(content)) {
      return 'section_context';
    }

    return null;
  }

  private isSupportedAnchor(
    question: string,
    candidate: EnrichedDocumentRetrievalCandidate,
  ): boolean {
    const retrievalScore = candidate.retrievalScore ?? 0;

    if (
      retrievalScore < MIN_ANCHOR_RETRIEVAL_SCORE ||
      candidate.rerankScore < MIN_ANCHOR_RERANK_SCORE
    ) {
      return false;
    }

    const content = candidate.chunk.content ?? '';
    const supportSignals = getQuestionSupportSignals(question, content);
    const questionContentBonus = getQuestionContentSignalBonus(question, content);

    if (questionContentBonus > 0) {
      return true;
    }

    if (supportSignals.hasOnlyGenericSupport) {
      return false;
    }

    return (
      !supportSignals.hasSpecificTokens ||
      supportSignals.specificSupportScore >= 0.4
    );
  }

  private async loadOrderedChunksForAnchors(
    datasetId: string,
    anchors: EnrichedDocumentRetrievalCandidate[],
  ): Promise<Map<string, RagflowRetrievalChunk[]>> {
    const documentIds = Array.from(
      new Set(
        anchors
          .map((candidate) => candidate.document.ragflowDocumentId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const chunksByDocumentId = new Map<string, RagflowRetrievalChunk[]>();

    for (const documentId of documentIds) {
      chunksByDocumentId.set(
        documentId,
        await this.loadOrderedDocumentChunks(datasetId, documentId),
      );
    }

    return chunksByDocumentId;
  }

  private async loadOrderedDocumentChunks(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowRetrievalChunk[]> {
    const chunks: RagflowRetrievalChunk[] = [];
    let total: number | undefined;

    for (let page = 1; page <= DOCUMENT_CHUNKS_MAX_PAGES; page += 1) {
      const response = await this.ragService.listDocumentChunks(
        datasetId,
        documentId,
        {
          page,
          pageSize: DOCUMENT_CHUNKS_PAGE_SIZE,
        },
      );

      chunks.push(...response.chunks);
      total = response.total ?? total;

      if (
        response.chunks.length < DOCUMENT_CHUNKS_PAGE_SIZE ||
        (typeof total === 'number' && chunks.length >= total)
      ) {
        break;
      }
    }

    return chunks;
  }

  private getNeighborChunks(
    anchorChunk: RagflowRetrievalChunk,
    orderedChunks: RagflowRetrievalChunk[],
    reason: NeighborExpansionReason,
  ): RagflowRetrievalChunk[] {
    const anchorIndex = orderedChunks.findIndex(
      (chunk) => chunk.id === anchorChunk.id,
    );

    if (anchorIndex < 0) {
      return [];
    }

    const neighbors: RagflowRetrievalChunk[] = [];
    const offsets =
      reason === 'procedure_continuation' ? [1, 2, -1] : [-1, 1, 2];

    for (const offset of offsets) {
      if (offset < -PREVIOUS_CHUNK_COUNT || offset > NEXT_CHUNK_COUNT) {
        continue;
      }

      const neighbor = orderedChunks[anchorIndex + offset];

      if (
        neighbor &&
        this.isSameOrAdjacentPage(anchorChunk, neighbor) &&
        this.isUsefulNeighborChunk(neighbor, reason)
      ) {
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  private isUsefulNeighborChunk(
    chunk: RagflowRetrievalChunk,
    reason: NeighborExpansionReason,
  ): boolean {
    const text = this.normalizeChunkText(chunk.content ?? '');

    if (!text) {
      return false;
    }

    const tokenCount = text.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;

    if (reason === 'table_context') {
      return text.length >= 12 || tokenCount >= 2;
    }

    return text.length >= 24 && tokenCount >= 3;
  }

  private normalizeChunkText(content: string): string {
    return content
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isSameOrAdjacentPage(
    anchorChunk: RagflowRetrievalChunk,
    neighborChunk: RagflowRetrievalChunk,
  ): boolean {
    const anchorPages = extractChunkPages(anchorChunk.positions);
    const neighborPages = extractChunkPages(neighborChunk.positions);

    if (!anchorPages.length || !neighborPages.length) {
      return true;
    }

    return anchorPages.some((anchorPage) =>
      neighborPages.some(
        (neighborPage) => Math.abs(anchorPage - neighborPage) <= 1,
      ),
    );
  }

  private buildExpandedCandidate(
    anchor: EnrichedDocumentRetrievalCandidate,
    chunk: RagflowRetrievalChunk,
    reason: NeighborExpansionReason,
  ): EnrichedDocumentRetrievalCandidate {
    return {
      chunk,
      document: anchor.document,
      retrievalScore: anchor.retrievalScore,
      rerankScore: Math.max(0, anchor.rerankScore - 0.001),
      expansion: {
        anchorChunkId: anchor.chunk.id,
        reason,
      },
    };
  }

  private pushCandidate(
    candidates: EnrichedDocumentRetrievalCandidate[],
    seenChunkIds: Set<string>,
    candidate: EnrichedDocumentRetrievalCandidate,
    maxResultCount: number,
  ): void {
    if (candidates.length >= maxResultCount || seenChunkIds.has(candidate.chunk.id)) {
      return;
    }

    candidates.push(candidate);
    seenChunkIds.add(candidate.chunk.id);
  }

  private isProcedureLikeQuestion(
    question: string,
    questionType: DocumentRetrievalQuestionType | null,
  ): boolean {
    const normalizedQuestion = question.toLocaleLowerCase();

    return (
      questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE ||
      isFuelFilterReplacementQuestion(normalizedQuestion) ||
      /\b(?:how to|procedure|steps|replace|change|renew|service|remove|install|repair|maintenance)\b/u.test(
        normalizedQuestion,
      )
    );
  }

  private isTableValueQuestion(question: string): boolean {
    return /\b(?:table|schedule|interval|threshold|specification|value|running hours|due)\b/u.test(
      question,
    );
  }

  private hasSectionContextSignal(content: string): boolean {
    return /\b(?:section|chapter|\d+(?:\.\d+)+|procedure|maintenance|schedule|table)\b/iu.test(
      content,
    );
  }
}
