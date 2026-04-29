import { RagflowRetrievalChunk } from '../../../integrations/rag/ragflow.types';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';

export const DOCUMENT_RETRIEVAL_DEFAULT_TOP_K = 6;
export const DOCUMENT_RETRIEVAL_DEFAULT_CANDIDATE_K = 24;
export const RAGFLOW_RETRIEVAL_TOP_K = 1024;
export const ALL_DOCUMENT_CLASSES = Object.values(DocumentDocClass);

export interface DocumentRetrievalHints {
  equipmentOrSystem: string[];
  manufacturer: string[];
  model: string[];
  contentFocus: string[];
}

export interface DocumentRetrievalFilterContext {
  topK: number;
  candidateK: number;
  requestedDocClasses: DocumentDocClass[];
  hints: DocumentRetrievalHints;
  hasMetadataHints: boolean;
  allowMultiDocument: boolean;
  documentTitleHint: string | null;
}

export interface DocumentRetrievalCandidateScoreInput {
  retrievalScore: number | null;
  document: Pick<
    DocumentEntity,
    | 'docClass'
    | 'equipmentOrSystem'
    | 'manufacturer'
    | 'model'
    | 'contentFocus'
    | 'sourcePriority'
    | 'originalFileName'
  >;
  questionType: DocumentRetrievalQuestionType | null;
  requestedDocClasses: DocumentDocClass[];
  hints: DocumentRetrievalHints;
  documentTitleHint: string | null;
  content: string;
}

export interface EnrichedDocumentRetrievalCandidate {
  chunk: RagflowRetrievalChunk;
  document: DocumentEntity;
  retrievalScore: number | null;
  rerankScore: number;
}

export function matchesAnyRetrievalHint(
  value: string | null,
  hints: string[],
): boolean {
  const normalizedValue = value?.trim().toLowerCase();

  if (!normalizedValue) {
    return false;
  }

  return hints.some((hint) => normalizedValue.includes(hint));
}

export const DOCUMENT_TITLE_HINT_NARROWING_THRESHOLD = 0.5;

/**
 * Returns a 0..1 score describing how well a stored document name matches a
 * free-form title/filename hint supplied by the caller. Uses conservative
 * token-overlap matching against the normalized filename (extension stripped)
 * — no exact-match coupling and no per-document hardcoding.
 */
export function scoreDocumentTitleHintMatch(
  fileName: string | null | undefined,
  hint: string | null | undefined,
): number {
  const tokens = tokenizeDocumentTitleHint(hint);

  if (!tokens.length) {
    return 0;
  }

  const normalizedName = normalizeDocumentTitleString(fileName ?? '');

  if (!normalizedName) {
    return 0;
  }

  const matchedTokenCount = tokens.reduce(
    (count, token) => count + (normalizedName.includes(token) ? 1 : 0),
    0,
  );

  return matchedTokenCount / tokens.length;
}

function normalizeDocumentTitleString(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeDocumentTitleHint(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}
