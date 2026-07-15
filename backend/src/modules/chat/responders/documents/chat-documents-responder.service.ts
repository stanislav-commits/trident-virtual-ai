import { formatError } from '../../../../common/utils/error.utils';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../documents/enums/document-doc-class.enum';
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
  shouldSkipAttemptForCurrentRetrieval,
} from './document-retrieval-attempts';
import { isMaintenanceRecordIntent } from './document-maintenance-intent';
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
import {
  isReplacementProcedureAsk,
  mergeSupplementalResults,
  retrieveSparePartsEvidence,
  extractEquipmentTerms,
} from './document-spare-parts';

interface AssetEquipmentContext {
  promptBlock: string;
  numericContext: string[];
  /** Unique brands of the matched assets — anchors the parts retrieval. */
  brands: string[];
}

@Injectable()
export class ChatDocumentsResponderService {
  private readonly logger = new Logger(ChatDocumentsResponderService.name);
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly chatLlmService: ChatLlmService,
    @InjectDataSource() private readonly dataSource: DataSource,
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
    const queryPlan = buildDocumentQueryPlan(input, documentsRoute);
    const intentText = this.buildDocumentIntentText(documentsRoute, queryPlan);
    const attempts = buildDocumentClassAttempts(documentsRoute, {
      intentText,
    });
    let completedAttempt: DocumentClassAttempt | null = null;

    try {
      for (const attempt of attempts) {
        if (
          shouldSkipAttemptForCurrentRetrieval({
            attempt,
            current: retrieval,
            intentText,
          })
        ) {
          continue;
        }

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
        `I could not search the ship documents for this request: ${formatError(error)}`,
      );
    }

    if (!retrieval) {
      return this.buildStaticResponse(
        input,
        'retrieval_failed',
        'I could not search the ship documents for this request.',
      );
    }

    if (retrieval.evidenceQuality !== 'none') {
      // Brands from the asset register anchor the parts query to the right
      // manual (component+equipment terms alone lose to other catalogs).
      const assetCtx = await this.resolveAssetContextForInput(
        input,
        queryPlan.searchQuestion,
      );
      retrieval = (
        await this.supplementWithSparePartsEvidence(
          input.ask.question,
          documentsRoute,
          shipId,
          retrieval,
          assetCtx?.brands ?? [],
        )
      ).retrieval;
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
          webQueryContext: this.buildWebQueryContext(retrieval),
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
        `I could not search the ship documents for this request: ${formatError(error)}`,
      );
    }

    const compositeEvidence = buildCompositeEvidence({
      originalQuestion: input.ask.question,
      shipId,
      componentResults,
    });

    const compositeAssetCtx = await this.resolveAssetContextForInput(
      input,
      input.ask.semanticRoute.documents.retrievalQuery ?? '',
      );
    const supplemented = await this.supplementWithSparePartsEvidence(
      input.ask.question,
      documentsRoute,
      shipId,
      compositeEvidence.mergedRetrieval,
      compositeAssetCtx?.brands ?? [],
      );
    compositeEvidence.mergedRetrieval = supplemented.retrieval;
    if (supplemented.addedResults.length) {
      compositeEvidence.promptComponents.push({
        id: 'spare-parts',
        label: 'spare part numbers',
        question: 'Exact spare part numbers / consumable codes for this job',
        documentTitleHint: null,
        evidenceQuality: 'weak',
        answerabilityReason: 'Supplemental spare-parts retrieval.',
        evidenceItems: supplemented.addedResults,
      });
    }

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
          webQueryContext: this.buildWebQueryContext(
            compositeEvidence.mergedRetrieval,
          ),
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
            webQueryContext: this.buildWebQueryContext(result.retrieval),
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
    const queryPlan = buildComponentQueryPlan(input, parentRoute, component);
    const intentText = this.buildDocumentIntentText(documentsRoute, queryPlan);
    const attempts = buildDocumentClassAttempts(documentsRoute, {
      intentText,
    });
    let retrieval: DocumentRetrievalResponseDto | null = null;
    let completedAttempt: DocumentClassAttempt | null = null;

    for (const attempt of attempts) {
      if (
        shouldSkipAttemptForCurrentRetrieval({
          attempt,
          current: retrieval,
          intentText,
        })
      ) {
        continue;
      }

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
    const assetContext = await this.resolveAssetContextForInput(
      input,
      input.ask.semanticRoute.documents.retrievalQuery ?? '',
    );
    const request = {
      systemPrompt,
      userPrompt:
        userPrompt + (assetContext ? `\n${assetContext.promptBlock}` : ''),
      temperature: 0.1,
      maxTokens: 900,
      useMainModel: true,
    };
    const reply = await this.chatLlmService.completeText(request);

    if (reply) {
      return acceptOrRepairGroundedReply({
        reply,
        retrieval: mergedRetrieval,
        request,
        chatLlmService: this.chatLlmService,
        supportedNumericContext: assetContext?.numericContext ?? [],
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

    const structuredMaintenanceRecordAnswer =
      this.shouldUseStructuredMaintenanceRecordAnswer(
        input.ask.question,
        retrieval,
      );
    const assetContext = await this.resolveAssetContextForInput(
      input,
      queryPlan.searchQuestion,
    );
    const request = {
      systemPrompt: buildGroundedAnswerSystemPrompt(retrieval.evidenceQuality),
      userPrompt:
        buildGroundedAnswerUserPrompt({
          userQuestion: input.ask.question,
          answerLanguage: queryPlan.answerLanguage,
          retrieval,
          contextFacts: queryPlan.contextFacts,
          answerStyle: {
            structuredMaintenanceRecord: structuredMaintenanceRecordAnswer,
          },
        }) + (assetContext ? `\n${assetContext.promptBlock}` : ''),
      temperature: 0.1,
      maxTokens: retrieval.evidenceQuality === 'strong' ? 650 : 420,
      useMainModel: true,
    };
    const reply = await this.chatLlmService.completeText(request);

    if (reply) {
      return acceptOrRepairGroundedReply({
        reply,
        retrieval,
        request,
        chatLlmService: this.chatLlmService,
        supportedNumericContext: [
          ...(structuredMaintenanceRecordAnswer
            ? []
            : this.buildSupportedNumericContext(queryPlan)),
          ...(assetContext?.numericContext ?? []),
        ],
        preserveMarkdownStructure: structuredMaintenanceRecordAnswer,
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


  private buildDocumentIntentText(
    documentsRoute: ChatSemanticDocumentsRoute,
    queryPlan: DocumentQueryPlan,
  ): string {
    return [
      queryPlan.originalQuestion,
      queryPlan.retrievalQuery,
      queryPlan.searchQuestion,
      documentsRoute.retrievalQuery,
      documentsRoute.documentTitleHint,
      ...documentsRoute.contentFocusHints,
      ...documentsRoute.equipmentOrSystemHints,
      ...documentsRoute.manufacturerHints,
      ...documentsRoute.modelHints,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }

  /** Equipment/manufacturer/model hint terms from the semantic route. */
  private collectEquipmentHintTerms(
    documentsRoute: ChatSemanticDocumentsRoute,
  ): string[] {
    return [
      ...documentsRoute.equipmentOrSystemHints,
      ...documentsRoute.manufacturerHints,
      ...documentsRoute.modelHints,
    ];
  }

  /**
   * For replacement/service procedure asks, run the supplemental
   * spare-parts retrieval and merge its chunks into the evidence (see
   * document-spare-parts.ts). Returns the (possibly unchanged) retrieval
   * plus the appended results so the composite path can surface them as a
   * dedicated prompt component.
   */
  private async supplementWithSparePartsEvidence(
    question: string,
    documentsRoute: ChatSemanticDocumentsRoute,
    shipId: string,
    retrieval: DocumentRetrievalResponseDto,
    brandTerms: string[] = [],
  ): Promise<{
    retrieval: DocumentRetrievalResponseDto;
    addedResults: DocumentRetrievalResultDto[];
  }> {
    if (!isReplacementProcedureAsk(question)) {
      return { retrieval, addedResults: [] };
    }

    const supplemental = await retrieveSparePartsEvidence({
      documentsService: this.documentsService,
      shipId,
      equipmentTerms: this.collectEquipmentHintTerms(documentsRoute),
      brandTerms,
      // The parts catalog lives in the same manual the procedure chunks
      // came from — scope the supplemental search to that document by id.
      sourceRagflowDocumentId: retrieval.results[0]?.ragflowDocumentId ?? null,
      subject: question,
    });
    const before = retrieval.results.length;
    const merged = mergeSupplementalResults(retrieval, supplemental);

    return { retrieval: merged, addedResults: merged.results.slice(before) };
  }

  private async resolveAssetContextForInput(
    input: ChatTurnResponderInput,
    extraSearchTerm: string,
  ): Promise<AssetEquipmentContext | null> {
    if (!input.session.shipId) {
      return null;
    }

    // EQUIPMENT noun first: matching by component words ("fuel", "filter")
    // ranks high-criticality fuel TANKS (brand Rossinavi) above the genset
    // and the brand anchor points at the wrong manual. The equipment term
    // from the user's own ask ("генсет" -> genset) resolves the right
    // assets deterministically; hints are the fallback only.
    const equipmentNouns = extractEquipmentTerms(input.ask.question);
    if (equipmentNouns.length) {
      const byEquipment = await this.resolveAssetEquipmentContext(
        input.session.shipId,
        equipmentNouns,
      );
      if (byEquipment) {
        return byEquipment;
      }
    }

    return this.resolveAssetEquipmentContext(input.session.shipId, [
      ...this.collectEquipmentHintTerms(input.ask.semanticRoute.documents),
      extraSearchTerm,
    ]);
  }

  /**
   * Bridge to the asset register: manuals rarely repeat the vessel-specific
   * make/model in every chunk, so document answers used to say "the genset
   * model is not specified" while the register knows it exactly (e.g.
   * GenSet Engine — Volvo Penta D13-MH 441). Resolve the equipment terms
   * from the semantic route against assets and feed the matches into the
   * answer prompt (and into the numeric-grounding whitelist, or model
   * numbers like "D13-MH 441" would fail citation validation).
   */
  private async resolveAssetEquipmentContext(
    shipId: string,
    searchTerms: string[],
  ): Promise<AssetEquipmentContext | null> {
    const terms = [
      ...new Set(
        searchTerms
          .flatMap((t) => t.split(/[^A-Za-z0-9-]+/))
          .map((t) => t.trim())
          .filter((t) => t.length >= 4),
      ),
    ].slice(0, 8);

    if (!terms.length) return null;

    try {
      const rows: Array<{
        display_name: string;
        brand: string | null;
        model: string | null;
      }> = await this.dataSource.query(
        `SELECT display_name, brand, model FROM assets
         WHERE ship_id = $1 AND (
           display_name ILIKE ANY($2) OR brand ILIKE ANY($2) OR model ILIKE ANY($2)
         )
         ORDER BY criticality DESC NULLS LAST
         LIMIT 6`,
        [shipId, terms.map((t) => `%${t}%`)],
      );

      if (!rows.length) return null;

      const lines = rows.map((r) => {
        const parts = [r.display_name];
        if (r.brand) parts.push(`brand: ${r.brand}`);
        if (r.model) parts.push(`model: ${r.model}`);
        return `- ${parts.join(' | ')}`;
      });

      const JUNK_BRANDS = new Set(['tbd', 'n/a', 'na', 'unknown', '-', '?']);
      const brands = [
        ...new Set(
          rows
            .map((r) => (r.brand ?? '').trim())
            .filter((b) => b && !JUNK_BRANDS.has(b.toLowerCase())),
        ),
      ];

      return {
        brands,
        promptBlock: [
          '',
          'Vessel equipment identification (authoritative, from the ship asset register):',
          ...lines,
          'Use these exact make/model names when referring to the equipment. Never state that the make or model is unknown or unspecified. If the user explicitly asks for the make, model or serial number, state it from this list in the answer.',
        ].join('\n'),
        numericContext: rows.flatMap((r) =>
          [r.display_name, r.brand, r.model].filter(
            (v): v is string => Boolean(v),
          ),
        ),
      };
    } catch (error) {
      this.logger.warn(
        `Asset equipment context lookup failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  private buildSupportedNumericContext(queryPlan: DocumentQueryPlan): string[] {
    const runningHours = queryPlan.contextFacts.runningHours;

    if (!runningHours) {
      return [];
    }

    return [`${runningHours} running hours`, `${runningHours} hours`];
  }

  private buildWebQueryContext(
    retrieval: DocumentRetrievalResponseDto,
  ): Record<string, unknown>[] {
    return retrieval.results.slice(0, 3).map((result) => ({
      sourceTitle: result.filename,
      snippet: this.trimWebQueryContextSnippet(result.snippet),
      metadataSummary: result.metadataSummary,
    }));
  }

  private trimWebQueryContextSnippet(snippet: string): string {
    const normalized = snippet.replace(/\s+/g, ' ').trim();

    if (normalized.length <= 320) {
      return normalized;
    }

    return `${normalized.slice(0, 319).trim()}\u2026`;
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
      .filter(
        (result) =>
          result.docClass === DocumentDocClass.MANUAL &&
          this.isMaintenanceScheduleEvidence(result.snippet),
      )
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

  private shouldUseStructuredMaintenanceRecordAnswer(
    userQuestion: string,
    retrieval: DocumentRetrievalResponseDto,
  ): boolean {
    return (
      isMaintenanceRecordIntent(userQuestion) &&
      retrieval.results.some(
        (result) =>
          result.docClass === DocumentDocClass.HISTORICAL_PROCEDURE &&
          this.isMaintenanceRecordEvidence(result.snippet),
      )
    );
  }

  private isMaintenanceRecordEvidence(snippet: string): boolean {
    const normalized = snippet.toLocaleLowerCase();
    const structuredFieldCount = [
      'task_name:',
      'last_completed_date:',
      'last_completed_hours:',
      'next_due_date:',
      'next_due_hours:',
      'current_equipment_hours:',
      'status:',
      'responsible:',
      'work_scope:',
    ].filter((field) => normalized.includes(field)).length;

    return (
      normalized.includes('doc_type: maintenance_record') ||
      normalized.includes('maintenance record for') ||
      structuredFieldCount >= 2
    );
  }
}
