import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatContextService } from './chat-context.service';
import { TagLinksService } from '../tags/tag-links.service';
import { DocumentationQuerySemanticNormalizerService } from '../semantic/documentation-query-semantic-normalizer.service';
import {
  DocumentationSourceLockService,
  type DocumentationSourceLockDecision,
} from '../semantic/documentation-source-lock.service';
import { ManualSemanticMatcherService } from '../semantic/manual-semantic-matcher.service';
import { PageAwareManualRetrieverService } from '../semantic/page-aware-manual-retriever.service';
import type {
  DocumentationFollowUpState,
  DocumentationRetrievalTrace,
  DocumentationSemanticCandidate,
  DocumentationSemanticQuery,
  SemanticSourceCategory,
} from '../semantic/semantic.types';
import {
  ChatCitation,
  ChatDocumentationContext,
  ChatHistoryMessage,
  ChatNormalizedQuery,
  ChatSuggestionAction,
} from './chat.types';
import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';
import {
  ChatDocumentSourceCategory,
  ChatQueryPlannerService,
} from './chat-query-planner.service';

type ChatScanExpansion = (
  shipId: string | null,
  retrievalQuery: string,
  userQuery: string,
  citations: ChatCitation[],
  allowedDocumentCategories?: ChatDocumentSourceCategory[],
  allowedManualIds?: string[],
) => Promise<ChatCitation[]>;

@Injectable()
export class ChatDocumentationService {
  private readonly logger = new Logger(ChatDocumentationService.name);
  private readonly queryPlanner: ChatQueryPlannerService;

  constructor(
    private readonly contextService: ChatContextService,
    private readonly queryService: ChatDocumentationQueryService,
    private readonly citationService: ChatDocumentationCitationService,
    private readonly scanService: ChatDocumentationScanService,
    private readonly referenceExtractionService: ChatReferenceExtractionService,
    @Optional() queryPlanner?: ChatQueryPlannerService,
    @Optional() private readonly tagLinks?: TagLinksService,
    @Optional()
    private readonly semanticNormalizer?: DocumentationQuerySemanticNormalizerService,
    @Optional()
    private readonly semanticMatcher?: ManualSemanticMatcherService,
    @Optional()
    private readonly sourceLockService?: DocumentationSourceLockService,
    @Optional()
    private readonly pageAwareRetriever?: PageAwareManualRetrieverService,
  ) {
    this.queryPlanner = queryPlanner ?? new ChatQueryPlannerService();
  }

  async prepareDocumentationContext(params: {
    shipId: string | null;
    role: string;
    userQuery: string;
    messageHistory?: ChatHistoryMessage[];
    normalizedQuery?: ChatNormalizedQuery;
  }): Promise<ChatDocumentationContext> {
    const { shipId, role, userQuery, messageHistory, normalizedQuery } = params;
    let citations: ChatCitation[] = [];
    let analysisCitations: ChatCitation[] | undefined;
    const previousUserQuery =
      normalizedQuery?.previousUserQuery ??
      this.queryService.getPreviousResolvedUserQuery(messageHistory);
    const pendingClarificationState =
      normalizedQuery?.clarificationState ??
      this.queryService.getPendingClarificationState(messageHistory);
    const pendingClarificationQuery =
      normalizedQuery?.pendingClarificationQuery ??
      pendingClarificationState?.pendingQuery ??
      this.queryService.getPendingClarificationQuery(messageHistory);
    const isClarificationReply =
      normalizedQuery?.isClarificationReply ??
      this.queryService.shouldTreatAsClarificationReply(
        userQuery,
        pendingClarificationState ?? pendingClarificationQuery,
      );
    const retrievalQuery =
      normalizedQuery?.retrievalQuery ??
      (isClarificationReply
        ? this.queryService.buildClarificationResolvedQuery(
            pendingClarificationState ?? pendingClarificationQuery!,
            userQuery,
          )
        : this.queryService.buildRetrievalQuery(userQuery, previousUserQuery));
    const shouldPromoteRetrievalQueryToAnswerQuery =
      !isClarificationReply &&
      this.queryService.shouldPromoteRetrievalQueryToAnswerQuery(
        userQuery,
        previousUserQuery,
        retrievalQuery,
      );
    const effectiveUserQuery =
      normalizedQuery?.effectiveQuery ??
      (isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
        ? retrievalQuery
        : userQuery);

    if (
      this.queryService.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery,
        previousUserQuery,
        pendingClarificationQuery,
      })
    ) {
      const clarificationActions = await this.buildClarificationActions({
        shipId,
        role,
        userQuery,
        retrievalQuery,
      });

      return {
        previousUserQuery: previousUserQuery ?? undefined,
        retrievalQuery,
        normalizedQuery,
        citations,
        needsClarification: true,
        clarificationQuestion:
          this.queryService.buildClarificationQuestion(userQuery),
        clarificationReason: 'underspecified_query',
        pendingClarificationQuery: userQuery.trim(),
        clarificationState: this.queryService.buildClarificationState({
          clarificationDomain: 'documentation',
          pendingQuery: userQuery.trim(),
          clarificationReason: 'underspecified_query',
          normalizedQuery,
        }),
        clarificationActions,
      };
    }

    const shouldSkipDocumentationForTelemetryFirstQuery =
      this.shouldSkipDocumentationForTelemetryFirstQuery(
        effectiveUserQuery,
        retrievalQuery,
        normalizedQuery,
      );

    if (shouldSkipDocumentationForTelemetryFirstQuery) {
      this.logger.debug(
        `Skipping documentation retrieval for telemetry-first query="${effectiveUserQuery}"`,
      );
      return {
        previousUserQuery: previousUserQuery ?? undefined,
        retrievalQuery,
        normalizedQuery,
        answerQuery:
          isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
            ? retrievalQuery
            : undefined,
        citations,
        analysisCitations: citations,
      };
    }

    try {
      const storedDocumentationFollowUpState =
        this.sourceLockService?.getFollowUpStateFromHistory(messageHistory) ??
        null;
      const shouldReuseStoredDocumentationFollowUpState =
        Boolean(storedDocumentationFollowUpState) &&
        this.queryService.shouldUseDocumentationFollowUpState(
          userQuery,
          normalizedQuery,
        );
      const previousDocumentationFollowUpState =
        shouldReuseStoredDocumentationFollowUpState
          ? storedDocumentationFollowUpState
          : normalizedQuery?.followUpMode === 'standalone'
            ? null
            : storedDocumentationFollowUpState;
      const semanticQuery = this.semanticNormalizer
        ? await this.semanticNormalizer.normalize({
            userQuery: effectiveUserQuery,
            retrievalQuery,
            normalizedQuery,
            followUpState: previousDocumentationFollowUpState,
          })
        : undefined;
      const hardDocumentCategories = this.getHardDocumentCategories(
        effectiveUserQuery,
        retrievalQuery,
      );
      const effectiveDocumentCategories = this.resolveDocumentCategories(
        semanticQuery,
        hardDocumentCategories,
      );
      const semanticMatcherQueryText = this.buildSemanticMatcherQueryText(
        effectiveUserQuery,
        retrievalQuery,
      );
      const semanticCandidates =
        semanticQuery && this.semanticMatcher
          ? await this.semanticMatcher.shortlistManuals({
              shipId,
              role,
              queryText: semanticMatcherQueryText,
              semanticQuery,
              allowedDocumentCategories: effectiveDocumentCategories,
            })
          : [];
      const sourceLockDecision =
        semanticQuery && this.sourceLockService
          ? this.sourceLockService.resolveSourceLock({
              userQuery: effectiveUserQuery,
              normalizedQuery,
              semanticQuery,
              followUpState: previousDocumentationFollowUpState,
              candidates: semanticCandidates,
            })
          : this.emptySourceLockDecision();
      const tagScopedManualIds = await this.resolveTagScopedManualIds(
        shipId,
        role,
        effectiveUserQuery,
        effectiveDocumentCategories,
      );
      const semanticManualIds = this.selectSemanticManualIds(
        semanticCandidates,
        semanticQuery,
      );
      const baseAllowedManualIds = this.resolveRetrievalManualScope({
        sourceLockDecision,
        semanticManualIds,
        tagScopedManualIds,
      });
      const documentationRetrievalQuery =
        this.resolveSourceLockedRetrievalQuery({
          userQuery,
          effectiveUserQuery,
          retrievalQuery,
          semanticQuery,
          sourceLockDecision,
        });
      const semanticScopeActive = semanticManualIds.length > 0;
      const retrievalTrace = this.buildRetrievalTrace({
        userQuery: effectiveUserQuery,
        retrievalQuery: documentationRetrievalQuery,
        semanticQuery,
        semanticCandidates,
        shortlistedManualIds: semanticManualIds,
        sourceLockDecision,
      });
      const sourceClarification = this.buildSemanticSourceClarification({
        userQuery: effectiveUserQuery,
        retrievalQuery,
        semanticQuery,
        semanticCandidates,
        sourceLockDecision,
        followUpState: previousDocumentationFollowUpState,
      });

      if (sourceClarification) {
        return {
          previousUserQuery: previousUserQuery ?? undefined,
          retrievalQuery,
          normalizedQuery,
          semanticQuery,
          retrievalTrace,
          sourceLockActive: false,
          citations,
          needsClarification: true,
          clarificationQuestion: sourceClarification.question,
          clarificationReason: sourceClarification.reason,
          pendingClarificationQuery: userQuery.trim(),
          clarificationState: this.queryService.buildClarificationState({
            clarificationDomain: 'documentation',
            pendingQuery: userQuery.trim(),
            clarificationReason: sourceClarification.reason,
            normalizedQuery,
          }),
          clarificationActions: sourceClarification.actions,
        };
      }

      if (
        semanticQuery?.needsClarification &&
        semanticQuery.confidence < 0.5 &&
        !sourceLockDecision.active &&
        semanticCandidates.length === 0 &&
        !tagScopedManualIds?.length
      ) {
        const clarificationActions = await this.buildClarificationActions({
          shipId,
          role,
          userQuery,
          retrievalQuery,
        });

        return {
          previousUserQuery: previousUserQuery ?? undefined,
          retrievalQuery,
          normalizedQuery,
          semanticQuery,
          retrievalTrace,
          sourceLockActive: false,
          citations,
          needsClarification: true,
          clarificationQuestion:
            this.queryService.buildClarificationQuestion(userQuery),
          clarificationReason:
            semanticQuery.clarificationReason ?? 'semantic_low_confidence',
          pendingClarificationQuery: userQuery.trim(),
          clarificationState: this.queryService.buildClarificationState({
            clarificationDomain: 'documentation',
            pendingQuery: userQuery.trim(),
            clarificationReason:
              semanticQuery.clarificationReason ?? 'semantic_low_confidence',
            normalizedQuery,
          }),
          clarificationActions,
        };
      }

      const searchCitationsForQuery = async (
        query: string,
        allowedManualIds: string[] | undefined = baseAllowedManualIds,
      ): Promise<ChatCitation[]> => {
        const retrievalWindow = this.queryService.getRetrievalWindow(
          query,
          effectiveUserQuery,
        );
        if (role === 'admin' || !shipId) {
          if (effectiveDocumentCategories?.length || allowedManualIds?.length) {
            return this.contextService.findContextForAdminQuery(
              query,
              retrievalWindow.topK,
              retrievalWindow.candidateK,
              effectiveDocumentCategories,
              allowedManualIds,
            );
          }

          return this.contextService.findContextForAdminQuery(
            query,
            retrievalWindow.topK,
            retrievalWindow.candidateK,
          );
        }

        const result =
          effectiveDocumentCategories?.length || allowedManualIds?.length
            ? await this.contextService.findContextForQuery(
                shipId,
                query,
                retrievalWindow.topK,
                retrievalWindow.candidateK,
                effectiveDocumentCategories,
                allowedManualIds,
              )
            : await this.contextService.findContextForQuery(
                shipId,
                query,
                retrievalWindow.topK,
                retrievalWindow.candidateK,
              );
        return result.citations;
      };

      let pageAwareCitations: ChatCitation[] = [];

      if (
        sourceLockDecision.active &&
        sourceLockDecision.lockedManualId &&
        Boolean(
          semanticQuery &&
          (semanticQuery.pageHint !== null ||
            semanticQuery.sectionHint !== null),
        ) &&
        this.pageAwareRetriever
      ) {
        pageAwareCitations =
          await this.pageAwareRetriever.retrieveLockedManualPage({
            manualId: sourceLockDecision.lockedManualId,
            retrievalQuery: documentationRetrievalQuery,
            pageHint: semanticQuery?.pageHint,
            sectionHint: semanticQuery?.sectionHint,
          });
        citations = this.citationService.mergeCitations(
          citations,
          pageAwareCitations,
        );
      }

      citations = this.citationService.mergeCitations(
        citations,
        await searchCitationsForQuery(documentationRetrievalQuery),
      );

      if (citations.length === 0) {
        const fallbackQuery = this.queryService.buildRagFallbackQuery(
          documentationRetrievalQuery,
        );
        if (fallbackQuery !== documentationRetrievalQuery) {
          citations = await searchCitationsForQuery(fallbackQuery);
        }
      }

      if (
        citations.length === 0 &&
        semanticScopeActive &&
        !sourceLockDecision.active
      ) {
        const widenedAllowedManualIds = this.resolveSafeFallbackManualScope({
          baseAllowedManualIds,
          tagScopedManualIds,
        });
        if (widenedAllowedManualIds) {
          retrievalTrace.fallbackWideningUsed = true;
          citations = await searchCitationsForQuery(
            documentationRetrievalQuery,
            widenedAllowedManualIds,
          );
        }
      }

      if (
        this.shouldAugmentBroadCertificateExpiryLookup(
          effectiveUserQuery,
          citations,
        )
      ) {
        for (const fallbackQuery of this.buildCertificateExpiryFallbackQueries(
          documentationRetrievalQuery,
          effectiveUserQuery,
        )) {
          if (!fallbackQuery || fallbackQuery === documentationRetrievalQuery) {
            continue;
          }

          const fallbackCitations =
            await searchCitationsForQuery(fallbackQuery);
          citations = this.citationService.mergeCitations(
            citations,
            fallbackCitations,
          );
        }
      }

      const assetFallbackQueries =
        this.queryService.buildGeneratorAssetFallbackQueries(
          documentationRetrievalQuery,
          effectiveUserQuery,
        );
      if (
        assetFallbackQueries.length > 0 &&
        (this.queryService.shouldAugmentGeneratorAssetLookup(
          documentationRetrievalQuery,
          effectiveUserQuery,
        ) ||
          this.queryService.needsGeneratorAssetFallback(
            documentationRetrievalQuery,
            citations,
          ))
      ) {
        for (const assetFallbackQuery of assetFallbackQueries) {
          if (
            !assetFallbackQuery ||
            assetFallbackQuery === documentationRetrievalQuery
          ) {
            continue;
          }

          const fallbackCitations =
            await searchCitationsForQuery(assetFallbackQuery);

          citations =
            fallbackCitations.length > 0
              ? this.citationService.mergeCitations(
                  citations,
                  fallbackCitations,
                )
              : citations;
        }
      }

      if (
        this.queryService.isPartsQuery(effectiveUserQuery) &&
        !this.queryService.hasDetailedPartsEvidence(citations)
      ) {
        const partsFallbackQueries =
          this.queryService.buildPartsFallbackQueries(
            documentationRetrievalQuery,
            effectiveUserQuery,
            citations,
          );

        for (const fallbackQuery of partsFallbackQueries) {
          if (!fallbackQuery || fallbackQuery === documentationRetrievalQuery) {
            continue;
          }

          const fallbackCitations =
            await searchCitationsForQuery(fallbackQuery);
          citations = this.citationService.mergeCitations(
            citations,
            fallbackCitations,
          );
          if (this.queryService.hasDetailedPartsEvidence(citations)) {
            break;
          }
        }
      }

      if (
        this.queryService.needsReferenceIdFallback(
          documentationRetrievalQuery,
          citations,
        )
      ) {
        const referenceFallbackQueries =
          this.queryService.buildReferenceIdFallbackQueries(
            documentationRetrievalQuery,
          );
        for (const referenceFallbackQuery of referenceFallbackQueries) {
          if (
            !referenceFallbackQuery ||
            referenceFallbackQuery === documentationRetrievalQuery
          ) {
            continue;
          }

          const fallbackCitations = await searchCitationsForQuery(
            referenceFallbackQuery,
          );
          citations = this.citationService.mergeCitations(
            citations,
            fallbackCitations,
          );
          if (
            !this.queryService.needsReferenceIdFallback(
              documentationRetrievalQuery,
              citations,
            )
          ) {
            break;
          }
        }
      }

      const referenceContinuationFallbackQueries =
        this.queryService.buildReferenceContinuationFallbackQueries(
          documentationRetrievalQuery,
          effectiveUserQuery,
          citations,
        );
      for (const continuationQuery of referenceContinuationFallbackQueries) {
        const fallbackCitations =
          await searchCitationsForQuery(continuationQuery);
        citations = this.citationService.mergeCitations(
          citations,
          fallbackCitations,
        );
      }

      const referenceDocumentFallbackCitations = await this.expandScanCitations(
        this.scanService.expandReferenceDocumentChunkCitations.bind(
          this.scanService,
        ),
        shipId,
        documentationRetrievalQuery,
        effectiveUserQuery,
        citations,
        effectiveDocumentCategories,
        baseAllowedManualIds,
      );
      citations = this.citationService.mergeCitations(
        citations,
        referenceDocumentFallbackCitations,
      );

      const maintenanceDocumentFallbackCitations =
        await this.expandScanCitations(
          this.scanService.expandMaintenanceAssetDocumentChunkCitations.bind(
            this.scanService,
          ),
          shipId,
          documentationRetrievalQuery,
          effectiveUserQuery,
          citations,
          effectiveDocumentCategories,
          baseAllowedManualIds,
        );
      citations = this.citationService.mergeCitations(
        citations,
        maintenanceDocumentFallbackCitations,
      );
      const manualIntervalFallbackCitations = await this.expandScanCitations(
        this.scanService.expandManualIntervalMaintenanceChunkCitations?.bind(
          this.scanService,
        ),
        shipId,
        documentationRetrievalQuery,
        effectiveUserQuery,
        citations,
        effectiveDocumentCategories,
        baseAllowedManualIds,
      );
      citations = this.citationService.mergeCitations(
        citations,
        manualIntervalFallbackCitations,
      );

      const certificateDocumentFallbackCitations =
        await this.expandScanCitations(
          this.scanService.expandCertificateExpiryDocumentChunkCitations.bind(
            this.scanService,
          ),
          shipId,
          documentationRetrievalQuery,
          effectiveUserQuery,
          citations,
          effectiveDocumentCategories,
          baseAllowedManualIds,
        );
      citations = this.citationService.mergeCitations(
        citations,
        certificateDocumentFallbackCitations,
      );
      const personnelDirectoryFallbackCitations =
        await this.expandScanCitations(
          this.scanService.expandPersonnelDirectoryDocumentChunkCitations.bind(
            this.scanService,
          ),
          shipId,
          documentationRetrievalQuery,
          effectiveUserQuery,
          citations,
          effectiveDocumentCategories,
          baseAllowedManualIds,
        );
      citations = this.citationService.mergeCitations(
        citations,
        personnelDirectoryFallbackCitations,
      );
      const tankCapacityFallbackCitations = await this.expandScanCitations(
        this.scanService.expandTankCapacityDocumentChunkCitations.bind(
          this.scanService,
        ),
        shipId,
        documentationRetrievalQuery,
        effectiveUserQuery,
        citations,
        effectiveDocumentCategories,
        baseAllowedManualIds,
      );
      citations = this.citationService.mergeCitations(
        citations,
        tankCapacityFallbackCitations,
      );
      const auditChecklistFallbackCitations = await this.expandScanCitations(
        this.scanService.expandAuditChecklistDocumentChunkCitations.bind(
          this.scanService,
        ),
        shipId,
        documentationRetrievalQuery,
        effectiveUserQuery,
        citations,
        effectiveDocumentCategories,
        baseAllowedManualIds,
      );
      citations = this.citationService.mergeCitations(
        citations,
        auditChecklistFallbackCitations,
      );
      if (this.isBroadCertificateSoonQuery(effectiveUserQuery)) {
        analysisCitations = [...citations];
      }

      citations = this.citationService.pruneCitationsForResolvedSubject(
        documentationRetrievalQuery,
        citations,
      );
      citations = this.citationService.refineCitationsForIntent(
        documentationRetrievalQuery,
        effectiveUserQuery,
        citations,
      );
      citations = this.citationService.focusCitationsForQuery(
        documentationRetrievalQuery,
        citations,
      );
      let resolvedSubjectQuery =
        this.referenceExtractionService.buildResolvedMaintenanceSubjectQuery(
          documentationRetrievalQuery,
          effectiveUserQuery,
          citations,
        ) ?? undefined;
      if (
        resolvedSubjectQuery &&
        resolvedSubjectQuery.trim().toLowerCase() !==
          documentationRetrievalQuery.trim().toLowerCase()
      ) {
        const resolvedSubjectFallbackCitations =
          await searchCitationsForQuery(resolvedSubjectQuery);
        citations = this.citationService.mergeCitations(
          citations,
          resolvedSubjectFallbackCitations,
        );

        const resolvedReferenceContinuationFallbackQueries =
          this.queryService.buildReferenceContinuationFallbackQueries(
            resolvedSubjectQuery,
            effectiveUserQuery,
            citations,
          );
        for (const continuationQuery of resolvedReferenceContinuationFallbackQueries) {
          const fallbackCitations =
            await searchCitationsForQuery(continuationQuery);
          citations = this.citationService.mergeCitations(
            citations,
            fallbackCitations,
          );
        }

        const resolvedReferenceDocumentFallbackCitations =
          await this.expandScanCitations(
            this.scanService.expandReferenceDocumentChunkCitations.bind(
              this.scanService,
            ),
            shipId,
            resolvedSubjectQuery,
            effectiveUserQuery,
            citations,
            effectiveDocumentCategories,
            baseAllowedManualIds,
          );
        citations = this.citationService.mergeCitations(
          citations,
          resolvedReferenceDocumentFallbackCitations,
        );

        const resolvedMaintenanceDocumentFallbackCitations =
          await this.expandScanCitations(
            this.scanService.expandMaintenanceAssetDocumentChunkCitations.bind(
              this.scanService,
            ),
            shipId,
            resolvedSubjectQuery,
            effectiveUserQuery,
            citations,
            effectiveDocumentCategories,
            baseAllowedManualIds,
          );
        citations = this.citationService.mergeCitations(
          citations,
          resolvedMaintenanceDocumentFallbackCitations,
        );
        const resolvedManualIntervalFallbackCitations =
          await this.expandScanCitations(
            this.scanService.expandManualIntervalMaintenanceChunkCitations?.bind(
              this.scanService,
            ),
            shipId,
            resolvedSubjectQuery,
            effectiveUserQuery,
            citations,
            effectiveDocumentCategories,
            baseAllowedManualIds,
          );
        citations = this.citationService.mergeCitations(
          citations,
          resolvedManualIntervalFallbackCitations,
        );

        const narrowedCitations = this.citationService.focusCitationsForQuery(
          resolvedSubjectQuery,
          this.citationService.refineCitationsForIntent(
            resolvedSubjectQuery,
            effectiveUserQuery,
            this.citationService.pruneCitationsForResolvedSubject(
              resolvedSubjectQuery,
              citations,
            ),
          ),
        );

        if (narrowedCitations.length > 0) {
          citations = narrowedCitations;
          resolvedSubjectQuery =
            this.referenceExtractionService.buildResolvedMaintenanceSubjectQuery(
              resolvedSubjectQuery,
              effectiveUserQuery,
              citations,
            ) ?? resolvedSubjectQuery;
        }
      }
      const enforceManualScope = (items: ChatCitation[]) =>
        this.enforceManualScopeOnCitations({
          citations: items,
          baseAllowedManualIds,
          sourceLockDecision,
        });
      const finalAnalysisCitations = enforceManualScope(
        analysisCitations ?? citations,
      );
      citations = this.prioritizeSourceLockedEvidence({
        citations,
        pageAwareCitations,
        semanticQuery,
        sourceLockDecision,
      });
      citations = enforceManualScope(citations);
      const preparedAnswerCitations =
        this.citationService.prepareCitationsForAnswer(
          resolvedSubjectQuery ?? documentationRetrievalQuery,
          effectiveUserQuery,
          citations,
        );
      citations = this.prioritizeSourceLockedEvidence({
        citations: preparedAnswerCitations.citations,
        pageAwareCitations,
        semanticQuery,
        sourceLockDecision,
      });
      citations = enforceManualScope(citations);
      citations = this.citationService.limitCitationsForLlm(
        effectiveUserQuery,
        citations,
        preparedAnswerCitations.compareBySource ||
          preparedAnswerCitations.mergeBySource,
      );
      citations = this.prioritizeSourceLockedEvidence({
        citations,
        pageAwareCitations,
        semanticQuery,
        sourceLockDecision,
      });
      citations = enforceManualScope(citations);
      const documentationFollowUpState =
        semanticQuery && this.sourceLockService
          ? this.sourceLockService.buildNextFollowUpState({
              semanticQuery,
              citations,
              candidates: semanticCandidates,
              sourceLockDecision,
            })
          : undefined;

      return {
        previousUserQuery: previousUserQuery ?? undefined,
        retrievalQuery: documentationRetrievalQuery,
        normalizedQuery,
        semanticQuery,
        documentationFollowUpState: documentationFollowUpState ?? undefined,
        retrievalTrace,
        sourceLockActive: sourceLockDecision.active,
        answerQuery:
          isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
            ? documentationRetrievalQuery
            : undefined,
        resolvedSubjectQuery,
        citations,
        analysisCitations: finalAnalysisCitations,
        compareBySource: preparedAnswerCitations.compareBySource,
        sourceComparisonTitles: preparedAnswerCitations.sourceComparisonTitles,
        mergeBySource: preparedAnswerCitations.mergeBySource,
        sourceMergeTitles: preparedAnswerCitations.sourceMergeTitles,
      };
    } catch (error) {
      this.logger.warn(
        `RAG retrieval skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      previousUserQuery: previousUserQuery ?? undefined,
      retrievalQuery,
      normalizedQuery,
      answerQuery:
        isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
          ? retrievalQuery
          : undefined,
      citations,
      analysisCitations: citations,
    };
  }

  private shouldAugmentBroadCertificateExpiryLookup(
    userQuery: string,
    citations: ChatCitation[],
  ): boolean {
    if (!this.isBroadCertificateSoonQuery(userQuery)) {
      return false;
    }

    const futureExplicitExpiryCount = citations.filter((citation) =>
      this.extractExplicitCertificateExpiryTimestamps(
        citation.snippet ?? '',
      ).some((expiry) => expiry >= Date.now()),
    ).length;

    return futureExplicitExpiryCount === 0;
  }

  private buildCertificateExpiryFallbackQueries(
    retrievalQuery: string,
    userQuery: string,
  ): string[] {
    if (!this.isBroadCertificateSoonQuery(userQuery)) {
      return [];
    }

    const queries = new Set<string>();
    const normalized = retrievalQuery.trim().replace(/\s+/g, ' ');
    queries.add(`${normalized} expiry date valid until expiring`);
    queries.add('certificate expiry date expiration date valid until expiring');
    queries.add('certificate valid until expiration date survey approval');
    queries.add(
      'certificate approval assessment expiry date valid until expiration date',
    );

    return [...queries];
  }

  private isBroadCertificateSoonQuery(query: string): boolean {
    return (
      /\b(certificates?|certifications?)\b/i.test(query) &&
      /\b(expire|expiry|expiries|expiring|valid\s+until|due\s+to\s+expire)\b/i.test(
        query,
      ) &&
      /\b(soon|upcoming|next|nearest)\b/i.test(query)
    );
  }

  private extractExplicitCertificateExpiryTimestamp(
    text: string,
  ): number | null {
    return this.extractExplicitCertificateExpiryTimestamps(text)[0] ?? null;
  }

  private extractExplicitCertificateExpiryTimestamps(text: string): number[] {
    const plainText = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const pattern =
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b/gi;
    const timestamps = new Set<number>();

    for (const match of plainText.matchAll(pattern)) {
      if (!match[1]) {
        continue;
      }

      const timestamp = this.parseCertificateDateToken(match[1]);
      if (timestamp !== null) {
        timestamps.add(timestamp);
      }
    }

    return [...timestamps].sort((left, right) => left - right);
  }

  private parseCertificateDateToken(token: string): number | null {
    const normalized = token.replace(/\s+/g, ' ').trim();
    const monthNames = new Map<string, number>([
      ['jan', 0],
      ['january', 0],
      ['feb', 1],
      ['february', 1],
      ['mar', 2],
      ['march', 2],
      ['apr', 3],
      ['april', 3],
      ['may', 4],
      ['jun', 5],
      ['june', 5],
      ['jul', 6],
      ['july', 6],
      ['aug', 7],
      ['august', 7],
      ['sep', 8],
      ['sept', 8],
      ['september', 8],
      ['oct', 9],
      ['october', 9],
      ['nov', 10],
      ['november', 10],
      ['dec', 11],
      ['december', 11],
    ]);

    const numericMatch = normalized.match(
      /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/,
    );
    if (numericMatch) {
      const day = Number.parseInt(numericMatch[1], 10);
      const month = Number.parseInt(numericMatch[2], 10) - 1;
      let year = Number.parseInt(numericMatch[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      const timestamp = Date.UTC(year, month, day);
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    const monthNameMatch = normalized.match(
      /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+|[-/])([a-z]{3,9})(?:\s+|[-/])(\d{2,4})$/i,
    );
    if (monthNameMatch) {
      const day = Number.parseInt(monthNameMatch[1], 10);
      const month = monthNames.get(monthNameMatch[2].toLowerCase());
      if (month === undefined) {
        return null;
      }
      let year = Number.parseInt(monthNameMatch[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      const timestamp = Date.UTC(year, month, day);
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    return null;
  }

  private async buildClarificationActions(params: {
    shipId: string | null;
    role: string;
    userQuery: string;
    retrievalQuery: string;
  }) {
    const { shipId, role, userQuery, retrievalQuery } = params;
    if (this.queryService.shouldSkipDocumentationRetrieval(userQuery)) {
      return [];
    }

    try {
      const retrievalWindow = this.queryService.getRetrievalWindow(
        retrievalQuery,
        userQuery,
      );
      const topK = Math.min(Math.max(retrievalWindow.topK, 6), 8);
      const candidateK = Math.min(
        Math.max(retrievalWindow.candidateK, topK * 3),
        24,
      );

      const search = async (query: string) => {
        const hardDocumentCategories = this.getHardDocumentCategories(
          userQuery,
          query,
        );
        if (role === 'admin' || !shipId) {
          if (hardDocumentCategories?.length) {
            return this.contextService.findContextForAdminQuery(
              query,
              topK,
              candidateK,
              hardDocumentCategories,
            );
          }

          return this.contextService.findContextForAdminQuery(
            query,
            topK,
            candidateK,
          );
        }

        const result = hardDocumentCategories?.length
          ? await this.contextService.findContextForQuery(
              shipId,
              query,
              topK,
              candidateK,
              hardDocumentCategories,
            )
          : await this.contextService.findContextForQuery(
              shipId,
              query,
              topK,
              candidateK,
            );
        return result.citations;
      };

      let citations = await search(retrievalQuery);
      if (citations.length === 0) {
        const fallbackQuery =
          this.queryService.buildRagFallbackQuery(retrievalQuery);
        if (fallbackQuery && fallbackQuery !== retrievalQuery) {
          citations = await search(fallbackQuery);
        }
      }

      return this.referenceExtractionService.buildClarificationActions(
        userQuery,
        citations,
      );
    } catch (error) {
      this.logger.debug(
        `Clarification action generation skipped: ${String(error)}`,
      );
      return [];
    }
  }

  private expandScanCitations(
    expand: ChatScanExpansion | undefined,
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!expand) {
      return Promise.resolve([]);
    }

    return allowedDocumentCategories?.length || allowedManualIds?.length
      ? expand(
          shipId,
          retrievalQuery,
          userQuery,
          citations,
          allowedDocumentCategories,
          allowedManualIds,
        )
      : expand(shipId, retrievalQuery, userQuery, citations);
  }

  private getHardDocumentCategories(
    userQuery: string,
    retrievalQuery: string,
  ): ChatDocumentSourceCategory[] | undefined {
    return this.queryPlanner.planQuery(userQuery, retrievalQuery)
      .hardDocumentCategories;
  }

  private toChatDocumentCategories(
    categories: SemanticSourceCategory[],
  ): ChatDocumentSourceCategory[] | undefined {
    const allowed = new Set<ChatDocumentSourceCategory>([
      'MANUALS',
      'HISTORY_PROCEDURES',
      'REGULATION',
      'CERTIFICATES',
    ]);
    const normalized = categories.filter(
      (category): category is ChatDocumentSourceCategory =>
        allowed.has(category as ChatDocumentSourceCategory),
    );

    return normalized.length > 0 ? [...new Set(normalized)] : undefined;
  }

  private resolveDocumentCategories(
    semanticQuery?: DocumentationSemanticQuery,
    hardDocumentCategories?: ChatDocumentSourceCategory[],
  ): ChatDocumentSourceCategory[] | undefined {
    if (semanticQuery?.explicitSource) {
      return undefined;
    }

    const categories = hardDocumentCategories?.length
      ? hardDocumentCategories
      : this.toChatDocumentCategories(semanticQuery?.sourcePreferences ?? []);
    return this.expandProcedureDocumentCategories(categories, semanticQuery);
  }

  private expandProcedureDocumentCategories(
    categories?: ChatDocumentSourceCategory[],
    semanticQuery?: DocumentationSemanticQuery,
  ): ChatDocumentSourceCategory[] | undefined {
    if (!semanticQuery || !this.isProcedureSemanticQuery(semanticQuery)) {
      return categories;
    }

    const expanded = new Set<ChatDocumentSourceCategory>(categories ?? []);
    expanded.add('MANUALS');
    expanded.add('HISTORY_PROCEDURES');
    expanded.add('REGULATION');
    return [...expanded];
  }

  private isProcedureSemanticQuery(
    semanticQuery: DocumentationSemanticQuery,
  ): boolean {
    switch (semanticQuery.intent) {
      case 'operational_procedure':
      case 'maintenance_procedure':
      case 'troubleshooting':
        return true;
      default:
        return false;
    }
  }

  private emptySourceLockDecision(): DocumentationSourceLockDecision {
    return {
      active: false,
      lockedManualId: null,
      lockedManualTitle: null,
      lockedDocumentId: null,
      reason: null,
    };
  }

  private resolveSourceLockedRetrievalQuery(params: {
    userQuery: string;
    effectiveUserQuery: string;
    retrievalQuery: string;
    semanticQuery?: DocumentationSemanticQuery;
    sourceLockDecision: DocumentationSourceLockDecision;
  }): string {
    const {
      userQuery,
      effectiveUserQuery,
      retrievalQuery,
      semanticQuery,
      sourceLockDecision,
    } = params;
    if (!sourceLockDecision.active) {
      return retrievalQuery;
    }

    if (semanticQuery?.explicitSource) {
      const currentTurnQuery = userQuery.trim() || effectiveUserQuery.trim();
      return (
        this.extractQuestionFromExplicitSourceSelection(
          currentTurnQuery,
          semanticQuery.explicitSource,
          sourceLockDecision.lockedManualTitle,
        ) ||
        currentTurnQuery ||
        retrievalQuery
      );
    }

    const hasPageOrSectionHint =
      Boolean(semanticQuery) &&
      (semanticQuery?.pageHint !== null || semanticQuery?.sectionHint !== null);
    const hasContextualSourceReference =
      this.hasContextualSourceReference(userQuery);
    if (!hasPageOrSectionHint && !hasContextualSourceReference) {
      return retrievalQuery;
    }

    const currentTurnQuery = userQuery.trim() || effectiveUserQuery.trim();
    return currentTurnQuery || retrievalQuery;
  }

  private extractQuestionFromExplicitSourceSelection(
    query: string,
    explicitSource?: string | null,
    lockedManualTitle?: string | null,
  ): string | null {
    const trimmed = query.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      return null;
    }

    const sourceSelectionMatch = trimmed.match(
      /^(?:from|according\s+to|inside|in)\s+(?:the\s+)?(.{2,180}?)\s+(?:manual|guide|handbook|document|procedure|file)\s*(?::|-|,)\s*(.+)$/i,
    );
    const sourceLabel = sourceSelectionMatch?.[1]?.trim();
    const question = sourceSelectionMatch?.[2]?.trim();
    if (
      !sourceLabel ||
      !question ||
      !this.isCompatibleExplicitSourceSelection(
        sourceLabel,
        explicitSource,
        lockedManualTitle,
      )
    ) {
      return null;
    }

    return question;
  }

  private isCompatibleExplicitSourceSelection(
    sourceLabel: string,
    explicitSource?: string | null,
    lockedManualTitle?: string | null,
  ): boolean {
    const normalizedLabel = this.queryService
      .normalizeSourceTitleHint(sourceLabel)
      ?.toLowerCase();
    const expectedSources = [explicitSource, lockedManualTitle]
      .map((source) =>
        this.queryService.normalizeSourceTitleHint(source ?? undefined),
      )
      .filter((source): source is string => Boolean(source))
      .map((source) => source.toLowerCase());

    if (!normalizedLabel || expectedSources.length === 0) {
      return true;
    }

    return expectedSources.some(
      (source) =>
        source === normalizedLabel ||
        source.includes(normalizedLabel) ||
        normalizedLabel.includes(source),
    );
  }

  private prioritizeSourceLockedEvidence(params: {
    citations: ChatCitation[];
    pageAwareCitations: ChatCitation[];
    semanticQuery?: DocumentationSemanticQuery;
    sourceLockDecision: DocumentationSourceLockDecision;
  }): ChatCitation[] {
    const { citations, pageAwareCitations, semanticQuery, sourceLockDecision } =
      params;
    if (
      citations.length === 0 ||
      !sourceLockDecision.active ||
      !sourceLockDecision.lockedManualId
    ) {
      return citations;
    }

    const lockedCitations = citations.filter((citation) =>
      this.matchesLockedSource(citation, sourceLockDecision),
    );
    const scopedCitations =
      lockedCitations.length > 0 ? lockedCitations : citations;
    const pageHint = semanticQuery?.pageHint ?? null;
    if (pageHint !== null) {
      const exactPageCitations = scopedCitations.filter(
        (citation) => citation.pageNumber === pageHint,
      );
      const exactPageAwareCitations = pageAwareCitations.filter(
        (citation) =>
          citation.pageNumber === pageHint &&
          this.matchesLockedSource(citation, sourceLockDecision),
      );

      if (exactPageCitations.length > 0 || exactPageAwareCitations.length > 0) {
        return this.citationService.mergeCitations(
          exactPageAwareCitations,
          exactPageCitations,
        );
      }
    }

    const lockedPageAwareCitations = pageAwareCitations.filter((citation) =>
      this.matchesLockedSource(citation, sourceLockDecision),
    );
    if (lockedPageAwareCitations.length > 0) {
      return this.citationService.mergeCitations(
        lockedPageAwareCitations,
        scopedCitations,
      );
    }

    return scopedCitations;
  }

  private enforceManualScopeOnCitations(params: {
    citations: ChatCitation[];
    baseAllowedManualIds?: string[];
    sourceLockDecision: DocumentationSourceLockDecision;
  }): ChatCitation[] {
    const { citations, baseAllowedManualIds, sourceLockDecision } = params;
    if (citations.length === 0) {
      return citations;
    }

    const allowedManualIds = new Set(
      (baseAllowedManualIds ?? []).map((manualId) => manualId.trim()).filter(Boolean),
    );
    if (sourceLockDecision.lockedManualId?.trim()) {
      allowedManualIds.add(sourceLockDecision.lockedManualId.trim());
    }

    const lockedTitle = sourceLockDecision.lockedManualTitle
      ? this.queryService.normalizeSourceTitleHint(
          sourceLockDecision.lockedManualTitle,
        )
      : null;
    if (allowedManualIds.size === 0 && !lockedTitle) {
      return citations;
    }

    return citations.filter((citation) => {
      if (citation.shipManualId && allowedManualIds.has(citation.shipManualId)) {
        return true;
      }

      if (!lockedTitle || !citation.sourceTitle) {
        return false;
      }

      const citationTitle = this.queryService.normalizeSourceTitleHint(
        citation.sourceTitle,
      );
      return Boolean(citationTitle && citationTitle === lockedTitle);
    });
  }

  private matchesLockedSource(
    citation: ChatCitation,
    sourceLockDecision: DocumentationSourceLockDecision,
  ): boolean {
    if (
      sourceLockDecision.lockedManualId &&
      citation.shipManualId === sourceLockDecision.lockedManualId
    ) {
      return true;
    }

    if (!sourceLockDecision.lockedManualTitle || !citation.sourceTitle) {
      return false;
    }

    const citationTitle = this.queryService.normalizeSourceTitleHint(
      citation.sourceTitle,
    );
    const lockedTitle = this.queryService.normalizeSourceTitleHint(
      sourceLockDecision.lockedManualTitle,
    );

    return Boolean(
      citationTitle && lockedTitle && citationTitle === lockedTitle,
    );
  }

  private selectSemanticManualIds(
    candidates: DocumentationSemanticCandidate[],
    semanticQuery?: DocumentationSemanticQuery,
  ): string[] {
    if (candidates.length === 0) {
      return [];
    }

    if (semanticQuery?.answerFormat === 'comparison') {
      return this.uniqueCandidateSources(candidates)
        .slice(0, 4)
        .map((candidate) => candidate.manualId);
    }

    const topScore = candidates[0].score;
    const ratio = topScore >= 100 ? 0.72 : topScore >= 70 ? 0.78 : 0.85;
    const floor = Math.max(24, topScore * ratio);
    const selected = this.uniqueCandidateSources(
      candidates.filter((candidate) => candidate.score >= floor),
    );

    return (selected.length > 0 ? selected : [candidates[0]])
      .slice(0, 2)
      .map((candidate) => candidate.manualId);
  }

  private buildSemanticSourceClarification(params: {
    userQuery: string;
    retrievalQuery: string;
    semanticQuery?: DocumentationSemanticQuery;
    semanticCandidates: DocumentationSemanticCandidate[];
    sourceLockDecision: DocumentationSourceLockDecision;
    followUpState?: DocumentationFollowUpState | null;
  }): {
    question: string;
    reason: string;
    actions: ChatSuggestionAction[];
  } | null {
    if (
      !params.semanticQuery ||
      params.sourceLockDecision.active ||
      params.semanticQuery.answerFormat === 'comparison'
    ) {
      return null;
    }

    const candidates = this.uniqueCandidateSources(params.semanticCandidates);
    if (candidates.length < 2) {
      return null;
    }

    const contextualSourceReference = this.hasContextualSourceReference(
      params.userQuery,
    );
    if (contextualSourceReference && !params.followUpState?.lockedManualId) {
      return {
        question:
          'I found several possible documents for "this manual". Which one should I use?',
        reason: 'semantic_context_source_ambiguous',
        actions: this.buildSourceCandidateActions(
          candidates.slice(0, 4),
          params.retrievalQuery,
        ),
      };
    }

    if (params.semanticQuery.explicitSource) {
      return null;
    }

    const topScore = candidates[0].score;
    if (topScore < 40) {
      return null;
    }

    const closeCandidates = candidates
      .filter(
        (candidate) =>
          candidate.score >= Math.max(40, topScore * 0.82) ||
          topScore - candidate.score <= 8,
      )
      .slice(0, 4);
    if (closeCandidates.length < 2) {
      return null;
    }

    const topCandidate = closeCandidates[0];
    const competingCandidates = closeCandidates.slice(1);
    if (
      this.hasStrongDirectSourceMatch(topCandidate) &&
      competingCandidates.every(
        (candidate) => !this.hasStrongDirectSourceMatch(candidate),
      )
    ) {
      return null;
    }

    if (
      this.queryService.isIntervalMaintenanceQuery(params.retrievalQuery) &&
      this.shouldPreferTopIntervalMaintenanceCandidate(closeCandidates)
    ) {
      return null;
    }

    return null;
  }

  private buildSourceCandidateActions(
    candidates: DocumentationSemanticCandidate[],
    userQuery: string,
  ): ChatSuggestionAction[] {
    return candidates.map((candidate) => ({
      label: this.truncate(candidate.filename.replace(/\.pdf$/i, ''), 80),
      message: `From ${candidate.filename} document: ${userQuery}`,
      kind: 'suggestion',
    }));
  }

  private resolveSafeFallbackManualScope(params: {
    baseAllowedManualIds?: string[];
    tagScopedManualIds?: string[];
  }): string[] | undefined {
    const tagScopedManualIds = [
      ...new Set(
        (params.tagScopedManualIds ?? []).map((manualId) => manualId.trim()),
      ),
    ].filter(Boolean);
    if (tagScopedManualIds.length === 0) {
      return undefined;
    }

    const baseAllowedManualIds = new Set(
      (params.baseAllowedManualIds ?? [])
        .map((manualId) => manualId.trim())
        .filter(Boolean),
    );
    if (baseAllowedManualIds.size === 0) {
      return tagScopedManualIds;
    }

    const expandsBeyondSemanticScope = tagScopedManualIds.some(
      (manualId) => !baseAllowedManualIds.has(manualId),
    );
    return expandsBeyondSemanticScope ? tagScopedManualIds : undefined;
  }

  private uniqueCandidateSources(
    candidates: DocumentationSemanticCandidate[],
  ): DocumentationSemanticCandidate[] {
    const seen = new Set<string>();
    const unique: DocumentationSemanticCandidate[] = [];

    for (const candidate of candidates) {
      if (seen.has(candidate.manualId)) {
        continue;
      }
      seen.add(candidate.manualId);
      unique.push(candidate);
    }

    return unique;
  }

  private hasStrongDirectSourceMatch(
    candidate: DocumentationSemanticCandidate,
  ): boolean {
    const strongReasons = new Set([
      'concrete_subject',
      'equipment_overlap',
      'explicit_source',
      'filename_overlap',
      'query_anchor',
      'section_hint',
      'vendor',
      'model',
      'system_overlap',
    ]);

    return candidate.reasons.some((reason) => strongReasons.has(reason));
  }

  private shouldPreferTopIntervalMaintenanceCandidate(
    candidates: DocumentationSemanticCandidate[],
  ): boolean {
    if (candidates.length < 2) {
      return true;
    }

    const [topCandidate, secondCandidate] = candidates;
    const lead = topCandidate.score - secondCandidate.score;
    const ratio =
      secondCandidate.score > 0 ? topCandidate.score / secondCandidate.score : 999;

    if (
      lead >= 12 &&
      (ratio >= 1.08 || this.hasStrongDirectSourceMatch(topCandidate))
    ) {
      return true;
    }

    return false;
  }

  private resolveRetrievalManualScope(params: {
    sourceLockDecision: DocumentationSourceLockDecision;
    semanticManualIds: string[];
    tagScopedManualIds?: string[];
  }): string[] | undefined {
    if (
      params.sourceLockDecision.active &&
      params.sourceLockDecision.lockedManualId
    ) {
      return [params.sourceLockDecision.lockedManualId];
    }

    const semanticManualIds = [...new Set(params.semanticManualIds)];
    const tagScopedManualIds = [...new Set(params.tagScopedManualIds ?? [])];
    if (semanticManualIds.length > 0 && tagScopedManualIds.length > 0) {
      const tagScopedSet = new Set(tagScopedManualIds);
      const intersection = semanticManualIds.filter((manualId) =>
        tagScopedSet.has(manualId),
      );
      if (intersection.length > 0) {
        return intersection;
      }
      return semanticManualIds;
    }

    if (semanticManualIds.length > 0) {
      return semanticManualIds;
    }

    return tagScopedManualIds.length > 0 ? tagScopedManualIds : undefined;
  }

  private buildRetrievalTrace(params: {
    userQuery: string;
    retrievalQuery: string;
    semanticQuery?: DocumentationSemanticQuery;
    semanticCandidates: DocumentationSemanticCandidate[];
    shortlistedManualIds?: string[];
    sourceLockDecision: DocumentationSourceLockDecision;
  }): DocumentationRetrievalTrace {
    const {
      userQuery,
      retrievalQuery,
      semanticQuery,
      semanticCandidates,
      shortlistedManualIds,
      sourceLockDecision,
    } = params;
    const scopedCandidates =
      shortlistedManualIds && shortlistedManualIds.length > 0
        ? shortlistedManualIds
            .map((manualId) =>
              semanticCandidates.find((candidate) => candidate.manualId === manualId),
            )
            .filter(
              (candidate): candidate is DocumentationSemanticCandidate =>
                Boolean(candidate),
            )
        : semanticCandidates;

    return {
      rawQuery: userQuery,
      retrievalQuery,
      semanticIntent: semanticQuery?.intent,
      semanticConceptIds: semanticQuery?.selectedConceptIds,
      semanticConfidence: semanticQuery?.confidence,
      candidateConceptIds: semanticQuery?.candidateConceptIds,
      sourcePreferences: semanticQuery?.sourcePreferences,
      explicitSource: semanticQuery?.explicitSource,
      lockedManualId: sourceLockDecision.lockedManualId,
      lockedManualTitle: sourceLockDecision.lockedManualTitle,
      sourceLockActive: sourceLockDecision.active,
      pageHint: semanticQuery?.pageHint,
      sectionHint: semanticQuery?.sectionHint,
      shortlistedManualIds: scopedCandidates.map(
        (candidate) => candidate.manualId,
      ),
      shortlistedManualTitles: scopedCandidates.map(
        (candidate) => candidate.filename,
      ),
      fallbackWideningUsed: false,
    };
  }

  private shouldSkipDocumentationForTelemetryFirstQuery(
    effectiveUserQuery: string,
    retrievalQuery: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): boolean {
    if (
      this.queryService.shouldSkipDocumentationRetrieval(effectiveUserQuery)
    ) {
      return true;
    }

    if (
      this.isDocumentationClarificationTurn(normalizedQuery) ||
      this.hasExplicitDocumentSourceReference(effectiveUserQuery)
    ) {
      return false;
    }

    const queryPlan = this.queryPlanner.planQuery(
      normalizedQuery ?? effectiveUserQuery,
      retrievalQuery,
    );

    if (
      queryPlan.primaryIntent !== 'telemetry_status' &&
      queryPlan.primaryIntent !== 'telemetry_list'
    ) {
      return false;
    }

    if (queryPlan.supportsMultiSourceAggregation) {
      return false;
    }

    if (normalizedQuery?.sourceHints.includes('DOCUMENTATION')) {
      return false;
    }

    return !/\b(according\s+to|manual|documentation|docs?|handbook|guide|procedure|steps?|spec(?:ification)?|recommended|normal\s+range|operating\s+range|limit|limits|specified)\b/i.test(
      effectiveUserQuery,
    );
  }

  private isDocumentationClarificationTurn(
    normalizedQuery?: ChatNormalizedQuery,
  ): boolean {
    return (
      normalizedQuery?.clarificationState?.clarificationDomain ===
      'documentation'
    );
  }

  private async resolveTagScopedManualIds(
    shipId: string | null,
    role: string,
    query: string,
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
  ): Promise<string[] | undefined> {
    if (!this.tagLinks) {
      return undefined;
    }

    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return undefined;
    }

    const manualIds =
      role === 'admin' || !shipId
        ? await this.tagLinks.findTaggedManualIdsForAdminQuery(
            normalizedQuery,
            allowedDocumentCategories,
          )
        : await this.tagLinks.findTaggedManualIdsForShipQuery(
            shipId,
            normalizedQuery,
            allowedDocumentCategories,
          );

    return manualIds.length > 0 ? manualIds : undefined;
  }

  private buildSemanticMatcherQueryText(
    effectiveUserQuery: string,
    retrievalQuery: string,
  ): string {
    const uniqueQueries: string[] = [];
    const seen = new Set<string>();

    for (const query of [effectiveUserQuery, retrievalQuery]) {
      const trimmed = query.replace(/\s+/g, ' ').trim();
      if (!trimmed) {
        continue;
      }

      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      uniqueQueries.push(trimmed);
    }

    return uniqueQueries.join('\n');
  }

  private hasContextualSourceReference(query: string): boolean {
    return (
      /\b(this|that|same|current|previous)\s+(manual|guide|document|procedure|file|pdf|one)\b/i.test(
        query,
      ) || /\b(in|from)\s+(this|that|same|current|previous)\b/i.test(query)
    );
  }

  private hasExplicitDocumentSourceReference(query: string): boolean {
    return /\bfrom\s+[\s\S]{1,180}\b(?:document|manual|guide|procedure|file|pdf)\b/i.test(
      query,
    );
  }

  private truncate(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }
}
