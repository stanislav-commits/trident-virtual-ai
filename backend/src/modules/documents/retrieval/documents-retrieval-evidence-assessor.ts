import { DocumentRetrievalEvidenceQuality } from '../dto/document-retrieval-response.dto';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';
import { getPreferredDocumentClassesForQuestionType } from './document-question-class-policy';
import { EnrichedDocumentRetrievalCandidate } from './documents-retrieval.types';
import {
  getQuestionSupportScore,
  getQuestionSupportSignals,
  hasQuestionTypeSectionSignal,
  QuestionSupportSignals,
} from './documents-retrieval-text-signals';

interface DocumentRetrievalEvidenceAssessmentInput {
  candidates: EnrichedDocumentRetrievalCandidate[];
  question: string;
  questionType: DocumentRetrievalQuestionType | null;
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
  const topSupportSignals = getQuestionSupportSignals(
    input.question,
    buildCandidateSupportText(topCandidate),
  );
  const supportedCandidateCount = input.candidates.filter((candidate) =>
    hasUsableQuestionSupport(input.question, input.questionType, candidate),
  ).length;
  const specificSupportedCandidateCount = input.candidates.filter((candidate) =>
    hasAdequateSpecificSupport(
      getQuestionSupportSignals(input.question, buildCandidateSupportText(candidate)),
    ),
  ).length;
  const hasSectionSignal = hasQuestionTypeSectionSignal(
    input.questionType,
    topCandidate.chunk.content ?? '',
  );
  const topClassFitsQuestion = hasQuestionTypeClassFit(
    input.questionType,
    topCandidate,
  );
  const classFitCandidateCount = input.candidates.filter((candidate) =>
    hasQuestionTypeClassFit(input.questionType, candidate),
  ).length;

  if (
    topRetrievalScore < 0.18 ||
    (topRerankScore < 0.3 && supportedCandidateCount === 0) ||
    (topRetrievalScore < 0.24 &&
      topQuestionSupport < 0.5 &&
      supportedCandidateCount === 0) ||
    hasInsufficientSpecificSupport(
      topSupportSignals,
      supportedCandidateCount,
      specificSupportedCandidateCount,
    ) ||
    hasInsufficientClassFit(
      topClassFitsQuestion,
      classFitCandidateCount,
      topSupportSignals,
      topQuestionSupport,
    )
  ) {
    return 'none';
  }

  const hasStrongSupport = hasStrongEvidenceSupport(
    topQuestionSupport,
    topSupportSignals,
    specificSupportedCandidateCount,
    topClassFitsQuestion,
  );

  if (
    (topRetrievalScore >= 0.45 && hasStrongSupport) ||
    (topRetrievalScore >= 0.3 &&
      topRerankScore >= 0.38 &&
      topQuestionSupport >= 0.65 &&
      hasStrongSupport) ||
    (input.questionType === DocumentRetrievalQuestionType.TROUBLESHOOTING &&
      topRetrievalScore >= 0.28 &&
      topRerankScore >= 0.38 &&
      topQuestionSupport >= 0.65 &&
      hasStrongSupport) ||
    (input.questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE &&
      topRetrievalScore >= 0.25 &&
      topRerankScore >= 0.42 &&
      topQuestionSupport >= 0.5 &&
      hasSectionSignal &&
      supportedCandidateCount >= 2 &&
      hasStrongSupport)
  ) {
    return 'strong';
  }

  return 'weak';
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
  const questionSupport = getQuestionSupportScore(
    question,
    buildCandidateSupportText(candidate),
  );
  const supportSignals = getQuestionSupportSignals(
    question,
    buildCandidateSupportText(candidate),
  );

  return (
    hasAdequateSpecificSupport(supportSignals) &&
    (questionSupport >= 0.5 ||
      (questionType === DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE &&
        questionSupport >= 0.35 &&
        hasQuestionTypeSectionSignal(questionType, content)))
  );
}

function hasInsufficientSpecificSupport(
  supportSignals: QuestionSupportSignals,
  supportedCandidateCount: number,
  specificSupportedCandidateCount: number,
): boolean {
  if (!supportSignals.hasSpecificTokens) {
    return false;
  }

  if (
    supportSignals.supportedSpecificTokenCount === 0 &&
    specificSupportedCandidateCount === 0
  ) {
    return true;
  }

  return (
    supportSignals.hasOnlyGenericSupport &&
    supportedCandidateCount <= 1 &&
    specificSupportedCandidateCount === 0
  );
}

function hasInsufficientClassFit(
  topClassFitsQuestion: boolean,
  classFitCandidateCount: number,
  supportSignals: QuestionSupportSignals,
  topQuestionSupport: number,
): boolean {
  if (topClassFitsQuestion || classFitCandidateCount > 0) {
    return false;
  }

  if (supportSignals.hasSpecificTokens) {
    return supportSignals.specificSupportScore < 0.75;
  }

  return topQuestionSupport < 0.65;
}

function hasStrongEvidenceSupport(
  topQuestionSupport: number,
  supportSignals: QuestionSupportSignals,
  specificSupportedCandidateCount: number,
  topClassFitsQuestion: boolean,
): boolean {
  if (!topClassFitsQuestion) {
    return false;
  }

  if (
    supportSignals.hasSpecificTokens &&
    supportSignals.specificSupportScore < 0.5 &&
    specificSupportedCandidateCount < 2
  ) {
    return false;
  }

  if (supportSignals.hasOnlyGenericSupport) {
    return false;
  }

  return topQuestionSupport >= 0.5 || !supportSignals.hasSpecificTokens;
}

function hasAdequateSpecificSupport(
  supportSignals: QuestionSupportSignals,
): boolean {
  return (
    !supportSignals.hasSpecificTokens ||
    supportSignals.specificSupportScore >= 0.5
  );
}

function hasQuestionTypeClassFit(
  questionType: DocumentRetrievalQuestionType | null,
  candidate: EnrichedDocumentRetrievalCandidate,
): boolean {
  const preferredClasses = getPreferredDocumentClassesForQuestionType(questionType);

  return (
    preferredClasses.length === 0 ||
    preferredClasses.includes(candidate.document.docClass)
  );
}

function buildCandidateSupportText(
  candidate: EnrichedDocumentRetrievalCandidate,
): string {
  return [
    candidate.chunk.content,
    candidate.chunk.document_keyword,
    candidate.chunk.docnm_kwd,
    candidate.document.originalFileName,
    candidate.document.equipmentOrSystem,
    candidate.document.manufacturer,
    candidate.document.model,
    candidate.document.contentFocus,
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .join(' ');
}
