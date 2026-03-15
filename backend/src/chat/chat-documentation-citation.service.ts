import { Injectable } from '@nestjs/common';
import { ChatCitation } from './chat.types';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';

@Injectable()
export class ChatDocumentationCitationService {
  constructor(
    private readonly queryService: ChatDocumentationQueryService,
  ) {}

  pruneCitationsForResolvedSubject(
    retrievalQuery: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length === 0) return citations;

    const subjectTerms =
      this.queryService.extractRetrievalSubjectTerms(retrievalQuery);
    if (subjectTerms.length === 0) return citations;

    const matched = citations.filter((citation) => {
      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      return subjectTerms.some((term) => haystack.includes(term));
    });

    if (matched.length >= 2) return matched;
    if (matched.length === 1 && subjectTerms.length >= 2) return matched;
    return citations;
  }

  refineCitationsForIntent(
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length === 0) return citations;

    let refined = this.rankCitationsBySourceType(userQuery, citations);
    const queryContext =
      retrievalQuery.trim().length > userQuery.trim().length
        ? retrievalQuery
        : userQuery;

    refined = this.refineCitationsForRequestedSource(queryContext, refined);
    refined = this.refineMaintenanceScheduleCitations(queryContext, refined);

    const referenceIds = [
      ...new Set(
        (queryContext.match(/\b1p\d{2,}\b/gi) ?? []).map((value) =>
          value.toLowerCase(),
        ),
      ),
    ];

    if (referenceIds.length > 0) {
      const matchedByReference = refined.filter((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        return referenceIds.some((referenceId) => haystack.includes(referenceId));
      });
      if (matchedByReference.length > 0) {
        refined = this.expandReferenceEvidenceCitations(
          referenceIds,
          matchedByReference,
          citations,
        );
      }
    }

    const numericTokens =
      referenceIds.length > 0
        ? []
        : this.queryService.extractSignificantNumericTokens(queryContext);
    if (numericTokens.length > 0) {
      const matchedByNumericToken = refined.filter((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        return numericTokens.some((token) => haystack.includes(token));
      });
      if (matchedByNumericToken.length > 0) {
        refined = matchedByNumericToken;
      }
    }

    if (this.queryService.isPartsQuery(queryContext)) {
      const matchedParts = refined.filter((citation) =>
        /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|volvo\s+penta|engine\s+oil|zinc|anode|belt|filter|impeller|wear\s*kit|coolant|prefilter)\b/i.test(
          citation.snippet ?? '',
        ),
      );
      if (matchedParts.length > 0) {
        refined = this.expandPartsEvidenceCitations(matchedParts, citations);
      }
    }

    refined = this.refineGeneratorAssetCitations(queryContext, refined);

    if (this.queryService.isNextDueLookupQuery(queryContext)) {
      refined = this.sortCitationsByUpcomingDue(refined);
    }

    return refined;
  }

  mergeCitations(
    base: ChatCitation[],
    additional: ChatCitation[],
  ): ChatCitation[] {
    const merged = [...base];
    const seen = new Set(
      base.map((citation) =>
        [
          citation.chunkId ?? '',
          citation.pageNumber ?? '',
          citation.sourceTitle ?? '',
          citation.snippet ?? '',
        ].join('::'),
      ),
    );

    for (const citation of additional) {
      const key = [
        citation.chunkId ?? '',
        citation.pageNumber ?? '',
        citation.sourceTitle ?? '',
        citation.snippet ?? '',
      ].join('::');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(citation);
    }

    return merged;
  }

  focusCitationsForQuery(query: string, citations: ChatCitation[]): ChatCitation[] {
    if (citations.length === 0) return citations;

    const referenceIds = [
      ...new Set(
        (query.match(/\b1p\d{2,}\b/gi) ?? []).map((match) =>
          match.toLowerCase(),
        ),
      ),
    ];
    if (referenceIds.length !== 1) return citations;

    const [referenceId] = referenceIds;
    const anchorKeys = new Set<string>();
    const anchored = citations
      .filter((citation) =>
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`
          .toLowerCase()
          .includes(referenceId),
      )
      .map((citation) => {
        anchorKeys.add(
          `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`,
        );
        return this.cropCitationAroundAnchor(citation, referenceId, query);
      });

    if (anchored.length === 0) return citations;

    const syntheticAnchors = anchored.filter((citation) =>
      (citation.chunkId ?? '').startsWith('ref-scan:'),
    );
    const primaryAnchors =
      syntheticAnchors.length > 0 ? syntheticAnchors : anchored;

    const anchoredKeys = new Set(
      primaryAnchors.map((citation) => this.getCitationIdentity(citation)),
    );
    const continuation = citations.filter((citation) => {
      const key = `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`;
      if (!anchorKeys.has(key)) return false;
      const identity = this.getCitationIdentity(citation);
      if (anchoredKeys.has(identity)) return false;

      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      const mentionedReferenceIds = [
        ...haystack.matchAll(/\b1p\d{2,}\b/g),
      ].map((match) => match[0].toLowerCase());

      if (
        mentionedReferenceIds.some(
          (mentionedReferenceId) => mentionedReferenceId !== referenceId,
        )
      ) {
        return false;
      }

      return (
        !haystack.includes(referenceId) &&
        /\b(component\s*name|task\s*name|responsible|interval|last\s*due|next\s*due|spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|replace|inspect|check|clean|adjust|overhaul|sample|test|wear\s*kit|filter|impeller|belt|anode|coolant|pump)\b/i.test(
          haystack,
        )
      );
    });

    return [...primaryAnchors, ...continuation];
  }

  limitCitationsForLlm(
    userQuery: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length <= this.queryService.getDefaultContextTopK()) {
      return citations;
    }

    const wantsParts = this.queryService.isPartsQuery(userQuery);
    const wantsProcedure =
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        userQuery,
      );
    const hasReferenceId = /\b1p\d{2,}\b/i.test(userQuery);
    const wantsExhaustiveList =
      /\b(list\s+all|all\s+details|do\s+not\s+omit|how\s+many\s+spare-?part\s+rows)\b/i.test(
        userQuery,
      );
    const limit =
      wantsParts || wantsProcedure || hasReferenceId || wantsExhaustiveList
        ? 16
        : this.queryService.getDefaultContextTopK();

    return citations.slice(0, limit);
  }

  private refineCitationsForRequestedSource(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    const hints = this.extractRequestedSourceHints(query);
    if (hints.length === 0 || citations.length === 0) return citations;

    const scored = citations.map((citation) => ({
      citation,
      score: this.getRequestedSourceMatchScore(citation, hints),
    }));
    const bestScore = Math.max(...scored.map((entry) => entry.score), 0);
    if (bestScore <= 0) return citations;

    const matched = scored
      .filter((entry) => entry.score === bestScore)
      .map((entry) => entry.citation);

    return matched.length > 0 ? matched : citations;
  }

  private extractRequestedSourceHints(query: string): string[] {
    const hints = new Set<string>();

    const sourcePatterns = [
      /\baccording to ([a-z0-9][a-z0-9\s/_().-]{2,})/gi,
      /\bin ([a-z0-9][a-z0-9\s/_().-]{2,})/gi,
      /\bfrom ([a-z0-9][a-z0-9\s/_().-]{2,})/gi,
    ];

    for (const pattern of sourcePatterns) {
      for (const match of query.matchAll(pattern)) {
        const value = this.queryService.normalizeSourceTitleHint(match[1]);
        if (value) {
          hints.add(value.toLowerCase());
        }
      }
    }

    return [...hints];
  }

  private getRequestedSourceMatchScore(
    citation: ChatCitation,
    hints: string[],
  ): number {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();

    let score = 0;
    for (const hint of hints) {
      if (haystack.includes(hint)) {
        score += 3;
        continue;
      }

      const condensedHint = hint.replace(/\s+/g, '');
      if (condensedHint && haystack.replace(/\s+/g, '').includes(condensedHint)) {
        score += 1;
      }
    }

    return score;
  }

  private expandReferenceEvidenceCitations(
    referenceIds: string[],
    matchedByReference: ChatCitation[],
    allCitations: ChatCitation[],
  ): ChatCitation[] {
    if (matchedByReference.length === 0) return matchedByReference;

    const anchorKeys = new Set(
      matchedByReference.map(
        (citation) =>
          `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`,
      ),
    );
    const normalizedReferenceIds = new Set(
      referenceIds.map((referenceId) => referenceId.toLowerCase()),
    );

    const continuationCandidates = allCitations.filter((citation) => {
      const key = `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`;
      if (!anchorKeys.has(key)) return false;

      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      const mentionedReferenceIds = [
        ...haystack.matchAll(/\b1p\d{2,}\b/g),
      ].map((match) => match[0].toLowerCase());
      if (
        mentionedReferenceIds.some(
          (referenceId) => !normalizedReferenceIds.has(referenceId),
        )
      ) {
        return false;
      }

      return /\b(component\s*name|task\s*name|responsible|interval|last\s*due|next\s*due|spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|replace|inspect|check|clean|adjust|overhaul|sample|test|wear\s*kit|filter|impeller|belt|anode|coolant|pump)\b/i.test(
        haystack,
      );
    });

    return this.mergeCitations(matchedByReference, continuationCandidates);
  }

  private sortCitationsByUpcomingDue(citations: ChatCitation[]): ChatCitation[] {
    const withKeys = citations.map((citation) => ({
      citation,
      due: this.extractUpcomingDueSortKey(citation.snippet ?? ''),
    }));

    return withKeys
      .sort((a, b) => {
        const hourA = a.due.nextDueHours;
        const hourB = b.due.nextDueHours;
        if (hourA !== undefined && hourB !== undefined && hourA !== hourB) {
          return hourA - hourB;
        }
        if (hourA !== undefined) return -1;
        if (hourB !== undefined) return 1;

        const dateA = a.due.nextDueDate;
        const dateB = b.due.nextDueDate;
        if (dateA !== undefined && dateB !== undefined && dateA !== dateB) {
          return dateA - dateB;
        }
        if (dateA !== undefined) return -1;
        if (dateB !== undefined) return 1;

        return (b.citation.score ?? 0) - (a.citation.score ?? 0);
      })
      .map((entry) => entry.citation);
  }

  private extractUpcomingDueSortKey(snippet: string): {
    nextDueHours?: number;
    nextDueDate?: number;
  } {
    const normalized = snippet.replace(/\s+/g, ' ');
    const result: { nextDueHours?: number; nextDueDate?: number } = {};

    const dateMatch = normalized.match(
      /\bnext\s*due\b[^0-9]{0,20}(\d{2})[./](\d{2})[./](\d{4})/i,
    );
    if (dateMatch) {
      const [, day, month, year] = dateMatch;
      result.nextDueDate = Date.UTC(
        Number.parseInt(year, 10),
        Number.parseInt(month, 10) - 1,
        Number.parseInt(day, 10),
      );
    }

    const hourMatch = normalized.match(
      /\bnext\s*due\b[\s\S]{0,120}?\/\s*(\d{2,6})\b/i,
    );
    if (hourMatch) {
      result.nextDueHours = Number.parseInt(hourMatch[1], 10);
    }

    if (result.nextDueDate === undefined || result.nextDueHours === undefined) {
      const plainSnippet = this.stripHtmlLikeMarkup(snippet);

      if (result.nextDueDate === undefined) {
        const allDates = [
          ...plainSnippet.matchAll(/\b(\d{2})[./](\d{2})[./](\d{4})\b/g),
        ];
        const lastDate = allDates.at(-1);
        if (lastDate) {
          result.nextDueDate = Date.UTC(
            Number.parseInt(lastDate[3], 10),
            Number.parseInt(lastDate[2], 10) - 1,
            Number.parseInt(lastDate[1], 10),
          );
        }
      }

      if (result.nextDueHours === undefined) {
        const allSlashNumbers = [
          ...plainSnippet.matchAll(/\/\s*(\d{2,6})\b/g),
        ];
        const lastSlashNumber = allSlashNumbers.at(-1);
        if (lastSlashNumber) {
          result.nextDueHours = Number.parseInt(lastSlashNumber[1], 10);
        }
      }
    }

    return result;
  }

  private expandPartsEvidenceCitations(
    matchedParts: ChatCitation[],
    allCitations: ChatCitation[],
  ): ChatCitation[] {
    if (matchedParts.length === 0) return matchedParts;

    const anchorKeys = new Set(
      matchedParts.map(
        (citation) =>
          `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`,
      ),
    );

    const samePagePartCandidates = allCitations.filter((citation) => {
      const key = `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`;
      if (!anchorKeys.has(key)) return false;

      return /\b(manufacturer\s*part#?|supplier\s*part#?|quantity|location|volvo\s+penta|engine\s+oil|zinc|anode|belt|filter|impeller|wear\s*kit|coolant|prefilter)\b/i.test(
        citation.snippet ?? '',
      );
    });

    return this.mergeCitations(matchedParts, samePagePartCandidates);
  }

  private rankCitationsBySourceType(
    userQuery: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length <= 1) return citations;

    const query = userQuery.toLowerCase();
    const wantsParts = this.queryService.isPartsQuery(userQuery);
    const wantsProcedure =
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        query,
      );
    const wantsMaintenanceSchedule =
      this.queryService.isNextDueLookupQuery(userQuery);

    return [...citations].sort((a, b) => {
      const typeA = this.classifyCitationSourceType(a);
      const typeB = this.classifyCitationSourceType(b);
      const weightA = this.getCitationSourceWeight(
        typeA,
        wantsParts,
        wantsProcedure,
        wantsMaintenanceSchedule,
      );
      const weightB = this.getCitationSourceWeight(
        typeB,
        wantsParts,
        wantsProcedure,
        wantsMaintenanceSchedule,
      );

      if (weightA !== weightB) return weightB - weightA;
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }

  private classifyCitationSourceType(citation: {
    snippet?: string;
    sourceTitle?: string;
  }): 'maintenance_schedule' | 'parts_list' | 'manual' | 'handbook' | 'other' {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();

    if (
      /\bmaintenance\s+tasks?\b/i.test(haystack) ||
      (/\b(reference\s*id|next\s+due|last\s+due)\b/i.test(haystack) &&
        /\b(component\s+name|task\s+name)\b/i.test(haystack))
    ) {
      return 'maintenance_schedule';
    }

    if (
      /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location)\b/i.test(
        haystack,
      ) ||
      /\b(parts?\s+list|recommended\s+spare\s+parts|spares?)\b/i.test(haystack)
    ) {
      return 'parts_list';
    }

    if (/\b(handbook|application\s+handbook)\b/i.test(haystack)) {
      return 'handbook';
    }

    if (
      /\b(manual|operator|operators|service\s+and\s+maintenance|use\s+and\s+maintenance)\b/i.test(
        haystack,
      )
    ) {
      return 'manual';
    }

    return 'other';
  }

  private getCitationSourceWeight(
    sourceType:
      | 'maintenance_schedule'
      | 'parts_list'
      | 'manual'
      | 'handbook'
      | 'other',
    wantsParts: boolean,
    wantsProcedure: boolean,
    wantsMaintenanceSchedule: boolean,
  ): number {
    if (wantsParts) {
      switch (sourceType) {
        case 'parts_list':
          return 5;
        case 'maintenance_schedule':
          return 4;
        case 'manual':
          return 2;
        case 'handbook':
          return 1;
        default:
          return 0;
      }
    }

    if (wantsProcedure) {
      switch (sourceType) {
        case 'maintenance_schedule':
          return 5;
        case 'manual':
          return 4;
        case 'parts_list':
          return 2;
        case 'handbook':
          return 2;
        default:
          return 0;
      }
    }

    if (wantsMaintenanceSchedule) {
      switch (sourceType) {
        case 'maintenance_schedule':
          return 5;
        case 'parts_list':
          return 2;
        case 'manual':
          return 1;
        case 'handbook':
          return 1;
        default:
          return 0;
      }
    }

    switch (sourceType) {
      case 'manual':
        return 3;
      case 'maintenance_schedule':
        return 3;
      case 'handbook':
        return 2;
      case 'parts_list':
        return 2;
      default:
        return 0;
    }
  }

  private refineGeneratorAssetCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length === 0) return citations;

    const normalized = query.toLowerCase();
    const directionalSide = this.queryService.detectDirectionalSide(normalized);
    if (!directionalSide || !/\b(generator|genset)\b/i.test(normalized)) {
      return citations;
    }

    let refined = citations.filter((citation) =>
      this.queryService.matchesDirectionalSide(
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
        directionalSide,
      ),
    );
    if (refined.length === 0) {
      refined = citations;
    }

    const oppositeSide = directionalSide === 'port' ? 'starboard' : 'port';
    const withoutOppositeSide = refined.filter(
      (citation) =>
        !this.queryService.matchesDirectionalSide(
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
          oppositeSide,
        ),
    );
    if (withoutOppositeSide.length > 0) {
      refined = withoutOppositeSide;
    }

    return refined;
  }

  private refineMaintenanceScheduleCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (
      !/\b(maintenance|service|due|parts?|spares?|procedure|steps?|what\s+should\s+i\s+do|what\s+needs?\s+to\s+be\s+done|included)\b/i.test(
        query,
      )
    ) {
      return citations;
    }

    const scheduleMatched = citations.filter((citation) =>
      /maintenance\s+tasks/i.test(citation.sourceTitle ?? ''),
    );

    return scheduleMatched.length > 0 ? scheduleMatched : citations;
  }

  private cropCitationAroundAnchor(
    citation: ChatCitation,
    anchor: string,
    query: string,
  ): ChatCitation {
    const snippet = citation.snippet ?? '';
    if (!snippet) return citation;

    const lowerSnippet = snippet.toLowerCase();
    const anchorIndex = lowerSnippet.indexOf(anchor.toLowerCase());
    if (anchorIndex < 0) return citation;

    const isExhaustive =
      /\b(list\s+all|all\s+details|do\s+not\s+omit|how\s+many\s+spare-?part\s+rows)\b/i.test(
        query,
      );
    const wantsProcedure =
      /\b(tasks?|included|include|procedure|steps?|checklist|replace|inspect|clean|check|adjust|overhaul|sample|test)\b/i.test(
        query,
      );
    const wantsParts = this.queryService.isPartsQuery(query);

    const charsBefore = 240;
    const charsAfter = isExhaustive
      ? 3600
      : wantsParts || wantsProcedure
        ? 3000
        : 2200;
    const start = Math.max(0, anchorIndex - charsBefore);
    let end = Math.min(
      snippet.length,
      anchorIndex + anchor.length + charsAfter,
    );

    const trailingSlice = snippet.slice(anchorIndex + anchor.length, end);
    const nextForeignReference = [
      ...trailingSlice.matchAll(/\b1p\d{2,}\b/gi),
    ].find((match) => match[0].toLowerCase() !== anchor.toLowerCase());
    if (nextForeignReference && typeof nextForeignReference.index === 'number') {
      end = Math.min(
        end,
        anchorIndex + anchor.length + nextForeignReference.index,
      );
    }

    let focusedSnippet = snippet.slice(start, end).trim();

    if (start > 0) {
      focusedSnippet = `...${focusedSnippet}`;
    }
    if (end < snippet.length) {
      focusedSnippet = `${focusedSnippet}...`;
    }

    return {
      ...citation,
      snippet: focusedSnippet,
    };
  }

  private getCitationIdentity(citation: ChatCitation): string {
    return [
      citation.chunkId ?? '',
      citation.pageNumber ?? '',
      citation.sourceTitle ?? '',
      citation.snippet ?? '',
    ].join('::');
  }

  private stripHtmlLikeMarkup(snippet: string): string {
    return snippet
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
