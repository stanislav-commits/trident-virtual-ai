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
    const effectiveUserQuery = isClarificationReply ? retrievalQuery : userQuery;

    if (
      this.queryService.shouldAskClarifyingQuestion({
        userQuery,
        retrievalQuery,
        previousUserQuery,
        pendingClarificationQuery,
      })
    ) {
      return {
        previousUserQuery: previousUserQuery ?? undefined,
        retrievalQuery,
        citations,
        needsClarification: true,
        clarificationQuestion:
          this.queryService.buildClarificationQuestion(userQuery),
        clarificationReason: 'underspecified_query',
        pendingClarificationQuery: userQuery.trim(),
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
      const preparedAnswerCitations =
        this.citationService.prepareCitationsForAnswer(
          retrievalQuery,
          effectiveUserQuery,
          citations,
        );
      citations = preparedAnswerCitations.citations;
      citations = this.citationService.limitCitationsForLlm(
        effectiveUserQuery,
        citations,
        preparedAnswerCitations.compareBySource,
      );
      const resolvedSubjectQuery =
        this.referenceExtractionService.buildResolvedMaintenanceSubjectQuery(
          retrievalQuery,
          effectiveUserQuery,
          citations,
        ) ?? undefined;

      return {
        previousUserQuery: previousUserQuery ?? undefined,
        retrievalQuery,
        answerQuery: isClarificationReply ? retrievalQuery : undefined,
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
      citations,
    };
  }
}
