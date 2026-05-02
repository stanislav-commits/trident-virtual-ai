import type { DocumentAnswerGroundingValidation } from './document-answer-grounding';
import {
  extractCitedEvidenceRanks,
  validateDocumentAnswerGrounding,
} from './document-answer-grounding';
import { DocumentRetrievalResponseDto } from '../../../documents/dto/document-retrieval-response.dto';
import { shouldExposeDocumentContextReferences } from './document-context-references';

export interface GroundedDocumentAnswer {
  summary: string;
  groundingStatus: 'grounded' | 'insufficient';
  groundingReason?: string;
}

export interface DocumentAnswerCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface DocumentAnswerLlm {
  completeText(input: DocumentAnswerCompletionRequest): Promise<string | null>;
}

const missingCitationReason =
  'The answer uses retrieved document evidence but does not include citation markers.';

export async function acceptOrRepairGroundedReply(input: {
  reply: string;
  retrieval: DocumentRetrievalResponseDto;
  request: DocumentAnswerCompletionRequest;
  chatLlmService: DocumentAnswerLlm;
}): Promise<GroundedDocumentAnswer> {
  const firstValidation = validateGeneratedDocumentAnswer(
    input.reply,
    input.retrieval,
  );

  if (firstValidation.isGrounded) {
    return {
      summary: input.reply,
      groundingStatus: 'grounded',
    };
  }

  if (firstValidation.reason === missingCitationReason) {
    const retry = await input.chatLlmService.completeText({
      ...input.request,
      temperature: 0,
      userPrompt: buildCitationRepairPrompt(
        input.request.userPrompt,
        input.reply,
      ),
    });

    if (retry) {
      const retryValidation = validateGeneratedDocumentAnswer(
        retry,
        input.retrieval,
      );

      if (retryValidation.isGrounded) {
        return {
          summary: retry,
          groundingStatus: 'grounded',
        };
      }

      if (retryValidation.reason !== missingCitationReason) {
        return {
          summary: buildInsufficientGroundingSummary(
            input.retrieval,
            retryValidation.reason,
          ),
          groundingStatus: 'insufficient',
          groundingReason: retryValidation.reason,
        };
      }
    }

    return {
      summary: buildCitedEvidenceFallbackSummary(input.retrieval),
      groundingStatus: 'grounded',
    };
  }

  return {
    summary: buildInsufficientGroundingSummary(
      input.retrieval,
      firstValidation.reason,
    ),
    groundingStatus: 'insufficient',
    groundingReason: firstValidation.reason,
  };
}

export function buildFallbackEvidenceSummary(
  retrieval: DocumentRetrievalResponseDto,
): string {
  const topResult = retrieval.results[0];

  if (!topResult) {
    return [
      'I could not find sufficient evidence in the uploaded ship documents to answer this confidently.',
      retrieval.answerability.reason,
    ].join(' ');
  }

  if (retrieval.evidenceQuality === 'weak') {
    return [
      'I found limited ship-document evidence, but the answer model did not return a grounded response from it.',
      'The uploaded document evidence is insufficient or ambiguous for a confident answer.',
      retrieval.answerability.reason,
    ].join(' ');
  }

  return [
    'I found ship-document evidence, but the answer model did not return a grounded response from it.',
    'The uploaded document evidence is insufficient or ambiguous for the requested detail.',
    retrieval.answerability.reason,
  ].join(' ');
}

function validateGeneratedDocumentAnswer(
  reply: string,
  retrieval: DocumentRetrievalResponseDto,
): DocumentAnswerGroundingValidation {
  const groundingValidation = validateDocumentAnswerGrounding(reply, retrieval);

  if (!groundingValidation.isGrounded) {
    return groundingValidation;
  }

  if (
    retrieval.evidenceQuality === 'strong' &&
    shouldExposeDocumentContextReferences(retrieval) &&
    extractCitedEvidenceRanks(reply).size === 0
  ) {
    return {
      isGrounded: false as const,
      reason: missingCitationReason,
    };
  }

  return groundingValidation;
}

function buildCitationRepairPrompt(
  originalUserPrompt: string,
  previousReply: string,
): string {
  return [
    originalUserPrompt,
    '',
    'The previous draft omitted required citation markers.',
    'Rewrite the answer using only the same retrieved evidence.',
    'Keep the same language, but add citation markers like [1] to every evidence-backed factual claim.',
    'Do not add new facts, sources, metrics, or web knowledge.',
    '',
    'Previous draft:',
    previousReply,
  ].join('\n');
}

function buildCitedEvidenceFallbackSummary(
  retrieval: DocumentRetrievalResponseDto,
): string {
  const citedResults = retrieval.results.slice(0, 3);

  if (!citedResults.length) {
    return buildFallbackEvidenceSummary(retrieval);
  }

  return [
    'I found relevant ship-document evidence, but the answer model did not return a fully cited response. Directly supported evidence:',
    ...citedResults.map(
      (result) => `- ${truncate(result.snippet, 260)} [${result.rank}]`,
    ),
  ].join('\n');
}

function buildInsufficientGroundingSummary(
  retrieval: DocumentRetrievalResponseDto,
  reason: string,
): string {
  return [
    'I found related ship-document snippets, but they do not clearly support the exact value or table row needed to answer this confidently.',
    'The uploaded document evidence is insufficient or ambiguous for the requested detail.',
    reason,
    retrieval.answerability.reason,
  ].join(' ');
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
