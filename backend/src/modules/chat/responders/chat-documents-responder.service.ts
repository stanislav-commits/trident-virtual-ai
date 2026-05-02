import { Injectable } from '@nestjs/common';
import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
} from '../../documents/dto/document-retrieval-response.dto';
import { SearchDocumentsDto } from '../../documents/dto/search-documents.dto';
import { DocumentsService } from '../../documents/documents.service';
import { ChatLlmService } from '../chat-llm.service';
import {
  normalizeDocumentAnswerLanguage,
  normalizeDocumentLanguageHint,
  normalizeDocumentRetrievalQuery,
} from '../routing/chat-document-retrieval-query';
import { ChatSemanticDocumentsRoute } from '../routing/chat-semantic-router.types';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';
import {
  extractCitedEvidenceRanks,
  validateDocumentAnswerGrounding,
} from './document-answer-grounding';
import {
  buildGroundedAnswerSystemPrompt,
  buildGroundedAnswerUserPrompt,
} from './document-grounded-answer-prompt';
import {
  buildDocumentClassAttempts,
  DocumentClassAttempt,
  isBetterRetrieval,
} from './document-retrieval-attempts';

interface GroundedDocumentAnswer {
  summary: string;
  groundingStatus: 'grounded' | 'insufficient';
  groundingReason?: string;
}

interface DocumentQueryPlan {
  originalQuestion: string;
  retrievalQuery: string | null;
  searchQuestion: string;
  answerLanguage: string | null;
}

@Injectable()
export class ChatDocumentsResponderService {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly chatLlmService: ChatLlmService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const documentsRoute = input.ask.semanticRoute.documents;
    const shipId = input.session.shipId ?? documentsRoute.shipId;

    if (!shipId) {
      return this.buildStaticResponse(
        input,
        'missing_ship_context',
        'I need an active ship context before I can search uploaded ship documents.',
      );
    }

    let retrieval: DocumentRetrievalResponseDto | null = null;
    const attempts = buildDocumentClassAttempts(documentsRoute);
    const queryPlan = this.buildDocumentQueryPlan(input, documentsRoute);
    let completedAttempt: DocumentClassAttempt | null = null;

    try {
      for (const attempt of attempts) {
        const attemptRetrieval = await this.documentsService.search(
          this.buildRetrievalRequest(
            input,
            documentsRoute,
            shipId,
            attempt,
            queryPlan,
          ),
        );

        if (!retrieval || isBetterRetrieval(attemptRetrieval, retrieval)) {
          retrieval = attemptRetrieval;
          completedAttempt = attempt;
        }

        if (attemptRetrieval.evidenceQuality === 'strong') {
          break;
        }
      }
    } catch (error) {
      return this.buildStaticResponse(
        input,
        'retrieval_failed',
        `I could not search the ship documents for this request: ${this.formatError(error)}`,
      );
    }

    if (!retrieval) {
      return this.buildStaticResponse(
        input,
        'retrieval_failed',
        'I could not search the ship documents for this request.',
      );
    }

    const groundedAnswer = await this.buildGroundedSummary(
      input,
      retrieval,
      queryPlan,
    );

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.DOCUMENTS,
      question: input.ask.question,
      capabilityEnabled: true,
      capabilityLabel: 'document retrieval',
      summary: groundedAnswer.summary,
      data: {
        status: this.toResponseStatus(retrieval.evidenceQuality),
        retrieval: {
          evidenceQuality: retrieval.evidenceQuality,
          answerability: retrieval.answerability,
          appliedFilters: retrieval.appliedFilters,
          diagnostics: retrieval.diagnostics,
          query: queryPlan,
          retrievalAttempt: completedAttempt?.reason ?? null,
          attemptedDocClasses: attempts.map((attempt) => ({
            reason: attempt.reason,
            candidateDocClasses: attempt.candidateDocClasses ?? null,
          })),
          resultCount: retrieval.results.length,
          answerGrounding: {
            status: groundedAnswer.groundingStatus,
            reason: groundedAnswer.groundingReason ?? null,
          },
        },
      },
      contextReferences: this.toContextReferences(
        retrieval,
        groundedAnswer.summary,
        groundedAnswer.groundingStatus,
      ),
    };
  }

  private buildRetrievalRequest(
    input: ChatTurnResponderInput,
    documentsRoute: ChatSemanticDocumentsRoute,
    shipId: string,
    attempt: DocumentClassAttempt,
    queryPlan: DocumentQueryPlan,
  ): SearchDocumentsDto {
    return {
      question: queryPlan.searchQuestion,
      shipId,
      candidateDocClasses: attempt.candidateDocClasses,
      questionType: documentsRoute.questionType ?? undefined,
      equipmentOrSystemHints: documentsRoute.equipmentOrSystemHints.length
        ? documentsRoute.equipmentOrSystemHints
        : undefined,
      manufacturerHints: documentsRoute.manufacturerHints.length
        ? documentsRoute.manufacturerHints
        : undefined,
      modelHints: documentsRoute.modelHints.length
        ? documentsRoute.modelHints
        : undefined,
      contentFocusHints: documentsRoute.contentFocusHints.length
        ? documentsRoute.contentFocusHints
        : undefined,
      documentTitleHint: documentsRoute.documentTitleHint ?? undefined,
      requireDocumentTitleMatch: attempt.reason === 'title_hint' || undefined,
      languageHint:
        normalizeDocumentLanguageHint({
          originalQuestion: input.ask.question,
          retrievalQuery: queryPlan.retrievalQuery,
          languageHint: documentsRoute.languageHint,
          answerLanguage: queryPlan.answerLanguage,
          documentTitleHint: documentsRoute.documentTitleHint,
        }) ?? undefined,
      allowMultiDocument:
        documentsRoute.multiDocumentLikely ||
        (attempt.candidateDocClasses?.length ?? 0) > 1 ||
        undefined,
      allowWeakEvidence: true,
    };
  }

  private async buildGroundedSummary(
    input: ChatTurnResponderInput,
    retrieval: DocumentRetrievalResponseDto,
    queryPlan: DocumentQueryPlan,
  ): Promise<GroundedDocumentAnswer> {
    if (retrieval.evidenceQuality === 'none') {
      return {
        summary: [
          'I could not find sufficient evidence in the uploaded ship documents to answer this confidently.',
          retrieval.answerability.reason,
          'I did not use web fallback for this document-only request.',
        ].join(' '),
        groundingStatus: 'insufficient',
        groundingReason: retrieval.answerability.reason,
      };
    }

    const reply = await this.chatLlmService.completeText({
      systemPrompt: buildGroundedAnswerSystemPrompt(retrieval.evidenceQuality),
      userPrompt: buildGroundedAnswerUserPrompt({
        userQuestion: input.ask.question,
        answerLanguage: queryPlan.answerLanguage,
        retrieval,
      }),
      temperature: 0.1,
      maxTokens: retrieval.evidenceQuality === 'strong' ? 650 : 420,
    });

    if (reply) {
      const validation = validateDocumentAnswerGrounding(reply, retrieval);

      if (!validation.isGrounded) {
        return {
          summary: this.buildInsufficientGroundingSummary(
            retrieval,
            validation.reason,
          ),
          groundingStatus: 'insufficient',
          groundingReason: validation.reason,
        };
      }

      return {
        summary: reply,
        groundingStatus: 'grounded',
      };
    }

    return {
      summary: this.buildFallbackEvidenceSummary(retrieval),
      groundingStatus: 'insufficient',
      groundingReason:
        'The document answer model did not return a grounded response.',
    };
  }

  private buildFallbackEvidenceSummary(
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

  private toContextReferences(
    retrieval: DocumentRetrievalResponseDto,
    answerText?: string,
    groundingStatus: 'grounded' | 'insufficient' = 'grounded',
  ): Record<string, unknown>[] {
    if (
      groundingStatus !== 'grounded' ||
      !this.shouldExposeContextReferences(retrieval)
    ) {
      return [];
    }

    const citedRanks = extractCitedEvidenceRanks(answerText ?? '');
    if (!citedRanks.size) {
      return [];
    }

    return retrieval.results
      .filter((result) => citedRanks.has(result.rank))
      .map((result) => ({
        id: `document-${result.rank}`,
        sourceType: 'document',
        documentId: result.documentId,
        shipId: retrieval.shipId,
        chunkId: result.chunkId,
        score: result.rerankScore,
        pageNumber: result.page ?? undefined,
        snippet: result.snippet,
        sourceTitle: result.filename,
      }));
  }

  private shouldExposeContextReferences(
    retrieval: DocumentRetrievalResponseDto,
  ): boolean {
    const answerabilityStatus = String(retrieval.answerability.status);

    if (
      retrieval.evidenceQuality === 'none' ||
      answerabilityStatus === 'none' ||
      answerabilityStatus === 'insufficient' ||
      !retrieval.results.length
    ) {
      return false;
    }

    return true;
  }

  private buildStaticResponse(
    input: ChatTurnResponderInput,
    status: string,
    summary: string,
  ): ChatTurnResponderOutput {
    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.DOCUMENTS,
      question: input.ask.question,
      capabilityEnabled: true,
      capabilityLabel: 'document retrieval',
      summary,
      data: { status },
      contextReferences: [],
    };
  }

  private toResponseStatus(
    evidenceQuality: DocumentRetrievalEvidenceQuality,
  ): string {
    if (evidenceQuality === 'strong') return 'answered';
    if (evidenceQuality === 'weak') return 'weak_evidence';
    return 'no_evidence';
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private buildDocumentQueryPlan(
    input: ChatTurnResponderInput,
    documentsRoute: ChatSemanticDocumentsRoute,
  ): DocumentQueryPlan {
    const originalQuestion = input.ask.question;
    const retrievalQuery = normalizeDocumentRetrievalQuery({
      originalQuestion,
      retrievalQuery: documentsRoute.retrievalQuery,
      documentTitleHint: documentsRoute.documentTitleHint,
    });
    const answerLanguage =
      normalizeDocumentAnswerLanguage(documentsRoute.answerLanguage) ??
      normalizeDocumentAnswerLanguage(input.plan.responseLanguage);

    return {
      originalQuestion,
      retrievalQuery,
      searchQuestion: retrievalQuery ?? originalQuestion,
      answerLanguage,
    };
  }

  private buildInsufficientGroundingSummary(
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
}
