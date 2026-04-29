import { Injectable } from '@nestjs/common';
import { SourceReferenceDto } from '../../../common/dto/source-reference.dto';
import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../dto/document-retrieval-response.dto';
import { SearchDocumentsDto } from '../dto/search-documents.dto';
import { DocumentEntity } from '../entities/document.entity';
import {
  DocumentRetrievalFilterContext,
  EnrichedDocumentRetrievalCandidate,
} from './documents-retrieval.types';

const MAX_SNIPPET_LENGTH = 900;

interface BuildRetrievalResponseOptions {
  input: SearchDocumentsDto;
  normalizedQuestion: string;
  shipId: string;
  shipDatasetId: string;
  context: DocumentRetrievalFilterContext;
  retrievalDocuments: DocumentEntity[];
  metadataMatchedDocumentCount: number;
  usableDocumentCount: number;
  retrievedCandidateCount: number;
  enrichedCandidateCount: number;
  ragflowTotal: number | null;
  evidenceQuality: DocumentRetrievalEvidenceQuality;
  results: DocumentRetrievalResultDto[];
}

interface BuildEmptyRetrievalResponseOptions {
  input: SearchDocumentsDto;
  normalizedQuestion: string;
  shipId: string;
  shipDatasetId: string | null;
  context: DocumentRetrievalFilterContext;
  reason: string;
  usableDocumentCount?: number;
}

@Injectable()
export class DocumentsRetrievalMapper {
  toResults(
    candidates: EnrichedDocumentRetrievalCandidate[],
  ): DocumentRetrievalResultDto[] {
    return candidates.map((candidate, index) =>
      this.toResult(candidate, index + 1),
    );
  }

  buildResponse(options: BuildRetrievalResponseOptions): DocumentRetrievalResponseDto {
    return {
      normalizedQuestion: options.normalizedQuestion,
      shipId: options.shipId,
      appliedFilters: {
        shipDatasetId: options.shipDatasetId,
        parseStatus: 'parsed',
        candidateDocClasses: options.context.requestedDocClasses,
        questionType: options.input.questionType ?? null,
        ragflowDocumentIds: this.toRagflowDocumentIds(options.retrievalDocuments),
        metadataMode:
          options.context.hasMetadataHints && options.metadataMatchedDocumentCount > 0
            ? 'document_ids_from_local_metadata'
            : options.context.hasMetadataHints
              ? 'local_rerank_only'
              : 'not_requested',
        metadataFiltering: 'local_only',
        hints: {
          ...options.context.hints,
          language: options.input.languageHint?.trim() || null,
        },
        topK: options.context.topK,
        candidateK: options.context.candidateK,
        allowMultiDocument: options.context.allowMultiDocument,
        allowWeakEvidence: Boolean(options.input.allowWeakEvidence),
      },
      evidenceQuality: options.evidenceQuality,
      answerability: {
        status: options.evidenceQuality,
        reason: this.buildAnswerabilityReason(
          options.evidenceQuality,
          options.results.length,
        ),
      },
      results: options.results,
      references: this.toReferences(options.results),
      diagnostics: {
        usableDocumentCount: options.usableDocumentCount,
        retrievedCandidateCount: options.retrievedCandidateCount,
        enrichedCandidateCount: options.enrichedCandidateCount,
        ragflowTotal: options.ragflowTotal,
        metadataFilteringSupported: 'api_available_but_not_enabled_in_trident',
      },
      summary: this.buildTechnicalSummary(
        options.evidenceQuality,
        options.results.length,
      ),
      data: {
        normalizedQuestion: options.normalizedQuestion,
        shipId: options.shipId,
        evidenceQuality: options.evidenceQuality,
        resultCount: options.results.length,
      },
    };
  }

  buildEmptyResponse(
    options: BuildEmptyRetrievalResponseOptions,
  ): DocumentRetrievalResponseDto {
    return {
      normalizedQuestion: options.normalizedQuestion,
      shipId: options.shipId,
      appliedFilters: {
        shipDatasetId: options.shipDatasetId,
        parseStatus: 'parsed',
        candidateDocClasses: options.context.requestedDocClasses,
        questionType: options.input.questionType ?? null,
        ragflowDocumentIds: [],
        metadataMode: options.context.hasMetadataHints
          ? 'local_rerank_only'
          : 'not_requested',
        metadataFiltering: 'local_only',
        hints: {
          ...options.context.hints,
          language: options.input.languageHint?.trim() || null,
        },
        topK: options.context.topK,
        candidateK: options.context.candidateK,
        allowMultiDocument: options.context.allowMultiDocument,
        allowWeakEvidence: Boolean(options.input.allowWeakEvidence),
      },
      evidenceQuality: 'none',
      answerability: {
        status: 'none',
        reason: options.reason,
      },
      results: [],
      references: [],
      diagnostics: {
        usableDocumentCount: options.usableDocumentCount ?? 0,
        retrievedCandidateCount: 0,
        enrichedCandidateCount: 0,
        ragflowTotal: null,
        metadataFilteringSupported: 'api_available_but_not_enabled_in_trident',
      },
      summary: 'Document retrieval found no usable evidence.',
      data: {
        normalizedQuestion: options.normalizedQuestion,
        shipId: options.shipId,
        evidenceQuality: 'none',
        resultCount: 0,
      },
    };
  }

  private toResult(
    candidate: EnrichedDocumentRetrievalCandidate,
    rank: number,
  ): DocumentRetrievalResultDto {
    return {
      rank,
      documentId: candidate.document.id,
      ragflowDocumentId: candidate.document.ragflowDocumentId!,
      chunkId: candidate.chunk.id,
      filename:
        candidate.document.originalFileName ||
        candidate.chunk.document_keyword ||
        candidate.chunk.docnm_kwd ||
        'document',
      docClass: candidate.document.docClass,
      parseProfile: candidate.document.parseProfile,
      page: this.extractPage(candidate.chunk.positions),
      section: null,
      snippet: this.trimSnippet(candidate.chunk.content ?? ''),
      highlightedSnippet:
        typeof candidate.chunk.highlight === 'string'
          ? this.trimSnippet(candidate.chunk.highlight)
          : null,
      retrievalScore: candidate.retrievalScore,
      vectorSimilarity:
        typeof candidate.chunk.vector_similarity === 'number'
          ? candidate.chunk.vector_similarity
          : null,
      termSimilarity:
        typeof candidate.chunk.term_similarity === 'number'
          ? candidate.chunk.term_similarity
          : null,
      rerankScore: candidate.rerankScore,
      metadataSummary: {
        equipmentOrSystem: candidate.document.equipmentOrSystem,
        manufacturer: candidate.document.manufacturer,
        model: candidate.document.model,
        revision: candidate.document.revision,
        language: candidate.document.language,
        timeScope: candidate.document.timeScope,
        sourcePriority: candidate.document.sourcePriority,
        contentFocus: candidate.document.contentFocus,
      },
    };
  }

  private toReferences(results: DocumentRetrievalResultDto[]): SourceReferenceDto[] {
    return results.map((result) => ({
      source: 'documents',
      title: result.filename,
      snippet: result.snippet,
      score: result.rerankScore,
      metadata: {
        documentId: result.documentId,
        ragflowDocumentId: result.ragflowDocumentId,
        chunkId: result.chunkId,
        docClass: result.docClass,
        page: result.page,
        retrievalScore: result.retrievalScore,
      },
    }));
  }

  private toRagflowDocumentIds(documents: DocumentEntity[]): string[] {
    return documents
      .map((document) => document.ragflowDocumentId)
      .filter((id): id is string => Boolean(id));
  }

  private buildAnswerabilityReason(
    quality: DocumentRetrievalEvidenceQuality,
    resultCount: number,
  ): string {
    if (quality === 'strong') {
      return `Retrieved ${resultCount} document evidence item${resultCount === 1 ? '' : 's'} with strong relevance.`;
    }

    if (quality === 'weak') {
      return `Retrieved ${resultCount} document evidence item${resultCount === 1 ? '' : 's'}, but relevance is weak and should be treated cautiously.`;
    }

    return 'No relevant parsed document evidence was retrieved.';
  }

  private buildTechnicalSummary(
    quality: DocumentRetrievalEvidenceQuality,
    resultCount: number,
  ): string {
    if (quality === 'none') {
      return 'Document retrieval completed with no evidence.';
    }

    return `Document retrieval completed with ${quality} evidence across ${resultCount} result${resultCount === 1 ? '' : 's'}.`;
  }

  private trimSnippet(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();

    if (normalized.length <= MAX_SNIPPET_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, MAX_SNIPPET_LENGTH - 1).trim()}\u2026`;
  }

  private extractPage(positions: unknown[] | undefined): number | null {
    for (const position of positions ?? []) {
      if (
        position &&
        typeof position === 'object' &&
        'page' in position &&
        typeof position.page === 'number'
      ) {
        return position.page;
      }

      if (
        position &&
        typeof position === 'object' &&
        'page_num' in position &&
        typeof position.page_num === 'number'
      ) {
        return position.page_num;
      }
    }

    return null;
  }
}
