import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';
import { EnrichedDocumentRetrievalCandidate } from './documents-retrieval.types';

const PROCEDURE_TERMS = new Set([
  'action',
  'actions',
  'checklist',
  'instruction',
  'instructions',
  'operation',
  'operations',
  'procedure',
  'procedures',
  'step',
  'steps',
]);

const QUESTION_STOP_TERMS = new Set([
  'about',
  'aboard',
  'after',
  'and',
  'are',
  'before',
  'carry',
  'carrying',
  'change',
  'changing',
  'check',
  'checking',
  'describe',
  'describes',
  'does',
  'doing',
  'how',
  'for',
  'from',
  'into',
  'install',
  'installing',
  'the',
  'through',
  'to',
  'manual',
  'manuals',
  'perform',
  'performing',
  'please',
  'procedure',
  'procedures',
  'remove',
  'removing',
  'replace',
  'replacement',
  'replacing',
  'run',
  'running',
  'safely',
  'service',
  'servicing',
  'ship',
  'show',
  'step',
  'steps',
  'this',
  'that',
  'vessel',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

const EARLY_SUBJECT_WINDOW = 260;

export function hasProcedureSubjectEvidence(input: {
  question: string;
  questionType: DocumentRetrievalQuestionType | null;
  candidate: EnrichedDocumentRetrievalCandidate;
}): boolean {
  if (input.questionType !== DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE) {
    return true;
  }

  if (!hasProcedureQuestionShape(input.question)) {
    return true;
  }

  if (!/[a-z]/u.test(normalize(input.question))) {
    return true;
  }

  const subjectTokens = extractProcedureSubjectTokens(input.question);

  if (!subjectTokens.length) {
    return true;
  }

  return hasSubjectSupport(input.candidate.chunk.content ?? '', subjectTokens);
}

export function countProcedureSubjectSupportedCandidates(input: {
  question: string;
  questionType: DocumentRetrievalQuestionType | null;
  candidates: EnrichedDocumentRetrievalCandidate[];
}): number {
  return input.candidates.filter((candidate) =>
    hasProcedureSubjectEvidence({
      question: input.question,
      questionType: input.questionType,
      candidate,
    }),
  ).length;
}

function hasProcedureQuestionShape(question: string): boolean {
  const normalized = normalize(question);

  return /\b(?:how|procedure|procedures|operation|operations|perform|do|steps|carry out|run)\b/u.test(
    normalized,
  );
}

function extractProcedureSubjectTokens(question: string): string[] {
  return tokenize(question)
    .map((token) => normalizeProcedureToken(token))
    .filter((token) => token.length >= 3)
    .filter((token) => !QUESTION_STOP_TERMS.has(token))
    .filter((token) => !PROCEDURE_TERMS.has(token));
}

function hasSubjectSupport(content: string, subjectTokens: string[]): boolean {
  const normalizedContent = normalize(content);
  const earlyContent = normalizedContent.slice(0, EARLY_SUBJECT_WINDOW);
  const searchableTokens = tokenize(normalizedContent);
  const supportedTokens = subjectTokens.filter((token) =>
    supportsToken(token, searchableTokens),
  );

  if (!supportedTokens.length) {
    return false;
  }

  const phrase = subjectTokens.join(' ');

  if (subjectTokens.length >= 2 && normalizedContent.includes(phrase)) {
    return true;
  }

  if (
    subjectTokens.length === 1 &&
    hasSingleSubjectProcedurePhrase(normalizedContent, subjectTokens[0])
  ) {
    return true;
  }

  if (
    subjectTokens.length >= 2 &&
    subjectTokens.some((token) => earlyContent.includes(token)) &&
    hasProcedureTerm(earlyContent)
  ) {
    return true;
  }

  return (
    subjectTokens.length >= 2 &&
    supportedTokens.length === subjectTokens.length &&
    hasProcedureTerm(normalizedContent)
  );
}

function hasSingleSubjectProcedurePhrase(content: string, subject: string): boolean {
  return (
    content.includes(`${subject} procedure`) ||
    content.includes(`${subject} procedures`) ||
    content.includes(`${subject} operation`) ||
    content.includes(`${subject} operations`) ||
    content.includes(`${subject} checklist`) ||
    content.includes(`procedure for ${subject}`) ||
    content.includes(`procedures for ${subject}`)
  );
}

function hasProcedureTerm(content: string): boolean {
  return tokenize(content).some((token) => PROCEDURE_TERMS.has(token));
}

function supportsToken(token: string, contentTokens: string[]): boolean {
  return contentTokens.some(
    (contentToken) =>
      contentToken === token ||
      stripPluralSuffix(contentToken) === token ||
      contentToken === stripPluralSuffix(token),
  );
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeProcedureToken(value: string): string {
  if (value === 'ops') {
    return 'operation';
  }

  if (value === 'bunker') {
    return 'bunkering';
  }

  if (
    value === 'renew' ||
    value === 'renewing' ||
    value === 'replaced' ||
    value === 'replaces'
  ) {
    return 'replace';
  }

  return value;
}

function stripPluralSuffix(value: string): string {
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}
