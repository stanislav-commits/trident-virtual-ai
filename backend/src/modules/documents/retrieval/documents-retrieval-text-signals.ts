import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';

export interface QuestionSupportSignals {
  questionTokenCount: number;
  supportedQuestionTokenCount: number;
  supportScore: number;
  specificTokenCount: number;
  supportedSpecificTokenCount: number;
  specificSupportScore: number;
  hasSpecificTokens: boolean;
  hasOnlyGenericSupport: boolean;
}

const BASIC_STOP_WORDS = new Set([
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

const GENERIC_DOMAIN_TOKENS = new Set([
  'according',
  'action',
  'actions',
  'approval',
  'approvals',
  'approved',
  'certificate',
  'certificates',
  'check',
  'checklist',
  'checklists',
  'class',
  'compliance',
  'document',
  'documents',
  'equipment',
  'issued',
  'issuer',
  'maintain',
  'maintained',
  'maintenance',
  'manual',
  'manuals',
  'onboard',
  'operate',
  'operating',
  'operation',
  'operational',
  'operations',
  'procedure',
  'procedures',
  'require',
  'required',
  'requirement',
  'requirements',
  'rule',
  'rules',
  'safe',
  'safety',
  'ship',
  'sop',
  'status',
  'step',
  'steps',
  'system',
  'systems',
  'valid',
  'validity',
  'vessel',
]);

// Weak generic text signals for reranking/evidence gating only; not routing rules.
export function getQuestionTypeSectionBonus(
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

export function hasQuestionTypeSectionSignal(
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

export function getQuestionSupportScore(question: string, content: string): number {
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

export function getQuestionSupportSignals(
  question: string,
  content: string,
): QuestionSupportSignals {
  const questionTokens = getMeaningfulTokens(question);
  const specificTokens = questionTokens.filter(
    (token) => !GENERIC_DOMAIN_TOKENS.has(token),
  );
  const contentTokens = getSearchableTokens(content);
  const supportedQuestionTokenCount = questionTokens.filter((token) =>
    isTokenSupported(token, contentTokens),
  ).length;
  const supportedSpecificTokenCount = specificTokens.filter((token) =>
    isTokenSupported(token, contentTokens),
  ).length;

  return {
    questionTokenCount: questionTokens.length,
    supportedQuestionTokenCount,
    supportScore: questionTokens.length
      ? supportedQuestionTokenCount / questionTokens.length
      : 0,
    specificTokenCount: specificTokens.length,
    supportedSpecificTokenCount,
    specificSupportScore: specificTokens.length
      ? supportedSpecificTokenCount / specificTokens.length
      : 1,
    hasSpecificTokens: specificTokens.length > 0,
    hasOnlyGenericSupport:
      specificTokens.length > 0 &&
      supportedQuestionTokenCount > 0 &&
      supportedSpecificTokenCount === 0,
  };
}

function getMeaningfulTokens(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/gu)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !BASIC_STOP_WORDS.has(token)),
    ),
  );
}

function getSearchableTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function isTokenSupported(token: string, contentTokens: string[]): boolean {
  return contentTokens.some(
    (contentToken) =>
      contentToken === token ||
      stripPluralSuffix(contentToken) === token ||
      contentToken === stripPluralSuffix(token),
  );
}

function stripPluralSuffix(value: string): string {
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}

function hasOrderedStepSignal(content: string): boolean {
  return /(^|\n)\s*(step\s+\d+|\d+[.)])\s+/i.test(content);
}

function hasAnyTerm(content: string, terms: string[]): boolean {
  return terms.some((term) => content.includes(term));
}
