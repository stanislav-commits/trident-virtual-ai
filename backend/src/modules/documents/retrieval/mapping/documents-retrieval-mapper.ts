import { Injectable } from '@nestjs/common';
import { SourceReferenceDto } from '../../../../common/dto/source-reference.dto';
import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../dto/document-retrieval-response.dto';
import { SearchDocumentsDto } from '../../dto/search-documents.dto';
import { DocumentEntity } from '../../entities/document.entity';
import {
  DocumentRetrievalFilterContext,
  EnrichedDocumentRetrievalCandidate,
} from '../documents-retrieval.types';
import { extractFirstChunkPage } from '../chunks/documents-retrieval-chunk-utils';

const MAX_SNIPPET_LENGTH = 1600;
const PMS_SUMMARY_LEAD_LENGTH = 560;

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
    const references =
      options.evidenceQuality === 'none'
        ? []
        : this.toReferences(options.results);

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
          documentTitle: options.context.documentTitleHint,
          requireDocumentTitleMatch: options.context.requireDocumentTitleMatch,
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
      references,
      diagnostics: {
        usableDocumentCount: options.usableDocumentCount,
        retrievedCandidateCount: options.retrievedCandidateCount,
        enrichedCandidateCount: options.enrichedCandidateCount,
        metadataMatchedDocumentCount: options.metadataMatchedDocumentCount,
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
          documentTitle: options.context.documentTitleHint,
          requireDocumentTitleMatch: options.context.requireDocumentTitleMatch,
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
        metadataMatchedDocumentCount: 0,
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
      page: extractFirstChunkPage(candidate.chunk.positions),
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
        equipmentName: candidate.document.equipmentName,
        equipmentAliases: candidate.document.equipmentAliases,
        manufacturer: candidate.document.manufacturer,
        model: candidate.document.model,
        systemArea: candidate.document.systemArea,
        documentPurpose: candidate.document.documentPurpose,
        documentRole: candidate.document.documentRole,
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
    const pmsEquipmentSummarySnippet =
      this.buildPmsEquipmentSummarySnippet(normalized);

    if (pmsEquipmentSummarySnippet) {
      return pmsEquipmentSummarySnippet;
    }

    if (normalized.length <= MAX_SNIPPET_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, MAX_SNIPPET_LENGTH - 1).trim()}\u2026`;
  }

  private buildPmsEquipmentSummarySnippet(content: string): string | null {
    if (
      !/\bdoc_type:\s*equipment_summary\b/i.test(content) ||
      !/\b(?:all registered maintenance tasks|next upcoming task|tasks_due_soon|tasks_overdue)\b/i.test(
        content,
      )
    ) {
      return null;
    }

    const overviewStart = this.findFirstIndex(content, [
      /\bThis equipment has\b/i,
      /\bAll registered maintenance tasks\b/i,
      /\bNext upcoming task\b/i,
    ]);

    if (overviewStart < 0 || content.length <= MAX_SNIPPET_LENGTH) {
      return this.trimToSnippetLength(content);
    }

    const lead = content.slice(0, PMS_SUMMARY_LEAD_LENGTH).trim();
    const overview = content.slice(overviewStart).trim();
    const separator = lead && overview ? ' … ' : '';
    const combined = `${lead}${separator}${overview}`;

    return this.trimToSnippetLength(combined);
  }

  private findFirstIndex(content: string, patterns: RegExp[]): number {
    return patterns.reduce((first, pattern) => {
      const match = pattern.exec(content);

      if (!match?.index && match?.index !== 0) {
        return first;
      }

      return first < 0 ? match.index : Math.min(first, match.index);
    }, -1);
  }

  private trimToSnippetLength(content: string): string {
    if (content.length <= MAX_SNIPPET_LENGTH) {
      return content;
    }

    return `${content.slice(0, MAX_SNIPPET_LENGTH - 1).trim()}\u2026`;
  }

}
