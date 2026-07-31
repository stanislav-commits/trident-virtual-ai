import type { DocumentAnswerGroundingValidation } from './document-answer-grounding';
import {
  validateDocumentAnswerGrounding,
} from './document-answer-grounding';
import { DocumentRetrievalResponseDto } from '../../../documents/dto/document-retrieval-response.dto';

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
  // Answer synthesis runs on the main model (Claude); the citation-repair
  // retry inherits this via `...input.request`.
  useMainModel?: boolean;
}

export interface DocumentAnswerLlm {
  completeText(input: DocumentAnswerCompletionRequest): Promise<string | null>;
}

export async function acceptOrRepairGroundedReply(input: {
  reply: string;
  retrieval: DocumentRetrievalResponseDto;
  request: DocumentAnswerCompletionRequest;
  chatLlmService: DocumentAnswerLlm;
  supportedNumericContext?: string[];
  preserveMarkdownStructure?: boolean;
}): Promise<GroundedDocumentAnswer> {
  const firstValidation = validateGeneratedDocumentAnswer(
    input.reply,
    input.retrieval,
    input.supportedNumericContext,
  );

  if (firstValidation.isGrounded) {
    return {
      summary: input.reply,
      groundingStatus: 'grounded',
    };
  }

  // One unverifiable figure used to condemn the whole answer. The validator
  // caught "1,000 rpm" that it could not find in the evidence and the entire
  // start-up procedure — ten strong manual snippets behind it — was thrown
  // away for a web search (production, 2026-07-31). Whether the figure was a
  // formatting mismatch or the model reaching for general knowledge, the
  // right response is the same: one corrective pass that keeps the procedure
  // and drops the number nobody can back, not a five-minute detour to the
  // open internet.
  if (isNumericGroundingFailure(firstValidation.reason)) {
    const retry = await input.chatLlmService.completeText({
      ...input.request,
      temperature: 0,
      userPrompt: buildNumericRepairPrompt(
        input.request.userPrompt,
        input.reply,
        firstValidation.reason,
      ),
    });

    if (retry) {
      const retryValidation = validateGeneratedDocumentAnswer(
        retry,
        input.retrieval,
        input.supportedNumericContext,
      );
      if (retryValidation.isGrounded) {
        return { summary: retry, groundingStatus: 'grounded' };
      }
    }
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

function isNumericGroundingFailure(reason?: string): boolean {
  return /^The answer included "/.test(reason ?? '');
}

function buildNumericRepairPrompt(
  originalUserPrompt: string,
  previousReply: string,
  reason?: string,
): string {
  return [
    originalUserPrompt,
    '',
    `A grounding check rejected the previous draft: ${reason ?? 'a figure could not be verified against the evidence.'}`,
    'Rewrite the answer using ONLY the same retrieved evidence.',
    'Keep every step and instruction that the evidence supports.',
    'Remove or reword any numeric value that does not appear in the evidence snippets — do not replace it with another figure from memory.',
    'Do not add new facts, sources, or web knowledge.',
    '',
    'Previous draft:',
    previousReply,
  ].join('\n');
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
): DocumentAnswerGroundingValidation {
  const groundingValidation = validateDocumentAnswerGrounding(reply, retrieval, {
    supportedNumericContext,
  });

  if (!groundingValidation.isGrounded) {
    return groundingValidation;
  }

  // Answers no longer carry [N] markers — the sources live behind the button
  // next to copy and regenerate, with the file and the page. A missing marker
  // used to cost a second model call and, when the repair pass also came back
  // without one, a citation glued onto the end of an otherwise good answer.
  return groundingValidation;
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

