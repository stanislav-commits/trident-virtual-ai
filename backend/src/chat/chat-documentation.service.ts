import { Injectable, Logger } from '@nestjs/common';
import { ChatContextService } from './chat-context.service';
import {
  ChatCitation,
  ChatDocumentationContext,
  ChatHistoryMessage,
  ChatNormalizedQuery,
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

      if (
        this.shouldAugmentBroadCertificateExpiryLookup(
          effectiveUserQuery,
          citations,
        )
      ) {
        for (const fallbackQuery of this.buildCertificateExpiryFallbackQueries(
          retrievalQuery,
          effectiveUserQuery,
        )) {
          if (!fallbackQuery || fallbackQuery === retrievalQuery) {
            continue;
          }

          const fallbackCitations = await searchCitationsForQuery(fallbackQuery);
          citations = this.citationService.mergeCitations(
            citations,
            fallbackCitations,
          );
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

      const certificateDocumentFallbackCitations =
        await this.scanService.expandCertificateExpiryDocumentChunkCitations(
          shipId,
          retrievalQuery,
          effectiveUserQuery,
          citations,
        );
      citations = this.citationService.mergeCitations(
        citations,
        certificateDocumentFallbackCitations,
      );
      if (this.isBroadCertificateSoonQuery(effectiveUserQuery)) {
        analysisCitations = [...citations];
      }

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
      const finalAnalysisCitations = analysisCitations ?? citations;
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
        normalizedQuery,
        answerQuery:
          isClarificationReply || shouldPromoteRetrievalQueryToAnswerQuery
            ? retrievalQuery
            : undefined,
        resolvedSubjectQuery,
        citations,
        analysisCitations: finalAnalysisCitations,
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
      this.extractExplicitCertificateExpiryTimestamps(citation.snippet ?? '').some(
        (expiry) => expiry >= Date.now(),
      ),
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
      /\bcertificates?\b/i.test(query) &&
      /\b(expire|expiry|expiries|expiring|valid\s+until|due\s+to\s+expire)\b/i.test(
        query,
      ) &&
      /\b(soon|upcoming|next|nearest)\b/i.test(query)
    );
  }

  private extractExplicitCertificateExpiryTimestamp(text: string): number | null {
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
