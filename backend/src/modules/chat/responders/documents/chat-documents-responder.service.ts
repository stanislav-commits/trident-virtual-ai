import { Injectable } from '@nestjs/common';
import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
} from '../../../documents/dto/document-retrieval-response.dto';
import { DocumentsService } from '../../../documents/documents.service';
import { ChatLlmService } from '../../chat-llm.service';
import {
  ChatSemanticDocumentComponent,
  ChatSemanticDocumentCompositionMode,
  ChatSemanticDocumentsRoute,
} from '../../routing/chat-semantic-router.types';
import { ChatTurnResponderKind } from '../../planning/chat-turn-responder-kind.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from '../interfaces/chat-turn-responder.types';
import {
  buildGroundedAnswerSystemPrompt,
  buildGroundedAnswerUserPrompt,
} from './document-grounded-answer-prompt';
import {
  buildCompositeDocumentAnswerSystemPrompt,
  buildCompositeDocumentAnswerUserPrompt,
  CompositeDocumentPromptComponent,
} from './document-composite-answer-prompt';
import {
  buildComponentDocumentsRoute,
  buildCompositeEvidence,
  DocumentCompositeComponentResult,
  DocumentQueryPlan,
  getComponentLabel,
  getValidCompositeComponents,
} from './document-composite-retrieval';
import {
  buildDocumentClassAttempts,
  DocumentClassAttempt,
  isBetterRetrieval,
} from './document-retrieval-attempts';
import {
  acceptOrRepairGroundedReply,
  buildFallbackEvidenceSummary,
  GroundedDocumentAnswer,
} from './document-answer-repair';
import { buildDocumentContextReferences } from './document-context-references';
import {
  buildComponentQueryPlan,
  buildDocumentQueryPlan,
  buildDocumentRetrievalRequest,
} from './document-query-planning';

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

    if (this.shouldUseCompositeDocumentsFlow(documentsRoute)) {
      return this.respondComposite(input, documentsRoute, shipId);
    }

    return this.respondSingle(input, documentsRoute, shipId);
  }

  private async respondSingle(
    input: ChatTurnResponderInput,
    documentsRoute: ChatSemanticDocumentsRoute,
    shipId: string,
  ): Promise<ChatTurnResponderOutput> {
    let retrieval: DocumentRetrievalResponseDto | null = null;
    const attempts = buildDocumentClassAttempts(documentsRoute);
    const queryPlan = buildDocumentQueryPlan(input, documentsRoute);
    let completedAttempt: DocumentClassAttempt | null = null;

    try {
      for (const attempt of attempts) {
        const attemptRetrieval = await this.documentsService.search(
          buildDocumentRetrievalRequest(
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
      contextReferences: buildDocumentContextReferences(
        retrieval,
        groundedAnswer.summary,
        groundedAnswer.groundingStatus,
      ),
    };
  }

  private async respondComposite(
    input: ChatTurnResponderInput,
    documentsRoute: ChatSemanticDocumentsRoute,
    shipId: string,
  ): Promise<ChatTurnResponderOutput> {
    const components = getValidCompositeComponents(documentsRoute);

    if (components.length < 2) {
      return this.respondSingle(input, documentsRoute, shipId);
    }

    let componentResults: DocumentCompositeComponentResult[];

    try {
      componentResults = [];

      for (const component of components) {
        componentResults.push(
          await this.executeCompositeComponent(
            input,
            documentsRoute,
            component,
            shipId,
          ),
        );
      }
    } catch (error) {
      return this.buildStaticResponse(
        input,
        'retrieval_failed',
        `I could not search the ship documents for this request: ${this.formatError(error)}`,
      );
    }

    const compositeEvidence = buildCompositeEvidence({
      originalQuestion: input.ask.question,
      shipId,
      componentResults,
    });
    const groundedAnswer = await this.buildGroundedCompositeSummary(
      input,
      documentsRoute.compositionMode,
      compositeEvidence.mergedRetrieval,
      compositeEvidence.promptComponents,
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
        status: this.toResponseStatus(compositeEvidence.mergedRetrieval.evidenceQuality),
        retrieval: {
          composite: true,
          compositionMode: documentsRoute.compositionMode ?? 'synthesize',
          evidenceQuality: compositeEvidence.mergedRetrieval.evidenceQuality,
          answerability: compositeEvidence.mergedRetrieval.answerability,
          components: componentResults.map((result) => ({
            id: result.component.id,
            label: getComponentLabel(result.component),
            question: result.component.question,
            query: result.queryPlan,
            documentTitleHint: result.documentsRoute.documentTitleHint,
            requireDocumentTitleMatch: result.component.requireDocumentTitleMatch,
            evidenceQuality: result.retrieval.evidenceQuality,
            answerability: result.retrieval.answerability,
            appliedFilters: result.retrieval.appliedFilters,
            diagnostics: result.retrieval.diagnostics,
            retrievalAttempt: result.completedAttempt?.reason ?? null,
            attemptedDocClasses: result.attempts.map((attempt) => ({
              reason: attempt.reason,
              candidateDocClasses: attempt.candidateDocClasses ?? null,
            })),
            resultCount: result.retrieval.results.length,
          })),
          answerGrounding: {
            status: groundedAnswer.groundingStatus,
            reason: groundedAnswer.groundingReason ?? null,
          },
        },
      },
      contextReferences: buildDocumentContextReferences(
        compositeEvidence.mergedRetrieval,
        groundedAnswer.summary,
        groundedAnswer.groundingStatus,
      ),
    };
  }

  private async executeCompositeComponent(
    input: ChatTurnResponderInput,
    parentRoute: ChatSemanticDocumentsRoute,
    component: ChatSemanticDocumentComponent,
    shipId: string,
  ): Promise<DocumentCompositeComponentResult> {
    const documentsRoute = buildComponentDocumentsRoute(
      parentRoute,
      component,
    );
    const attempts = buildDocumentClassAttempts(documentsRoute);
    const queryPlan = buildComponentQueryPlan(input, parentRoute, component);
    let retrieval: DocumentRetrievalResponseDto | null = null;
    let completedAttempt: DocumentClassAttempt | null = null;

    for (const attempt of attempts) {
      const attemptRetrieval = await this.documentsService.search(
            buildDocumentRetrievalRequest(
          input,
          documentsRoute,
          shipId,
          attempt,
          queryPlan,
          {
            languageContextQuestion: component.question,
            requireDocumentTitleMatch: component.requireDocumentTitleMatch,
          },
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

    if (!retrieval) {
      throw new Error('No document retrieval response was returned.');
    }

    return {
      component,
      documentsRoute,
      queryPlan,
      retrieval,
      attempts,
      completedAttempt,
    };
  }

  private shouldUseCompositeDocumentsFlow(
    documentsRoute: ChatSemanticDocumentsRoute,
  ): boolean {
    return (
      (documentsRoute.mode === 'composite' ||
        (documentsRoute.components?.length ?? 0) > 0) &&
      getValidCompositeComponents(documentsRoute).length >= 2
    );
  }

  private async buildGroundedCompositeSummary(
    input: ChatTurnResponderInput,
    compositionMode: ChatSemanticDocumentCompositionMode | null,
    mergedRetrieval: DocumentRetrievalResponseDto,
    promptComponents: CompositeDocumentPromptComponent[],
  ): Promise<GroundedDocumentAnswer> {
    if (mergedRetrieval.evidenceQuality === 'none') {
      return {
        summary: [
          'I could not find sufficient evidence in the uploaded ship documents to answer this composite document question confidently.',
          mergedRetrieval.answerability.reason,
          'I did not use metrics or web fallback for this document-only request.',
        ].join(' '),
        groundingStatus: 'insufficient',
        groundingReason: mergedRetrieval.answerability.reason,
      };
    }

    const answerLanguage = buildDocumentQueryPlan(
      input,
      input.ask.semanticRoute.documents,
    ).answerLanguage;
    const systemPrompt = buildCompositeDocumentAnswerSystemPrompt();
    const userPrompt = buildCompositeDocumentAnswerUserPrompt({
      userQuestion: input.ask.question,
      answerLanguage,
      compositionMode,
      components: promptComponents,
    });
    const request = {
      systemPrompt,
      userPrompt,
      temperature: 0.1,
      maxTokens: 900,
    };
    const reply = await this.chatLlmService.completeText(request);

    if (reply) {
      return acceptOrRepairGroundedReply({
        reply,
        retrieval: mergedRetrieval,
        request,
        chatLlmService: this.chatLlmService,
      });
    }

    return {
      summary: buildFallbackEvidenceSummary(mergedRetrieval),
      groundingStatus: 'insufficient',
      groundingReason:
        'The document answer model did not return a grounded composite response.',
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

    const maintenanceScheduleSafetySummary =
      this.buildMaintenanceScheduleSafetySummary(retrieval, queryPlan);

    if (maintenanceScheduleSafetySummary) {
      return {
        summary: maintenanceScheduleSafetySummary,
        groundingStatus: 'grounded',
      };
    }

    const request = {
      systemPrompt: buildGroundedAnswerSystemPrompt(retrieval.evidenceQuality),
      userPrompt: buildGroundedAnswerUserPrompt({
        userQuestion: input.ask.question,
        answerLanguage: queryPlan.answerLanguage,
        retrieval,
        contextFacts: queryPlan.contextFacts,
      }),
      temperature: 0.1,
      maxTokens: retrieval.evidenceQuality === 'strong' ? 650 : 420,
    };
    const reply = await this.chatLlmService.completeText(request);

    if (reply) {
      return acceptOrRepairGroundedReply({
        reply,
        retrieval,
        request,
        chatLlmService: this.chatLlmService,
        supportedNumericContext: this.buildSupportedNumericContext(queryPlan),
      });
    }

    return {
      summary: buildFallbackEvidenceSummary(retrieval),
      groundingStatus: 'insufficient',
      groundingReason:
        'The document answer model did not return a grounded response.',
    };
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

  private buildSupportedNumericContext(queryPlan: DocumentQueryPlan): string[] {
    const runningHours = queryPlan.contextFacts.runningHours;

    if (!runningHours) {
      return [];
    }

    return [`${runningHours} running hours`, `${runningHours} hours`];
  }

  private buildMaintenanceScheduleSafetySummary(
    retrieval: DocumentRetrievalResponseDto,
    queryPlan: DocumentQueryPlan,
  ): string | null {
    if (
      retrieval.evidenceQuality !== 'weak' ||
      !queryPlan.contextFacts.maintenanceScheduleQuestion
    ) {
      return null;
    }

    const scheduleResults = retrieval.results
      .filter((result) => this.isMaintenanceScheduleEvidence(result.snippet))
      .slice(0, 3);

    if (!scheduleResults.length) {
      return null;
    }

    const citationText = scheduleResults
      .map((result) => `[${result.rank}]`)
      .join('');
    const intervalText = this.describeVisibleMaintenanceIntervals(
      scheduleResults.map((result) => result.snippet).join(' '),
    );
    const runningHours = queryPlan.contextFacts.runningHours;
    const contextSentence = runningHours
      ? `I considered the current running-hours value from this chat: ${runningHours} running hours.`
      : 'The manual should be interpreted as an interval-based schedule; I did not find a current running-hours value in the chat context.';
    const scheduleSentence = runningHours
      ? `The retrieved manual evidence is a periodic maintenance schedule, not an entry for the exact current-hour value.${intervalText} ${citationText}`
      : `The retrieved manual evidence is a periodic maintenance schedule with running-hour based intervals.${intervalText} ${citationText}`;
    const nextActionSentence = runningHours
      ? 'Use the vessel service history to decide the next action: check which scheduled service interval was last completed, then compare the current running hours with the manual schedule. If the relevant prior interval has not been completed, treat that service as due; otherwise plan toward the next scheduled interval.'
      : 'For a due-maintenance decision, the current running hours and the vessel service history are both needed to compare against the manual schedule.';

    return [
      contextSentence,
      scheduleSentence,
      `Because the indexed table text is weak and does not preserve the row/column mapping clearly enough, I cannot safely list the exact tasks due from these parsed chunks. ${citationText}`,
      nextActionSentence,
      'Confirm the exact task list against the original manual table before performing the work.',
    ].join(' ');
  }

  private isMaintenanceScheduleEvidence(snippet: string): boolean {
    const normalized = snippet.toLocaleLowerCase();

    return (
      normalized.includes('periodic checks and maintenance') ||
      normalized.includes('periodicchecksandmaintenance') ||
      normalized.includes('maintenance schedule') ||
      normalized.includes('performservice at intervalsindicated') ||
      /\bevery\s*\d{2,5}\s*(?:hrs?|hours?)\b/u.test(normalized)
    );
  }

  private describeVisibleMaintenanceIntervals(snippet: string): string {
    if (/\bevery\s*\d{2,5}\s*(?:hrs?|hours?)\b/iu.test(snippet)) {
      return ' It shows visible recurring running-hour interval headers, although the extracted table remains ambiguous.';
    }

    return ' It shows maintenance should be performed at indicated intervals.';
  }

}
