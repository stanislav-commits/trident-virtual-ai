const MAX_RETRIEVAL_QUERY_LENGTH = 240;
const MIN_RETRIEVAL_QUERY_LENGTH = 6;
const MAX_ANSWER_LANGUAGE_LENGTH = 40;
const MAX_DOCUMENT_LANGUAGE_HINT_LENGTH = 40;
const DOCUMENT_LANGUAGE_CONTEXT_WINDOW = 48;

const GENERIC_RETRIEVAL_QUERY_TERMS = new Set([
  'answer',
  'content',
  'detail',
  'details',
  'document',
  'documents',
  'file',
  'files',
  'information',
  'manual',
  'pdf',
  'procedure',
  'procedures',
  'question',
  'related',
  'relevant',
  'ship',
  'uploaded',
  'vessel',
]);

interface NormalizeDocumentRetrievalQueryInput {
  originalQuestion: string;
  retrievalQuery: unknown;
  documentTitleHint?: string | null;
}

interface NormalizeDocumentLanguageHintInput {
  originalQuestion: string;
  retrievalQuery?: string | null;
  languageHint: unknown;
  answerLanguage?: string | null;
  documentTitleHint?: string | null;
}

export function normalizeDocumentRetrievalQuery(
  input: NormalizeDocumentRetrievalQueryInput,
): string | null {
  if (typeof input.retrievalQuery !== 'string') {
    return null;
  }

  const normalized = normalizeWhitespace(input.retrievalQuery);

  if (
    normalized.length < MIN_RETRIEVAL_QUERY_LENGTH ||
    normalized.length > MAX_RETRIEVAL_QUERY_LENGTH ||
    !hasSubstantiveRetrievalTerms(normalized) ||
    isOnlyDocumentTitleHint(normalized, input.documentTitleHint) ||
    !preservesObviousEntities(
      input.originalQuestion,
      normalized,
      input.documentTitleHint,
    )
  ) {
    return null;
  }

  return normalized;
}

export function normalizeDocumentAnswerLanguage(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeWhitespace(value);

  if (
    normalized.length === 0 ||
    normalized.length > MAX_ANSWER_LANGUAGE_LENGTH ||
    /[\r\n{}[\]]/u.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

export function normalizeDocumentLanguageHint(
  input: NormalizeDocumentLanguageHintInput,
): string | null {
  if (typeof input.languageHint !== 'string') {
    return null;
  }

  const normalized = normalizeWhitespace(input.languageHint);

  if (
    normalized.length === 0 ||
    normalized.length > MAX_DOCUMENT_LANGUAGE_HINT_LENGTH ||
    /[\r\n{}[\]]/u.test(normalized)
  ) {
    return null;
  }

  if (!hasExplicitDocumentLanguageContext(input, normalized)) {
    return null;
  }

  return normalized;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasExplicitDocumentLanguageContext(
  input: NormalizeDocumentLanguageHintInput,
  languageHint: string,
): boolean {
  const searchableTexts = [
    input.originalQuestion,
    input.retrievalQuery ?? '',
  ].map((value) => removeDocumentTitleHint(value, input.documentTitleHint));

  return searchableTexts.some((text) =>
    hasLanguageHintNearDocumentMarker(text, languageHint),
  );
}

function hasLanguageHintNearDocumentMarker(
  value: string,
  languageHint: string,
): boolean {
  const normalizedText = value.toLocaleLowerCase();
  const normalizedHint = languageHint.toLocaleLowerCase();

  if (!normalizedText || !normalizedHint) {
    return false;
  }

  let index = normalizedText.indexOf(normalizedHint);

  while (index >= 0) {
    if (
      hasTokenBoundary(normalizedText, index, normalizedHint.length) &&
      hasDocumentLanguageMarker(
        normalizedText.slice(
          Math.max(0, index - DOCUMENT_LANGUAGE_CONTEXT_WINDOW),
          Math.min(
            normalizedText.length,
            index + normalizedHint.length + DOCUMENT_LANGUAGE_CONTEXT_WINDOW,
          ),
        ),
      )
    ) {
      return true;
    }

    index = normalizedText.indexOf(normalizedHint, index + normalizedHint.length);
  }

  return false;
}

function hasDocumentLanguageMarker(value: string): boolean {
  return /\b(?:corpus|document|documents|file|files|language|manual|manuals|pdf|section|sections|stored|uploaded|version)\b/u.test(
    value,
  );
}

function hasTokenBoundary(value: string, index: number, length: number): boolean {
  return (
    !isLetterOrNumber(value[index - 1]) &&
    !isLetterOrNumber(value[index + length])
  );
}

function isLetterOrNumber(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function hasSubstantiveRetrievalTerms(value: string): boolean {
  const meaningfulTokens = extractSearchTokens(value).filter(
    (token) => token.length >= 3,
  );

  if (!meaningfulTokens.length) {
    return false;
  }

  return meaningfulTokens.some(
    (token) => !GENERIC_RETRIEVAL_QUERY_TERMS.has(token),
  );
}

function isOnlyDocumentTitleHint(
  retrievalQuery: string,
  documentTitleHint?: string | null,
): boolean {
  if (!documentTitleHint?.trim()) {
    return false;
  }

  return (
    normalizeComparableText(retrievalQuery) ===
    normalizeComparableText(documentTitleHint)
  );
}

function preservesObviousEntities(
  originalQuestion: string,
  retrievalQuery: string,
  documentTitleHint?: string | null,
): boolean {
  const originalWithoutTitle = removeDocumentTitleHint(
    originalQuestion,
    documentTitleHint,
  );
  const requiredEntities = extractObviousEntityTokens(originalWithoutTitle);

  if (!requiredEntities.length) {
    return true;
  }

  const queryEntities = new Set(
    extractRawTokens(retrievalQuery).map((token) => normalizeEntityToken(token)),
  );

  return requiredEntities.every((token) => queryEntities.has(token));
}

function removeDocumentTitleHint(
  value: string,
  documentTitleHint?: string | null,
): string {
  if (!documentTitleHint?.trim()) {
    return value;
  }

  return value.replace(documentTitleHint, ' ');
}

function extractSearchTokens(value: string): string[] {
  return extractRawTokens(value)
    .map((token) => normalizeEntityToken(token))
    .filter(Boolean);
}

function extractRawTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
}

function extractObviousEntityTokens(value: string): string[] {
  return Array.from(
    new Set(
      extractRawTokens(value)
        .filter(isObviousEntityToken)
        .map((token) => normalizeEntityToken(token))
        .filter(Boolean),
    ),
  );
}

function isObviousEntityToken(token: string): boolean {
  const stripped = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const letters = stripped.match(/\p{L}/gu)?.join('') ?? '';

  if (!stripped) {
    return false;
  }

  if (/\d/u.test(stripped) && stripped.length >= 2) {
    return true;
  }

  if (/\.(?:pdf|docx?|xlsx?|txt)$/iu.test(stripped)) {
    return true;
  }

  return (
    letters.length >= 2 &&
    letters === letters.toLocaleUpperCase() &&
    letters !== letters.toLocaleLowerCase()
  );
}

function normalizeEntityToken(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeComparableText(value: string): string {
  return normalizeEntityToken(value);
}
