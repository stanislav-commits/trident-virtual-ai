import { Injectable, Logger } from '@nestjs/common';
import { ChatContextService } from './chat-context.service';
import {
  ChatCitation,
  ChatDocumentationContext,
  ChatHistoryMessage,
} from './chat.types';
import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';

@Injectable()
export class ChatDocumentationService {
  private readonly logger = new Logger(ChatDocumentationService.name);

  constructor(
    private readonly contextService: ChatContextService,
    private readonly queryService: ChatDocumentationQueryService,
    private readonly citationService: ChatDocumentationCitationService,
    private readonly scanService: ChatDocumentationScanService,
    private readonly referenceExtractionService: ChatReferenceExtractionService,
  ) {}

  async prepareDocumentationContext(params: {
    shipId: string | null;
    role: string;
    userQuery: string;
    messageHistory?: ChatHistoryMessage[];
  }): Promise<ChatDocumentationContext> {
    const { shipId, role, userQuery, messageHistory } = params;
    let citations: ChatCitation[] = [];
    const previousUserQuery =
      this.queryService.getPreviousResolvedUserQuery(messageHistory);
    const pendingClarificationQuery =
      this.queryService.getPendingClarificationQuery(messageHistory);
    const isClarificationReply = this.queryService.shouldTreatAsClarificationReply(
      userQuery,
      pendingClarificationQuery,
    );
    const retrievalQuery = isClarificationReply
      ? this.queryService.buildClarificationResolvedQuery(
          pendingClarificationQuery!,
          userQuery,
        )
      : this.queryService.buildRetrievalQuery(userQuery, previousUserQuery);
    const shouldPromoteRetrievalQueryToAnswerQuery =
      !isClarificationReply &&
      this.queryService.shouldPromoteRetrievalQueryToAnswerQuery(
        userQuery,
        previousUserQuery,
        retrievalQuery,
      );
    const effectiveUserQuery =
      isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
        ? retrievalQuery
        : userQuery;

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
        citations,
        needsClarification: true,
        clarificationQuestion:
          this.queryService.buildClarificationQuestion(userQuery),
        clarificationReason: 'underspecified_query',
        pendingClarificationQuery: userQuery.trim(),
        clarificationActions,
      };
    }

    try {
      const shouldSkipRetrieval =
        this.queryService.shouldSkipDocumentationRetrieval(effectiveUserQuery);
      const searchCitationsForQuery = async (
        query: string,
      ): Promise<ChatCitation[]> => {
        const retrievalWindow = this.queryService.getRetrievalWindow(
          query,
          effectiveUserQuery,
        );
        if (role === 'admin' || !shipId) {
          return this.contextService.findContextForAdminQuery(
            query,
            retrievalWindow.topK,
            retrievalWindow.candidateK,
          );
        }

        const result = await this.contextService.findContextForQuery(
          shipId,
          query,
          retrievalWindow.topK,
          retrievalWindow.candidateK,
        );
        return result.citations;
      };

      if (!shouldSkipRetrieval) {
        citations = await searchCitationsForQuery(retrievalQuery);
      }

      if (citations.length === 0) {
        const fallbackQuery =
          this.queryService.buildRagFallbackQuery(retrievalQuery);
        if (fallbackQuery !== retrievalQuery) {
          citations = await searchCitationsForQuery(fallbackQuery);
        }
      }

      const assetFallbackQueries =
        this.queryService.buildGeneratorAssetFallbackQueries(
          retrievalQuery,
          effectiveUserQuery,
        );
      if (
        assetFallbackQueries.length > 0 &&
        (this.queryService.shouldAugmentGeneratorAssetLookup(
          retrievalQuery,
          effectiveUserQuery,
        ) ||
          this.queryService.needsGeneratorAssetFallback(
            retrievalQuery,
            citations,
          ))
      ) {
        for (const assetFallbackQuery of assetFallbackQueries) {
          if (!assetFallbackQuery || assetFallbackQuery === retrievalQuery) {
            continue;
          }

          const fallbackCitations =
            await searchCitationsForQuery(assetFallbackQuery);

          citations =
            fallbackCitations.length > 0
              ? this.citationService.mergeCitations(citations, fallbackCitations)
              : citations;
        }
      }

      if (
        this.queryService.isPartsQuery(effectiveUserQuery) &&
        !this.queryService.hasDetailedPartsEvidence(citations)
      ) {
        const partsFallbackQueries = this.queryService.buildPartsFallbackQueries(
          retrievalQuery,
          effectiveUserQuery,
          citations,
        );

        for (const fallbackQuery of partsFallbackQueries) {
          if (!fallbackQuery || fallbackQuery === retrievalQuery) {
            continue;
          }

          const fallbackCitations = await searchCitationsForQuery(fallbackQuery);
          citations = this.citationService.mergeCitations(
            citations,
            fallbackCitations,
          );
          if (this.queryService.hasDetailedPartsEvidence(citations)) {
            break;
          }
        }
      }

      if (this.queryService.needsReferenceIdFallback(retrievalQuery, citations)) {
        const referenceFallbackQueries =
          this.queryService.buildReferenceIdFallbackQueries(retrievalQuery);
        for (const referenceFallbackQuery of referenceFallbackQueries) {
          if (
            !referenceFallbackQuery ||
            referenceFallbackQuery === retrievalQuery
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
              retrievalQuery,
              citations,
            )
          ) {
            break;
          }
        }
      }

      const referenceContinuationFallbackQueries =
        this.queryService.buildReferenceContinuationFallbackQueries(
          retrievalQuery,
          effectiveUserQuery,
          citations,
        );
      for (const continuationQuery of referenceContinuationFallbackQueries) {
        const fallbackCitations = await searchCitationsForQuery(continuationQuery);
        citations = this.citationService.mergeCitations(
          citations,
          fallbackCitations,
        );
      }

      const referenceDocumentFallbackCitations =
        await this.scanService.expandReferenceDocumentChunkCitations(
          shipId,
          retrievalQuery,
          effectiveUserQuery,
          citations,
        );
      citations = this.citationService.mergeCitations(
        citations,
        referenceDocumentFallbackCitations,
      );

      const maintenanceDocumentFallbackCitations =
        await this.scanService.expandMaintenanceAssetDocumentChunkCitations(
          shipId,
          retrievalQuery,
          effectiveUserQuery,
          citations,
        );
      citations = this.citationService.mergeCitations(
        citations,
        maintenanceDocumentFallbackCitations,
      );

      citations = this.citationService.pruneCitationsForResolvedSubject(
        retrievalQuery,
        citations,
      );
      citations = this.citationService.refineCitationsForIntent(
        retrievalQuery,
        effectiveUserQuery,
        citations,
      );
      citations = this.citationService.focusCitationsForQuery(
        retrievalQuery,
        citations,
      );
      let resolvedSubjectQuery =
        this.referenceExtractionService.buildResolvedMaintenanceSubjectQuery(
          retrievalQuery,
          effectiveUserQuery,
          citations,
        ) ?? undefined;
      if (
        resolvedSubjectQuery &&
        resolvedSubjectQuery.trim().toLowerCase() !==
          retrievalQuery.trim().toLowerCase()
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
          await this.scanService.expandReferenceDocumentChunkCitations(
            shipId,
            resolvedSubjectQuery,
            effectiveUserQuery,
            citations,
          );
        citations = this.citationService.mergeCitations(
          citations,
          resolvedReferenceDocumentFallbackCitations,
        );

        const resolvedMaintenanceDocumentFallbackCitations =
          await this.scanService.expandMaintenanceAssetDocumentChunkCitations(
            shipId,
            resolvedSubjectQuery,
            effectiveUserQuery,
            citations,
          );
        citations = this.citationService.mergeCitations(
          citations,
          resolvedMaintenanceDocumentFallbackCitations,
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
            ) ??
            resolvedSubjectQuery;
        }
      }
      const preparedAnswerCitations =
        this.citationService.prepareCitationsForAnswer(
          resolvedSubjectQuery ?? retrievalQuery,
          effectiveUserQuery,
          citations,
        );
      citations = preparedAnswerCitations.citations;
      citations = this.citationService.limitCitationsForLlm(
        effectiveUserQuery,
        citations,
        preparedAnswerCitations.compareBySource,
      );

      return {
        previousUserQuery: previousUserQuery ?? undefined,
        retrievalQuery,
        answerQuery:
          isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
            ? retrievalQuery
            : undefined,
        resolvedSubjectQuery,
        citations,
        compareBySource: preparedAnswerCitations.compareBySource,
        sourceComparisonTitles: preparedAnswerCitations.sourceComparisonTitles,
      };
    } catch (error) {
      this.logger.warn(
        `RAG retrieval skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      previousUserQuery: previousUserQuery ?? undefined,
      retrievalQuery,
      answerQuery:
        isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
          ? retrievalQuery
          : undefined,
      citations,
    };
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
        if (role === 'admin' || !shipId) {
          return this.contextService.findContextForAdminQuery(
            query,
            topK,
            candidateK,
          );
        }

        const result = await this.contextService.findContextForQuery(
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
}
