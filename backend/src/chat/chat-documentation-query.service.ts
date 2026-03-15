import { Injectable } from '@nestjs/common';
import { ChatCitation, ChatHistoryMessage } from './chat.types';

const DEFAULT_RAGFLOW_CONTEXT_TOP_K = (() => {
  const parsed = Number.parseInt(process.env.RAGFLOW_CONTEXT_TOP_K ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
})();

@Injectable()
export class ChatDocumentationQueryService {
  getDefaultContextTopK(): number {
    return DEFAULT_RAGFLOW_CONTEXT_TOP_K;
  }

  buildRagFallbackQuery(userQuery: string): string {
    const trimmed = userQuery.trim();
    const referenceMatch = trimmed.match(/\b1p\d{2,}\b/i);
    if (referenceMatch) {
      return `Reference ID ${referenceMatch[0].toUpperCase()}`;
    }

    const cleaned = trimmed.replace(/\s+/g, ' ');
    const subjectTerms = this.extractRetrievalSubjectTerms(cleaned)
      .filter((term) => !/^(what|when|where|which|give|show|tell)$/i.test(term))
      .slice(0, 8);

    if (subjectTerms.length > 0) {
      return subjectTerms.join(' ');
    }

    return cleaned;
  }

  shouldSkipDocumentationRetrieval(userQuery: string): boolean {
    return /^\s*(hi|hello|hey|thanks|thank you|ok|okay|great)\s*[!.?]*\s*$/i.test(
      userQuery,
    );
  }

  getPreviousResolvedUserQuery(messages?: ChatHistoryMessage[]): string | null {
    if (!messages?.length) return null;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;

      const ragflowContext =
        message.ragflowContext && typeof message.ragflowContext === 'object'
          ? (message.ragflowContext as Record<string, unknown>)
          : null;
      const resolvedSubjectQuery = ragflowContext?.resolvedSubjectQuery;
      if (
        typeof resolvedSubjectQuery === 'string' &&
        resolvedSubjectQuery.trim()
      ) {
        return resolvedSubjectQuery.trim();
      }

      const content = message.content?.trim();
      if (content) return content;
    }

    return null;
  }

  buildRetrievalQuery(
    userQuery: string,
    previousUserQuery: string | null,
  ): string {
    const trimmed = userQuery.trim();
    if (!trimmed) return trimmed;

    if (
      !previousUserQuery ||
      !this.isContextualFollowUpQuery(trimmed) ||
      this.isSelfContainedSubjectQuery(trimmed)
    ) {
      return trimmed;
    }

    const followUpSubject = this.extractFollowUpSubject(previousUserQuery);
    if (!followUpSubject) return trimmed;

    return `${followUpSubject} ${trimmed}`.trim();
  }

  extractRetrievalSubjectTerms(query: string): string[] {
    const stopWords = new Set([
      'what',
      'when',
      'where',
      'why',
      'how',
      'about',
      'next',
      'maintenance',
      'service',
      'due',
      'hours',
      'hour',
      'running',
      'current',
      'status',
      'please',
      'provide',
      'show',
      'list',
      'task',
      'tasks',
      'details',
      'parts',
      'part',
      'procedure',
      'steps',
      'include',
      'included',
      'does',
      'that',
      'this',
      'it',
      'the',
      'for',
      'all',
      'is',
      'are',
      'should',
      'use',
      'need',
      'needs',
      'done',
      'doing',
      'with',
      'from',
      'into',
      'your',
      'you',
      'want',
    ]);

    return [
      ...new Set(
        query
          .toLowerCase()
          .replace(/[^a-z0-9\s/-]/g, ' ')
          .split(/\s+/)
          .map((term) => term.trim())
          .filter((term) => term.length >= 3 || term === 'ps' || term === 'sb')
          .filter((term) => !stopWords.has(term))
          .filter((term) => !/^\d+$/.test(term)),
      ),
    ];
  }

  isPartsQuery(query: string): boolean {
    return /\b(parts?|spares?|part\s*numbers?|consumables?|filters?|oil|coolant)\b/i.test(
      query,
    );
  }

  hasDetailedPartsEvidence(citations: ChatCitation[]): boolean {
    return citations.some(
      (citation) =>
        /\b(manufacturer\s*part#?|supplier\s*part#?)\b/i.test(
          citation.snippet ?? '',
        ) &&
        /\b(volvo\s+penta|engine\s+oil|zinc|anode|belt|filter|impeller|wear\s+kit|coolant|prefilter|air\s+filter|oil\s+filter|fuel\s+filter)\b/i.test(
          citation.snippet ?? '',
        ),
    );
  }

  buildPartsFallbackQueries(
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
  ): string[] {
    const queries = [
      this.buildPartsRowFallbackQuery(citations),
      this.buildGeneratorAssetFallbackQuery(retrievalQuery, userQuery),
      this.buildRagFallbackQuery(retrievalQuery),
    ].filter((query): query is string => Boolean(query?.trim()));

    return [...new Set(queries)];
  }

  needsGeneratorAssetFallback(
    retrievalQuery: string,
    citations: ChatCitation[],
  ): boolean {
    if (citations.length === 0) return true;

    const normalized = retrievalQuery.toLowerCase();
    const directionalSide = this.detectDirectionalSide(normalized);
    if (!directionalSide || !/\b(generator|genset)\b/i.test(normalized)) {
      return false;
    }

    const matchedBySide = citations.filter((citation) =>
      this.matchesDirectionalSide(
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
        directionalSide,
      ),
    );

    if (matchedBySide.length === 0) return true;

    if (this.isNextDueLookupQuery(retrievalQuery)) {
      return !matchedBySide.some((citation) =>
        /\b(next\s*due|last\s*due|interval|reference\s*id|task\s*name|component\s*name)\b/i.test(
          citation.snippet ?? '',
        ),
      );
    }

    return false;
  }

  needsReferenceIdFallback(
    retrievalQuery: string,
    citations: ChatCitation[],
  ): boolean {
    const referenceIds = [
      ...new Set(
        (retrievalQuery.match(/\b1p\d{2,}\b/gi) ?? []).map((value) =>
          value.toLowerCase(),
        ),
      ),
    ];
    if (referenceIds.length !== 1) return false;

    const [referenceId] = referenceIds;
    const matching = citations.filter((citation) =>
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`
        .toLowerCase()
        .includes(referenceId),
    );

    return matching.length === 0;
  }

  buildReferenceIdFallbackQueries(query: string): string[] {
    const referenceIds = [
      ...new Set(
        (query.match(/\b1p\d{2,}\b/gi) ?? []).map((value) => value.toUpperCase()),
      ),
    ];
    if (referenceIds.length === 0) return [];

    const queries = new Set<string>();
    for (const referenceId of referenceIds) {
      queries.add(`Reference ID ${referenceId}`);
      queries.add(referenceId);
    }

    return [...queries];
  }

  buildReferenceContinuationFallbackQueries(
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
  ): string[] {
    const referenceIds = [
      ...new Set(
        (retrievalQuery.match(/\b1p\d{2,}\b/gi) ?? []).map((match) =>
          match.toUpperCase(),
        ),
      ),
    ];
    if (referenceIds.length !== 1) return [];

    const wantsProcedure =
      /\b(tasks?|included|include|procedure|steps?|checklist|replace|inspect|clean|check|adjust|overhaul|sample|test)\b/i.test(
        userQuery,
      );
    const wantsParts = this.isPartsQuery(userQuery);
    const wantsNextDue = this.isNextDueLookupQuery(userQuery);

    const hintedSources = new Set(
      citations
        .map((citation) => this.normalizeSourceTitleHint(citation.sourceTitle))
        .filter((value): value is string => Boolean(value)),
    );

    const queries = new Set<string>();
    for (const referenceId of referenceIds) {
      const referenceLookup = `Reference ID ${referenceId}`;
      queries.add(referenceLookup);

      for (const sourceHint of hintedSources) {
        const base = `${sourceHint} Reference ID ${referenceId}`;
        queries.add(base);
        queries.add(
          `${base}. Focus on the exact matching row and any continuation rows on the same page, including task list, included work items, spare parts, manufacturer part number, supplier part number, interval, last due, and next due.`,
        );

        if (wantsProcedure) {
          queries.add(
            `${base}. Focus on included work items, task list, checklist items, replace or inspect steps, and continuation lines below the same reference row.`,
          );
        }

        if (wantsParts) {
          queries.add(
            `${base}. Focus on spare name, quantity, location, manufacturer part number, supplier part number, and continuation lines below the same reference row.`,
          );
        }

        if (wantsNextDue) {
          queries.add(
            `${base}. Focus on the exact task name, interval, last due, and next due for the same reference row.`,
          );
        }
      }
    }

    return [...queries].filter((query) => query !== retrievalQuery);
  }

  normalizeSourceTitleHint(sourceTitle?: string): string | null {
    if (!sourceTitle) return null;

    const normalized = sourceTitle
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return normalized || null;
  }

  buildGeneratorAssetFallbackQuery(
    retrievalQuery: string,
    userQuery: string,
  ): string | null {
    const normalized = retrievalQuery.trim().replace(/\s+/g, ' ');
    if (!normalized) return null;

    const lower = normalized.toLowerCase();
    const directionalSide = this.detectDirectionalSide(lower);
    let assetFocus: string | null = null;

    if (/\b(generator|genset)\b/i.test(lower) && directionalSide === 'port') {
      assetFocus = 'port side generator genset PS';
    } else if (
      /\b(generator|genset)\b/i.test(lower) &&
      directionalSide === 'starboard'
    ) {
      assetFocus = 'starboard side generator genset SB STBD';
    }

    if (!assetFocus) return null;

    if (this.isPartsQuery(userQuery)) {
      return `${assetFocus}. Focus on spare name, quantity, location, manufacturer part number and supplier part number for the maintenance schedule row.`;
    }

    if (this.isNextDueLookupQuery(userQuery)) {
      return `${assetFocus}. Focus on task name, reference ID, interval, last due and next due in the maintenance schedule.`;
    }

    if (
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        userQuery,
      )
    ) {
      return `${assetFocus}. Focus on the documented maintenance schedule task list and included work items.`;
    }

    if (
      /(telemetry|status|current|running\s+hours|hour\s*meter|hours\s*run|runtime)/i.test(
        userQuery,
      )
    ) {
      return `${assetFocus}. Focus on running hours, runtime, hour meter and current status values.`;
    }

    return `${assetFocus}. Focus on maintenance schedule rows for this generator asset.`;
  }

  buildGeneratorAssetFallbackQueries(
    retrievalQuery: string,
    userQuery: string,
  ): string[] {
    const primary = this.buildGeneratorAssetFallbackQuery(
      retrievalQuery,
      userQuery,
    );
    if (!primary) return [];

    const queries = new Set<string>([primary]);
    const normalized = retrievalQuery.trim().replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    const directionalSide = this.detectDirectionalSide(lower);
    if (!directionalSide || !/\b(generator|genset)\b/i.test(lower)) {
      return [...queries];
    }

    const assetFocus =
      directionalSide === 'port'
        ? 'port side generator genset PS'
        : 'starboard side generator genset SB STBD';

    if (this.isNextDueLookupQuery(userQuery)) {
      queries.add(
        `${assetFocus}. Focus on the earliest upcoming maintenance schedule row for this asset, including task name, reference ID, last due, and next due.`,
      );
      queries.add(
        `${assetFocus} earliest upcoming next due maintenance schedule`,
      );
      queries.add(
        `${assetFocus}. Focus on rows with next due values and select the nearest upcoming service for this asset.`,
      );
      queries.add(
        `${directionalSide === 'port' ? 'PS ENGINE' : 'SB ENGINE'} main generator maintenance schedule`,
      );
      queries.add(
        `0212 ENGINES ${directionalSide === 'port' ? 'PS ENGINE' : 'SB ENGINE'} MAIN GENERATOR`,
      );
    }

    return [...queries];
  }

  detectDirectionalSide(query: string): 'port' | 'starboard' | null {
    if (/\b(port(?:\s+side)?|portside|ps)\b/i.test(query)) {
      return 'port';
    }

    if (/\b(starboard(?:\s+side)?|starboardside|sb|stbd)\b/i.test(query)) {
      return 'starboard';
    }

    return null;
  }

  matchesDirectionalSide(
    text: string,
    side: 'port' | 'starboard',
  ): boolean {
    if (side === 'port') {
      return /\b(port(?:\s+side)?|portside|ps)\b/i.test(text);
    }

    return /\b(starboard(?:\s+side)?|starboardside|sb|stbd)\b/i.test(text);
  }

  shouldAugmentGeneratorAssetLookup(
    retrievalQuery: string,
    userQuery: string,
  ): boolean {
    const normalized = retrievalQuery.toLowerCase();
    if (!/\b(generator|genset)\b/i.test(normalized)) {
      return false;
    }

    if (!this.detectDirectionalSide(normalized)) {
      return false;
    }

    return this.isNextDueLookupQuery(userQuery);
  }

  getRetrievalWindow(
    retrievalQuery: string,
    userQuery: string,
  ): { topK: number; candidateK: number } {
    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    const isExactReference = /\b1p\d{2,}\b/i.test(queryContext);
    const wantsNextDue = this.isNextDueLookupQuery(userQuery);
    const wantsExhaustiveList =
      /\b(list\s+all|all\s+details|do\s+not\s+omit|how\s+many\s+spare-?part\s+rows)\b/i.test(
        userQuery,
      );
    const wantsParts = this.isPartsQuery(userQuery);
    const wantsProcedure =
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        userQuery,
      );

    if (isExactReference) {
      return { topK: 72, candidateK: 216 };
    }

    if (wantsExhaustiveList) {
      return { topK: 48, candidateK: 144 };
    }

    if (wantsParts || wantsProcedure || wantsNextDue) {
      return { topK: 24, candidateK: 72 };
    }

    return {
      topK: DEFAULT_RAGFLOW_CONTEXT_TOP_K,
      candidateK: Math.max(DEFAULT_RAGFLOW_CONTEXT_TOP_K * 3, 24),
    };
  }

  isNextDueLookupQuery(query: string): boolean {
    return /\b(next\s+due|what\s+is\s+next\s+due|next\s+due\s+value|when\s+is\s+.*(?:maintenance|service).*\sdue|what\s+is\s+the\s+next\s+(maintenance|service)|what\s+(maintenance|service)\s+is\s+next)\b/i.test(
      query,
    );
  }

  extractSignificantNumericTokens(query: string): string[] {
    const tokens = new Set<string>();

    for (const match of query.matchAll(/\b(\d{2,6})\s*(hrs?|hours?)\b/gi)) {
      tokens.add(match[1]);
    }

    for (const match of query.matchAll(/\b1p\d{2,}\b/gi)) {
      tokens.add(match[0].toLowerCase());
    }

    return [...tokens];
  }

  private isContextualFollowUpQuery(query: string): boolean {
    return /\b(it|that|this|they|them|those|these|same|next one|this one)\b/i.test(
      query,
    );
  }

  private extractFollowUpSubject(previousUserQuery: string): string | null {
    const subjectTerms = this.extractRetrievalSubjectTerms(previousUserQuery);
    if (subjectTerms.length === 0) return null;
    return subjectTerms.join(' ');
  }

  private isSelfContainedSubjectQuery(query: string): boolean {
    if (/\b1p\d{2,}\b/i.test(query)) return true;
    return /\b(generator|genset|engine|pump|compressor|watermaker|manual|filter|service|maintenance|alarm|fault|error|telemetry)\b/i.test(
      query,
    );
  }

  private buildPartsRowFallbackQuery(citations: ChatCitation[]): string | null {
    if (citations.length === 0) return null;

    const combinedText = citations
      .map(
        (citation) => `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
      )
      .join('\n');
    const referenceId = combinedText.match(/\b1p\d{2,}\b/i)?.[0]?.toUpperCase();
    if (!referenceId) return null;

    return `${referenceId} spare name quantity location manufacturer part supplier part`;
  }
}
