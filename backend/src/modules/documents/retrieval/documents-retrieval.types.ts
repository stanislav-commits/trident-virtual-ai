import { RagflowRetrievalChunk } from '../../../integrations/rag/ragflow.types';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';

export const DOCUMENT_RETRIEVAL_DEFAULT_TOP_K = 6;
export const DOCUMENT_RETRIEVAL_DEFAULT_CANDIDATE_K = 24;
export const RAGFLOW_RETRIEVAL_TOP_K = 1024;
// Lean retrieval toward semantic (vector) similarity rather than keyword overlap.
// RAGFlow's default (~0.3) lets weak term overlap drown a strong vector match, so
// a semantically-correct chunk phrased with different words ("lube oil" vs the
// manual's "engine oil pressure") scored low and got rejected by the evidence
// gate. Embeddings already bridge synonyms; this lets that signal dominate so we
// don't need hand-maintained synonym lists. Kept at 0.55 (not higher) so exact
// tokens — model/part numbers like "VS-350" / "ACB 331" — still carry weight.
export const RAGFLOW_VECTOR_SIMILARITY_WEIGHT = 0.55;
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
  requireDocumentTitleMatch: boolean;
}

export interface DocumentRetrievalCandidateScoreInput {
  question: string;
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
  expansion?: {
    anchorChunkId: string;
    reason:
      | 'procedure_continuation'
      | 'table_context'
      | 'section_context'
      | 'exact_title_weak_evidence';
  };
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
const GENERIC_DOCUMENT_TITLE_TOKENS = new Set([
  'doc',
  'document',
  'documents',
  'file',
  'manual',
  'manuals',
  'pdf',
]);

/**
 * Returns a 0..1 score describing how well a stored document name matches a
 * free-form title/filename hint supplied by the caller. Uses conservative
 * token-overlap matching against the normalized filename with no per-document
 * hardcoding.
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

  const normalizedHint = normalizeDocumentTitleString(hint ?? '');

  if (normalizedHint && normalizedName.includes(normalizedHint)) {
    return 1;
  }

  const significantTokens = tokens.filter(
    (token) => !GENERIC_DOCUMENT_TITLE_TOKENS.has(token),
  );
  const tokensForScoring = significantTokens.length ? significantTokens : tokens;

  const matchedTokenCount = tokensForScoring.reduce(
    (count, token) => count + (normalizedName.includes(token) ? 1 : 0),
    0,
  );

  return matchedTokenCount / tokensForScoring.length;
}

function normalizeDocumentTitleString(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[\p{L}\p{N}]{1,8}$/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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
        .split(/[^\p{L}\p{N}]+/gu)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}
