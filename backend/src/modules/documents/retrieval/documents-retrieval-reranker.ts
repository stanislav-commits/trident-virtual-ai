import { Injectable } from '@nestjs/common';
import { RagflowRetrievalChunk } from '../../../integrations/rag/ragflow.types';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';
import { getPreferredDocumentClassesForQuestionType } from './document-question-class-policy';
import { getQuestionTypeSectionBonus } from './documents-retrieval-text-signals';
import {
  DocumentRetrievalCandidateScoreInput,
  DocumentRetrievalFilterContext,
  EnrichedDocumentRetrievalCandidate,
  matchesAnyRetrievalHint,
  scoreDocumentTitleHintMatch,
} from './documents-retrieval.types';

@Injectable()
export class DocumentsRetrievalReranker {
  enrichCandidates(
    chunks: RagflowRetrievalChunk[],
    documentsByRagflowId: Map<string, DocumentEntity>,
    context: DocumentRetrievalFilterContext,
    questionType: DocumentRetrievalQuestionType | null,
  ): EnrichedDocumentRetrievalCandidate[] {
    return chunks
      .map((chunk) => {
        const document = chunk.document_id
          ? documentsByRagflowId.get(chunk.document_id)
          : undefined;

        if (!document || !chunk.id) {
          return null;
        }

        const retrievalScore =
          typeof chunk.similarity === 'number' ? chunk.similarity : null;
        const content = chunk.content ?? '';

        return {
          chunk,
          document,
          retrievalScore,
          rerankScore: scoreDocumentRetrievalCandidate({
            retrievalScore,
            document,
            requestedDocClasses: context.requestedDocClasses,
            hints: context.hints,
            documentTitleHint: context.documentTitleHint,
            questionType,
            content,
          }),
        };
      })
      .filter((item): item is EnrichedDocumentRetrievalCandidate => item !== null)
      .sort((left, right) => right.rerankScore - left.rerankScore);
  }

  selectResults(
    candidates: EnrichedDocumentRetrievalCandidate[],
    topK: number,
    allowMultiDocument: boolean,
  ): EnrichedDocumentRetrievalCandidate[] {
    if (!allowMultiDocument) {
      return candidates.slice(0, topK);
    }

    const selected: EnrichedDocumentRetrievalCandidate[] = [];
    const perDocumentCount = new Map<string, number>();

    for (const candidate of candidates) {
      const count = perDocumentCount.get(candidate.document.id) ?? 0;

      if (count >= 2 && selected.length < topK) {
        continue;
      }

      selected.push(candidate);
      perDocumentCount.set(candidate.document.id, count + 1);

      if (selected.length >= topK) {
        break;
      }
    }

    if (selected.length < topK) {
      for (const candidate of candidates) {
        if (selected.includes(candidate)) {
          continue;
        }

        selected.push(candidate);
        if (selected.length >= topK) break;
      }
    }

    return selected;
  }
}

export function scoreDocumentRetrievalCandidate(
  input: DocumentRetrievalCandidateScoreInput,
): number {
  const baseScore = clamp01(input.retrievalScore ?? 0);
  const docClassBonus = input.requestedDocClasses.includes(input.document.docClass)
    ? 0.04
    : 0;
  const questionTypeBonus = getQuestionTypeClassBonus(
    input.questionType,
    input.document.docClass,
  );
  const metadataBonus =
    getHintMatchBonus(input.document.equipmentOrSystem, input.hints.equipmentOrSystem) +
    getHintMatchBonus(input.document.manufacturer, input.hints.manufacturer) +
    getHintMatchBonus(input.document.model, input.hints.model) +
    getHintMatchBonus(input.document.contentFocus, input.hints.contentFocus);
  const priorityBonus = Math.max(
    0,
    Math.min(0.05, (100 - input.document.sourcePriority) / 1000),
  );
  const sectionBonus = getQuestionTypeSectionBonus(
    input.questionType,
    input.content,
  );
  const titleHintBonus = getDocumentTitleHintBonus(
    input.document.originalFileName,
    input.documentTitleHint,
  );

  return roundScore(
    baseScore +
      docClassBonus +
      questionTypeBonus +
      metadataBonus +
      priorityBonus +
      sectionBonus +
      titleHintBonus,
  );
}

function getQuestionTypeClassBonus(
  questionType: DocumentRetrievalQuestionType | null,
  docClass: DocumentDocClass,
): number {
  if (!questionType) {
    return 0;
  }

  return getPreferredDocumentClassesForQuestionType(questionType).includes(docClass)
    ? 0.07
    : 0;
}

function getHintMatchBonus(value: string | null, hints: string[]): number {
  if (!hints.length) {
    return 0;
  }

  return matchesAnyRetrievalHint(value, hints) ? 0.035 : 0;
}

function getDocumentTitleHintBonus(
  fileName: string | null | undefined,
  hint: string | null,
): number {
  if (!hint) {
    return 0;
  }

  const matchScore = scoreDocumentTitleHintMatch(fileName, hint);
  return matchScore > 0 ? matchScore * 0.08 : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
