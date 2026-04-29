import { Injectable } from '@nestjs/common';
import { RagflowRetrievalChunk } from '../../../integrations/rag/ragflow.types';
import { DocumentRetrievalEvidenceQuality } from '../dto/document-retrieval-response.dto';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';
import {
  DocumentRetrievalCandidateScoreInput,
  DocumentRetrievalFilterContext,
  EnrichedDocumentRetrievalCandidate,
  matchesAnyRetrievalHint,
  scoreDocumentTitleHintMatch,
} from './documents-retrieval.types';

interface DocumentRetrievalEvidenceAssessmentInput {
  candidates: EnrichedDocumentRetrievalCandidate[];
  question: string;
  questionType: DocumentRetrievalQuestionType | null;
}

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

export function selectDocumentRetrievalEvidenceQuality(
  topRerankScore: number | null,
  resultCount: number,
): DocumentRetrievalEvidenceQuality {
  if (!resultCount || topRerankScore === null) {
    return 'none';
  }

  if (topRerankScore >= 0.45) {
    return 'strong';
  }

  if (topRerankScore >= 0.2) {
    return 'weak';
  }

  return 'none';
}

export function assessDocumentRetrievalEvidenceQuality(
  input: DocumentRetrievalEvidenceAssessmentInput,
): DocumentRetrievalEvidenceQuality {
  const [topCandidate] = input.candidates;

  if (!topCandidate) {
    return 'none';
  }

  const topRetrievalScore = topCandidate.retrievalScore ?? 0;
  const topRerankScore = topCandidate.rerankScore;
  const topQuestionSupport = getQuestionSupportScore(
    input.question,
    topCandidate.chunk.content ?? '',
  );
  const supportedCandidateCount = input.candidates.filter((candidate) =>
    hasUsableQuestionSupport(input.question, input.questionType, candidate),
  ).length;
  const hasSectionSignal = hasQuestionTypeSectionSignal(
    input.questionType,
    topCandidate.chunk.content ?? '',
  );

  if (
    topRetrievalScore < 0.18 ||
    (topRerankScore < 0.3 && supportedCandidateCount === 0) ||
    (topRetrievalScore < 0.24 &&
      topQuestionSupport < 0.5 &&
      supportedCandidateCount === 0)
  ) {
    return 'none';
  }

  if (
    topRetrievalScore >= 0.45 ||
    (topRetrievalScore >= 0.3 &&
      topRerankScore >= 0.38 &&
      topQuestionSupport >= 0.65) ||
    (input.questionType === DocumentRetrievalQuestionType.TROUBLESHOOTING &&
      topRetrievalScore >= 0.28 &&
      topRerankScore >= 0.38 &&
      topQuestionSupport >= 0.65) ||
    (input.questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE &&
      topRetrievalScore >= 0.25 &&
      topRerankScore >= 0.42 &&
      topQuestionSupport >= 0.5 &&
      hasSectionSignal &&
      supportedCandidateCount >= 2)
  ) {
    return 'strong';
  }

  return 'weak';
}

function getQuestionTypeClassBonus(
  questionType: DocumentRetrievalQuestionType | null,
  docClass: DocumentDocClass,
): number {
  if (!questionType) {
    return 0;
  }

  const preferredClasses: Partial<
    Record<DocumentRetrievalQuestionType, DocumentDocClass[]>
  > = {
    [DocumentRetrievalQuestionType.EQUIPMENT_REFERENCE]: [DocumentDocClass.MANUAL],
    [DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE]: [
      DocumentDocClass.HISTORICAL_PROCEDURE,
      DocumentDocClass.MANUAL,
    ],
    [DocumentRetrievalQuestionType.HISTORICAL_CASE]: [
      DocumentDocClass.HISTORICAL_PROCEDURE,
    ],
    [DocumentRetrievalQuestionType.COMPLIANCE_OR_CERTIFICATE]: [
      DocumentDocClass.CERTIFICATE,
      DocumentDocClass.REGULATION,
    ],
    [DocumentRetrievalQuestionType.TROUBLESHOOTING]: [DocumentDocClass.MANUAL],
  };

  return preferredClasses[questionType]?.includes(docClass) ? 0.07 : 0;
}

function getQuestionTypeSectionBonus(
  questionType: DocumentRetrievalQuestionType | null,
  content: string,
): number {
  if (!questionType || !content.trim()) {
    return 0;
  }

  const normalized = content.toLowerCase();

  if (questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE) {
    const hasOrderedStep = hasOrderedStepSignal(content);
    const hasProcedureLanguage = hasAnyTerm(normalized, [
      'procedure',
      'before',
      'after',
      'verify',
    ]);
    return hasOrderedStep || hasProcedureLanguage ? 0.06 : 0;
  }

  if (questionType === DocumentRetrievalQuestionType.TROUBLESHOOTING) {
    return hasAnyTerm(normalized, [
      'alarm',
      'fault',
      'cause',
      'remedy',
      'troubleshoot',
      'warning',
    ])
      ? 0.05
      : 0;
  }

  return 0;
}

function hasUsableQuestionSupport(
  question: string,
  questionType: DocumentRetrievalQuestionType | null,
  candidate: EnrichedDocumentRetrievalCandidate,
): boolean {
  if ((candidate.retrievalScore ?? 0) < 0.18) {
    return false;
  }

  const content = candidate.chunk.content ?? '';
  const questionSupport = getQuestionSupportScore(question, content);

  return (
    questionSupport >= 0.5 ||
    (questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE &&
      questionSupport >= 0.35 &&
      hasQuestionTypeSectionSignal(questionType, content))
  );
}

function hasQuestionTypeSectionSignal(
  questionType: DocumentRetrievalQuestionType | null,
  content: string,
): boolean {
  if (!questionType || !content.trim()) {
    return false;
  }

  const normalized = content.toLowerCase();

  if (questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE) {
    return (
      hasOrderedStepSignal(content) ||
      hasAnyTerm(normalized, ['procedure', 'before', 'after', 'verify'])
    );
  }

  if (questionType === DocumentRetrievalQuestionType.TROUBLESHOOTING) {
    return hasAnyTerm(normalized, [
      'alarm',
      'fault',
      'cause',
      'remedy',
      'troubleshoot',
      'warning',
    ]);
  }

  return false;
}

function getQuestionSupportScore(question: string, content: string): number {
  const questionTokens = getMeaningfulTokens(question);

  if (!questionTokens.length || !content.trim()) {
    return 0;
  }

  const normalizedContent = content.toLowerCase();
  const matchedTokens = questionTokens.filter((token) =>
    normalizedContent.includes(token),
  );

  return matchedTokens.length / questionTokens.length;
}

function getMeaningfulTokens(value: string): string[] {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'for',
    'from',
    'how',
    'into',
    'the',
    'this',
    'that',
    'what',
    'when',
    'where',
    'which',
    'with',
  ]);

  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token)),
    ),
  );
}

function hasOrderedStepSignal(content: string): boolean {
  return /(^|\n)\s*(step\s+\d+|\d+[.)])\s+/i.test(content);
}

function hasAnyTerm(content: string, terms: string[]): boolean {
  return terms.some((term) => content.includes(term));
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
