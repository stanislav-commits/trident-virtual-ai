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

@Injectable()
export class ChatDocumentationService {
  private readonly logger = new Logger(ChatDocumentationService.name);

  constructor(
    private readonly contextService: ChatContextService,
    private readonly queryService: ChatDocumentationQueryService,
    private readonly citationService: ChatDocumentationCitationService,
    private readonly scanService: ChatDocumentationScanService,
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
    const retrievalQuery = this.queryService.buildRetrievalQuery(
      userQuery,
      previousUserQuery,
    );

    try {
      const shouldSkipRetrieval =
        this.queryService.shouldSkipDocumentationRetrieval(userQuery);
      const searchCitationsForQuery = async (
        query: string,
      ): Promise<ChatCitation[]> => {
        const retrievalWindow = this.queryService.getRetrievalWindow(
          query,
          userQuery,
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
          userQuery,
        );
      if (
        assetFallbackQueries.length > 0 &&
        (this.queryService.shouldAugmentGeneratorAssetLookup(
          retrievalQuery,
          userQuery,
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
        this.queryService.isPartsQuery(userQuery) &&
        !this.queryService.hasDetailedPartsEvidence(citations)
      ) {
        const partsFallbackQueries = this.queryService.buildPartsFallbackQueries(
          retrievalQuery,
          userQuery,
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
          userQuery,
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
          userQuery,
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
          userQuery,
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
        userQuery,
        citations,
      );
      citations = this.citationService.focusCitationsForQuery(
        retrievalQuery,
        citations,
      );
      citations = this.citationService.limitCitationsForLlm(
        userQuery,
        citations,
      );
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
