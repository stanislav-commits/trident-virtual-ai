import type { DocumentAnswerGroundingValidation } from './document-answer-grounding';
import {
  extractCitedEvidenceRanks,
  validateDocumentAnswerGrounding,
} from './document-answer-grounding';
import { DocumentRetrievalResponseDto } from '../../../../documents/dto/document-retrieval-response.dto';
import { shouldExposeDocumentContextReferences } from '../composite/document-context-references';
import { resultHasProcedureStepEvidence } from './document-procedure-evidence';
import {
  buildStructuredPmsFallbackSummary,
  isStructuredPmsUnitMismatchReason,
} from './document-pms-fallback-answer';
import {
  buildPmsOverduePrimaryFallbackSummary,
  isPmsOverduePrimarySelectionReason,
  validatePmsOverduePrimarySelection,
} from './document-pms-task-selection';

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
const missingProcedureEvidenceCitationReason =
  'The answer gives procedure-step guidance but does not cite evidence that contains procedure steps.';

export async function acceptOrRepairGroundedReply(input: {
  reply: string;
  retrieval: DocumentRetrievalResponseDto;
  request: DocumentAnswerCompletionRequest;
  chatLlmService: DocumentAnswerLlm;
  supportedNumericContext?: string[];
  preserveMarkdownStructure?: boolean;
  requireCitationMarkers?: boolean;
  requireProcedureEvidenceCitation?: boolean;
  requiredProcedureEvidenceRanks?: number[];
  pmsTaskSelectionQuestion?: string;
}): Promise<GroundedDocumentAnswer> {
  const firstValidation = validateGeneratedDocumentAnswer(
    input.reply,
    input.retrieval,
    input.supportedNumericContext,
    {
      requireCitationMarkers: input.requireCitationMarkers,
      requireProcedureEvidenceCitation: input.requireProcedureEvidenceCitation,
      requiredProcedureEvidenceRanks: input.requiredProcedureEvidenceRanks,
      pmsTaskSelectionQuestion: input.pmsTaskSelectionQuestion,
    },
  );

  if (firstValidation.isGrounded) {
    return {
      summary: input.reply,
      groundingStatus: 'grounded',
    };
  }

  if (
    firstValidation.reason === missingCitationReason ||
    firstValidation.reason === missingProcedureEvidenceCitationReason ||
    isRepairableGroundingReason(firstValidation.reason)
  ) {
    const retry = await input.chatLlmService.completeText({
      ...input.request,
      temperature: 0,
      userPrompt: buildCitationRepairPrompt(
        input.request.userPrompt,
        input.reply,
        input.preserveMarkdownStructure === true,
        firstValidation.reason,
      ),
    });

    if (retry) {
      const retryValidation = validateGeneratedDocumentAnswer(
        retry,
        input.retrieval,
        input.supportedNumericContext,
        {
          requireCitationMarkers: input.requireCitationMarkers,
          requireProcedureEvidenceCitation: input.requireProcedureEvidenceCitation,
          requiredProcedureEvidenceRanks: input.requiredProcedureEvidenceRanks,
          pmsTaskSelectionQuestion: input.pmsTaskSelectionQuestion,
        },
      );

      if (retryValidation.isGrounded) {
        return {
          summary: retry,
          groundingStatus: 'grounded',
        };
      }

      if (retryValidation.reason !== missingCitationReason) {
        if (
          retryValidation.reason === missingProcedureEvidenceCitationReason
        ) {
          return {
            summary: buildProcedureEvidenceCitationFailureSummary(
              input.retrieval,
            ),
            groundingStatus: 'grounded',
          };
        }

        if (isPmsOverduePrimarySelectionReason(retryValidation.reason)) {
          const pmsFallback = buildPmsOverduePrimaryFallbackSummary(
            input.retrieval,
          );

          if (pmsFallback) {
            return {
              summary: pmsFallback,
              groundingStatus: 'grounded',
            };
          }
        }

        const structuredPmsFallback = input.preserveMarkdownStructure
          ? buildStructuredPmsFallbackSummary(input.retrieval)
          : null;

        if (
          structuredPmsFallback &&
          isStructuredPmsUnitMismatchReason(
            retryValidation.reason,
            input.retrieval,
          )
        ) {
          return {
            summary: structuredPmsFallback,
            groundingStatus: 'grounded',
          };
        }

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
  supportedNumericContext: string[] = [],
  options: {
    requireCitationMarkers?: boolean;
    requireProcedureEvidenceCitation?: boolean;
    requiredProcedureEvidenceRanks?: number[];
    pmsTaskSelectionQuestion?: string;
  } = {},
): DocumentAnswerGroundingValidation {
  const groundingValidation = validateDocumentAnswerGrounding(reply, retrieval, {
    supportedNumericContext,
  });

  if (!groundingValidation.isGrounded) {
    return groundingValidation;
  }

  if (
    (options.requireCitationMarkers === true ||
      retrieval.evidenceQuality === 'strong') &&
    shouldExposeDocumentContextReferences(retrieval) &&
    extractCitedEvidenceRanks(reply).size === 0
  ) {
    return {
      isGrounded: false as const,
      reason: missingCitationReason,
    };
  }

  if (options.requireProcedureEvidenceCitation === true) {
    const citedRanks = extractCitedEvidenceRanks(reply);
    const requiredRanks = new Set(options.requiredProcedureEvidenceRanks ?? []);
    const citesProcedureEvidence = requiredRanks.size
      ? [...requiredRanks].some((rank) => citedRanks.has(rank))
      : retrieval.results.some(
          (result) =>
            citedRanks.has(result.rank) && resultHasProcedureStepEvidence(result),
        );

    if (!citesProcedureEvidence) {
      return {
        isGrounded: false as const,
        reason: missingProcedureEvidenceCitationReason,
      };
    }
  }

  const pmsTaskSelectionReason = validatePmsOverduePrimarySelection({
    reply,
    retrieval,
    userQuestion: options.pmsTaskSelectionQuestion,
  });

  if (pmsTaskSelectionReason) {
    return {
      isGrounded: false as const,
      reason: pmsTaskSelectionReason,
    };
  }

  return groundingValidation;
}

function buildCitationRepairPrompt(
  originalUserPrompt: string,
  previousReply: string,
  preserveMarkdownStructure: boolean,
  validationReason = missingCitationReason,
): string {
  return [
    originalUserPrompt,
    '',
    `The previous draft failed document grounding: ${validationReason}`,
    'Rewrite the answer using only the same retrieved evidence.',
    'Keep the same language, but add citation markers like [1] to every evidence-backed factual claim.',
    'If the draft used an unsupported numeric value or unit, correct it only when the cited evidence contains the exact value with the correct field/unit; otherwise remove that claim.',
    'For structured PMS fields, keep units fixed: current_equipment_hours, next_due_hours, last_completed_hours, running_hours, and hours_remaining are hours; days_remaining is days; last_completed_date and next_due_date are dates.',
    'Do not relabel an hours field as days or a days field as hours.',
    'For any procedural step or instruction, cite the evidence item that contains the actual procedure steps or procedural instructions.',
    ...(preserveMarkdownStructure
      ? ['Preserve the previous draft Markdown structure and labeled bullet layout while adding citations.']
      : []),
    'Do not add new facts, sources, metrics, or web knowledge.',
    '',
    'Previous draft:',
    previousReply,
  ].join('\n');
}

function isRepairableGroundingReason(reason: string): boolean {
  return (
    reason.includes('concrete numeric or technical values') ||
    reason.includes('exact value/unit was not found') ||
    isPmsOverduePrimarySelectionReason(reason)
  );
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

function buildProcedureEvidenceCitationFailureSummary(
  retrieval: DocumentRetrievalResponseDto,
): string {
  const citedResults = retrieval.results.slice(0, 2);
  const citationText = citedResults.map((result) => `[${result.rank}]`).join('');

  return [
    'I found related procedural evidence in the uploaded documents, but I could not ground a direct step-by-step answer in the required cited procedure-step evidence.',
    citationText
      ? `The closest retrieved evidence is related and should not be treated as direct instructions for the requested component or operation ${citationText}.`
      : null,
    'I will not present similar or weakly matched evidence as a direct procedure.',
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
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
