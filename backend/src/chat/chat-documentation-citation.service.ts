import { Injectable, Optional } from '@nestjs/common';
import { ChatCitation } from './chat.types';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import {
  ChatQueryPlan,
  ChatQueryPlannerService,
  ChatSourceCategory,
} from './chat-query-planner.service';

interface SourceEvidenceProfile {
  sourceKey: string;
  sourceTitle: string;
  manualIds: string[];
  citations: ChatCitation[];
  combinedText: string;
  subjectCoverage: number;
  aggregateScore: number;
  explicitEvidenceScore: number;
  contactEvidenceScore: number;
  intervalValues: string[];
  nextDueValues: string[];
  nextDueDates: string[];
  lastDueValues: string[];
  oilSpecs: string[];
  partNumbers: string[];
  quantityValues: string[];
  capacityValues: string[];
  expiryTimestamps: number[];
  emailValues: string[];
  phoneValues: string[];
}

const SPECIFICATION_QUERY_PATTERN =
  /\b(?:technical\s*data|technical\s*specifications?|specifications?|specs?|data\s*sheet|spec\s*sheet|operating\s+data|process\s+data|parameters?)\b/i;

const SPECIFICATION_SECTION_HEADING_PATTERN =
  /^\s*(?:\d+(?:\.\d+)*\s*)?(?:technical\s*data|technical\s*specifications?|specifications?|data\s*sheet|spec\s*sheet|operating\s+data|process\s+data|parameters?)(?:\b|\d)/i;

const MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN = /\b1[a-z]\d{2,}\b/gi;

@Injectable()
export class ChatDocumentationCitationService {
  private readonly queryPlanner: ChatQueryPlannerService;

  constructor(
    private readonly queryService: ChatDocumentationQueryService,
    @Optional() queryPlanner?: ChatQueryPlannerService,
  ) {
    this.queryPlanner = queryPlanner ?? new ChatQueryPlannerService();
  }

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

    const queryPlan = this.queryPlanner.planQuery(userQuery, retrievalQuery);
    let refined = this.rankCitationsBySourceType(
      userQuery,
      citations,
      queryPlan,
    );
    const queryContext =
      retrievalQuery.trim().length > userQuery.trim().length
        ? retrievalQuery
        : userQuery;

    refined = this.refineCitationsForRequestedSource(queryContext, refined);
    refined = this.refineMaintenanceScheduleCitations(queryContext, refined);
    refined = this.refineManualIntervalMaintenanceCitations(
      queryContext,
      refined,
    );
    refined = this.refineRoleDescriptionCitations(queryContext, refined);

    const referenceIds = [
      ...new Set(
        (queryContext.match(MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN) ?? []).map(
          (value) => value.toLowerCase(),
        ),
      ),
    ];

    if (referenceIds.length > 0) {
      const matchedByReference = refined.filter((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        return referenceIds.some((referenceId) =>
          haystack.includes(referenceId),
        );
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

    refined = this.refineContactSubjectCitations(queryContext, refined);

    if (this.queryService.isPartsQuery(queryContext)) {
      refined = this.refinePartsSubjectCitations(queryContext, refined);
      const matchedParts = refined.filter((citation) =>
        /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|volvo\s+penta|engine\s+oil|zinc|anode|belt|filter|impeller|wear\s*kit|coolant|prefilter)\b/i.test(
          citation.snippet ?? '',
        ),
      );
      if (matchedParts.length > 0) {
        refined = this.expandPartsEvidenceCitations(
          queryContext,
          matchedParts,
          citations,
        );
      }
    }

    refined = this.refineGeneratorAssetCitations(queryContext, refined);
    refined = this.refineCertificateSubjectCitations(
      queryContext,
      refined,
      queryPlan,
    );
    refined = this.refineTroubleshootingCitations(
      queryContext,
      refined,
      queryPlan,
    );

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

  prepareCitationsForAnswer(
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    options?: {
      shortlistedManualIds?: string[];
    },
  ): {
    citations: ChatCitation[];
    compareBySource: boolean;
    sourceComparisonTitles: string[];
    mergeBySource: boolean;
    sourceMergeTitles: string[];
  } {
    if (citations.length === 0) {
      return {
        citations,
        compareBySource: false,
        sourceComparisonTitles: [],
        mergeBySource: false,
        sourceMergeTitles: [],
      };
    }

    const answerCitations = this.prioritizeSpecificationCitations(
      `${retrievalQuery}\n${userQuery}`,
      citations,
    );

    const profiles = this.buildSourceEvidenceProfiles(
      retrievalQuery,
      answerCitations,
    );
    if (profiles.length < 2) {
      return {
        citations: answerCitations,
        compareBySource: false,
        sourceComparisonTitles: [],
        mergeBySource: false,
        sourceMergeTitles: [],
      };
    }

    const broadCertificateSoonCitations =
      this.prepareBroadCertificateSoonAnswerCitations(
        userQuery,
        answerCitations,
        profiles,
      );
    if (broadCertificateSoonCitations.length > 0) {
      return {
        citations: broadCertificateSoonCitations,
        compareBySource: false,
        sourceComparisonTitles: [],
        mergeBySource: false,
        sourceMergeTitles: [],
      };
    }

    const comparisonProfiles = this.findMateriallyDifferentSourceProfiles(
      retrievalQuery,
      userQuery,
      profiles,
    );
    if (comparisonProfiles.length >= 2) {
      const selectedComparisonProfiles = comparisonProfiles.slice(0, 2);
      const sourceKeys = new Set(
        selectedComparisonProfiles.map((profile) => profile.sourceKey),
      );
      return {
        citations: this.balanceCitationsAcrossSources(
          answerCitations,
          sourceKeys,
          4,
        ),
        compareBySource: true,
        sourceComparisonTitles: selectedComparisonProfiles.map(
          (profile) => profile.sourceTitle,
        ),
        mergeBySource: false,
        sourceMergeTitles: [],
      };
    }

    const shortlistedAnswerProfiles =
      this.selectShortlistedAnswerSourceProfiles(
        retrievalQuery,
        userQuery,
        profiles,
        options?.shortlistedManualIds,
      );
    if (shortlistedAnswerProfiles.length > 1) {
      const sourceKeys = new Set(
        shortlistedAnswerProfiles.map((profile) => profile.sourceKey),
      );
      return {
        citations: this.balanceCitationsAcrossSources(
          answerCitations,
          sourceKeys,
          4,
        ),
        compareBySource: false,
        sourceComparisonTitles: [],
        mergeBySource: true,
        sourceMergeTitles: shortlistedAnswerProfiles.map(
          (profile) => profile.sourceTitle,
        ),
      };
    }

    const preferredSourceKeys = this.selectPreferredSourceKeys(
      retrievalQuery,
      userQuery,
      profiles,
    );
    if (preferredSourceKeys.length > 0) {
      return {
        citations: this.filterCitationsBySourceKeys(
          answerCitations,
          new Set(preferredSourceKeys),
        ),
        compareBySource: false,
        sourceComparisonTitles: [],
        mergeBySource: false,
        sourceMergeTitles: [],
      };
    }

    const selectedAnswerProfiles = this.selectTopAnswerSourceProfiles(
      retrievalQuery,
      userQuery,
      profiles,
    );
    if (selectedAnswerProfiles.length > 0) {
      const sourceKeys = new Set(
        selectedAnswerProfiles.map((profile) => profile.sourceKey),
      );
      return {
        citations: this.balanceCitationsAcrossSources(
          answerCitations,
          sourceKeys,
          4,
        ),
        compareBySource: false,
        sourceComparisonTitles: [],
        mergeBySource: selectedAnswerProfiles.length > 1,
        sourceMergeTitles:
          selectedAnswerProfiles.length > 1
            ? selectedAnswerProfiles.map((profile) => profile.sourceTitle)
            : [],
      };
    }

    return {
      citations: answerCitations,
      compareBySource: false,
      sourceComparisonTitles: [],
      mergeBySource: false,
      sourceMergeTitles: [],
    };
  }

  focusCitationsForQuery(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length === 0) return citations;

    const referenceIds = [
      ...new Set(
        (query.match(MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN) ?? []).map(
          (match) => match.toLowerCase(),
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
      const mentionedReferenceIds =
        this.extractMaintenanceReferenceIds(haystack);

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

  private refineContactSubjectCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (
      citations.length === 0 ||
      !this.queryService.isPersonnelDirectoryQuery(query)
    ) {
      return citations;
    }

    const scored = citations
      .map((citation) => ({
        citation,
        score: this.scoreContactCitation(query, citation),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.citation.score ?? 0) - (left.citation.score ?? 0),
      );

    const scoredPool =
      this.queryService.isContactLookupQuery(query) &&
      scored.some((entry) => this.hasDirectContactEvidence(entry.citation))
        ? scored.filter((entry) => this.hasDirectContactEvidence(entry.citation))
        : scored;

    const bestScore = scoredPool[0]?.score ?? 0;
    if (bestScore <= 0) {
      return citations;
    }

    const cutoff =
      bestScore >= 20
        ? Math.max(12, bestScore - 8)
        : Math.max(8, Math.ceil(bestScore * 0.7));
    const matched = scoredPool
      .filter((entry) => entry.score >= cutoff)
      .map((entry) => entry.citation);

    return matched.length > 0 ? matched : citations;
  }

  private hasDirectContactEvidence(citation: ChatCitation): boolean {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();

    return (
      /\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/i.test(haystack) ||
      /\+\s*\d[\d\s()./-]{5,}\d\b/.test(haystack)
    );
  }

  private refineRoleDescriptionCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length === 0 || !this.isRoleDescriptionCitationQuery(query)) {
      return citations;
    }

    const roleAnchorPatterns = this.buildRoleDescriptionAnchorPatterns(query);
    if (roleAnchorPatterns.length === 0) {
      return citations;
    }

    const matched = citations.filter((citation) => {
      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      return roleAnchorPatterns.some((pattern) => pattern.test(haystack));
    });

    if (matched.length > 0) {
      return matched;
    }

    return /\b(?:dpa|cso)\b/i.test(query) ? [] : citations;
  }

  private isRoleDescriptionCitationQuery(query: string): boolean {
    return (
      this.queryService.isRoleDescriptionQuery(query) ||
      /\b(?:dpa|cso|manager|director|officer|engineer|captain|master|founder|president|head)\b[\s\S]{0,100}\bresponsibilit(?:y|ies)\b/i.test(
        query,
      )
    );
  }

  private buildRoleDescriptionAnchorPatterns(query: string): RegExp[] {
    const patterns: RegExp[] = [];
    const anchorTerms = this.queryService.extractContactAnchorTerms(query);

    if (/\bdpa\b/i.test(query) || anchorTerms.includes('dpa')) {
      patterns.push(/\bdpa\b/i, /\bdesignated\s+person\s+ashore\b/i);
    }

    if (/\bcso\b/i.test(query) || anchorTerms.includes('cso')) {
      patterns.push(/\bcso\b/i, /\bcompany\s+security\s+officer\b/i);
    }

    const roleTerms = new Set([
      'manager',
      'director',
      'officer',
      'engineer',
      'captain',
      'master',
      'founder',
      'president',
      'head',
    ]);
    for (const term of anchorTerms) {
      if (['dpa', 'cso'].includes(term)) {
        continue;
      }
      if (!roleTerms.has(term)) {
        continue;
      }
      patterns.push(new RegExp(`\\b${this.escapeRegExp(term)}\\b`, 'i'));
    }

    return patterns;
  }

  private prioritizeSpecificationCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length <= 1 || !SPECIFICATION_QUERY_PATTERN.test(query)) {
      return citations;
    }

    const scored = citations.map((citation, index) => {
      const plainSnippet = this.stripHtmlLikeMarkup(citation.snippet ?? '');
      const headingEvidence = SPECIFICATION_SECTION_HEADING_PATTERN.test(
        plainSnippet.trim(),
      )
        ? 1
        : 0;
      const earlySectionEvidence =
        headingEvidence === 0 &&
        SPECIFICATION_QUERY_PATTERN.test(plainSnippet.slice(0, 180))
          ? 1
          : 0;

      return {
        citation,
        index,
        headingEvidence,
        score:
          headingEvidence * 100 +
          earlySectionEvidence * 20 +
          (citation.score ?? 0),
      };
    });

    if (!scored.some((entry) => entry.headingEvidence > 0)) {
      return citations;
    }

    return scored
      .sort((left, right) => {
        if (right.headingEvidence !== left.headingEvidence) {
          return right.headingEvidence - left.headingEvidence;
        }
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.index - right.index;
      })
      .map((entry) => entry.citation);
  }

  limitCitationsForLlm(
    userQuery: string,
    citations: ChatCitation[],
    compareBySource: boolean = false,
  ): ChatCitation[] {
    if (citations.length <= this.queryService.getDefaultContextTopK()) {
      return citations;
    }

    const wantsParts = this.queryService.isPartsQuery(userQuery);
    const wantsProcedure =
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        userQuery,
      );
    const wantsContactDetails =
      this.queryService.isPersonnelDirectoryQuery(userQuery);
    const hasReferenceId = /\b1p\d{2,}\b/i.test(userQuery);
    const wantsExhaustiveList =
      /\b(list\s+all|all\s+details|do\s+not\s+omit|how\s+many\s+spare-?part\s+rows)\b/i.test(
        userQuery,
      );
    const limit =
      wantsParts ||
      wantsProcedure ||
      wantsContactDetails ||
      hasReferenceId ||
      wantsExhaustiveList
        ? 16
        : this.queryService.getDefaultContextTopK();

    if (compareBySource) {
      return this.balanceCitationsAcrossSources(
        citations,
        new Set(citations.map((citation) => this.getSourceKey(citation))),
        4,
      ).slice(0, Math.max(limit, 12));
    }

    return citations.slice(0, limit);
  }

  private scoreContactCitation(query: string, citation: ChatCitation): number {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
    const anchorTerms = this.queryService.extractContactAnchorTerms(query);
    const matchedAnchors = anchorTerms.filter((term) =>
      haystack.includes(term),
    );
    const hasEmail =
      /\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/i.test(haystack) ||
      /\b(email|e-mail)\b/i.test(haystack);
    const hasPhone =
      /\+\s*\d[\d\s()./-]{5,}\d\b/.test(haystack) ||
      /\b(phone|telephone|mobile|tel[:.]?)\b/i.test(haystack);
    const hasContactTitle =
      /\b(contact\s+details|contact\s+list|company\s+contact|emergency\s+contact|emergencycontactlist)\b/i.test(
        haystack,
      );
    const hasDpa = /\bdpa\b/i.test(haystack);
    const weakGenericContactOnly =
      /\bcontact\s+details?\b|\bcontacts?\b/i.test(haystack) &&
      !hasEmail &&
      !hasPhone;

    let score = 0;
    score += matchedAnchors.length * 12;

    if (/\bdpa\b/i.test(query) && hasDpa) {
      score += 12;
    }
    if (hasContactTitle) {
      score += 10;
    }
    if (hasEmail) {
      score += 8;
    }
    if (hasPhone) {
      score += 8;
    }
    if (hasEmail && hasPhone) {
      score += 4;
    }
    if (
      /\b(founder|director|manager|compliance|operations|technical|captain|master|cso)\b/i.test(
        haystack,
      )
    ) {
      score += 2;
    }
    if (weakGenericContactOnly) {
      score -= 6;
    }

    return score;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        if (!value) {
          continue;
        }
        this.expandRequestedSourceHints(value).forEach((hint) =>
          hints.add(hint),
        );
      }
    }

    return [...hints];
  }

  private getRequestedSourceMatchScore(
    citation: ChatCitation,
    hints: string[],
  ): number {
    const normalizedTitle =
      this.queryService
        .normalizeSourceTitleHint(citation.sourceTitle)
        ?.toLowerCase() ?? '';
    const normalizedSnippet = `${citation.snippet ?? ''}`.toLowerCase();

    let score = 0;
    for (const hint of hints) {
      if (normalizedTitle.includes(hint)) {
        score += 12;
        continue;
      }

      const condensedHint = hint.replace(/\s+/g, '');
      const condensedTitle = normalizedTitle.replace(/\s+/g, '');
      if (condensedHint && condensedTitle.includes(condensedHint)) {
        score += 8;
        continue;
      }

      if (normalizedSnippet.includes(hint)) {
        score += 1;
        continue;
      }

      const condensedSnippet = normalizedSnippet.replace(/\s+/g, '');
      if (condensedHint && condensedSnippet.includes(condensedHint)) {
        score += 1;
      }
    }

    return score;
  }

  private expandRequestedSourceHints(value: string): string[] {
    const hints = new Set<string>();
    const normalized = value
      .toLowerCase()
      .replace(/^[\s-]*(?:the|a|an)\s+/i, '')
      .replace(
        /\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document|documentation|pdf)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();

    const originalNormalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (originalNormalized) {
      hints.add(originalNormalized);
    }

    if (normalized) {
      hints.add(normalized);
    }

    return [...hints].filter((hint) => hint.length >= 3);
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
      const mentionedReferenceIds = [...haystack.matchAll(/\b1p\d{2,}\b/g)].map(
        (match) => match[0].toLowerCase(),
      );
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

  private refinePartsSubjectCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (citations.length <= 1) {
      return citations;
    }

    const focus = this.extractPartsFocus(query);
    if (focus.generalTerms.length === 0 && focus.specificTerms.length === 0) {
      return citations;
    }

    const scored = citations
      .map((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        const generalOverlap = focus.generalTerms.filter((term) =>
          haystack.includes(term),
        ).length;
        const specificOverlap = focus.specificTerms.filter((term) =>
          haystack.includes(term),
        ).length;
        const hasConflictingPartsEvidence =
          focus.specificTerms.length > 0 &&
          this.hasConflictingPartsEvidence(haystack, focus.specificTerms);
        const sourceType = this.classifyCitationSourceType(citation);
        const metadataEvidence =
          /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location)\b/i.test(
            haystack,
          )
            ? 1
            : 0;

        let score =
          (citation.score ?? 0) * 10 +
          generalOverlap * 4 +
          specificOverlap * 12 +
          metadataEvidence * 3;

        if (sourceType === 'parts_list') {
          score += 8;
        } else if (sourceType === 'maintenance_schedule') {
          score += 4;
        }

        if (hasConflictingPartsEvidence) {
          score -= 18;
        }

        return {
          citation,
          generalOverlap,
          specificOverlap,
          hasConflictingPartsEvidence,
          score,
        };
      })
      .sort((left, right) => {
        if (right.specificOverlap !== left.specificOverlap) {
          return right.specificOverlap - left.specificOverlap;
        }
        if (right.generalOverlap !== left.generalOverlap) {
          return right.generalOverlap - left.generalOverlap;
        }

        return right.score - left.score;
      });

    const directSpecificMatches = scored.filter(
      (entry) => entry.specificOverlap > 0,
    );
    if (directSpecificMatches.length > 0) {
      return directSpecificMatches.map((entry) => entry.citation);
    }

    const generalMatches = scored.filter(
      (entry) => entry.generalOverlap > 0 && !entry.hasConflictingPartsEvidence,
    );
    if (generalMatches.length > 0) {
      return generalMatches.map((entry) => entry.citation);
    }

    return scored.map((entry) => entry.citation);
  }

  private sortCitationsByUpcomingDue(
    citations: ChatCitation[],
  ): ChatCitation[] {
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
        const allSlashNumbers = [...plainSnippet.matchAll(/\/\s*(\d{2,6})\b/g)];
        const lastSlashNumber = allSlashNumbers.at(-1);
        if (lastSlashNumber) {
          result.nextDueHours = Number.parseInt(lastSlashNumber[1], 10);
        }
      }
    }

    return result;
  }

  private expandPartsEvidenceCitations(
    query: string,
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

    const focus = this.extractPartsFocus(query);
    const samePagePartCandidates = allCitations.filter((citation) => {
      const key = `${citation.sourceTitle ?? ''}::${citation.pageNumber ?? ''}`;
      if (!anchorKeys.has(key)) return false;

      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      const hasPartsEvidence =
        /\b(manufacturer\s*part#?|supplier\s*part#?|quantity|location|volvo\s+penta|engine\s+oil|zinc|anode|belt|filter|impeller|wear\s*kit|coolant|prefilter)\b/i.test(
          haystack,
        );
      if (!hasPartsEvidence) {
        return false;
      }

      if (focus.specificTerms.length === 0) {
        return true;
      }

      const specificOverlap = focus.specificTerms.filter((term) =>
        haystack.includes(term),
      ).length;
      if (specificOverlap > 0) {
        return true;
      }

      return !this.hasConflictingPartsEvidence(haystack, focus.specificTerms);
    });

    return this.mergeCitations(matchedParts, samePagePartCandidates);
  }

  private extractPartsFocus(query: string): {
    generalTerms: string[];
    specificTerms: string[];
  } {
    const genericTerms = new Set([
      'part',
      'parts',
      'spare',
      'spares',
      'consumables',
      'manufacturer',
      'supplier',
      'quantity',
      'quantities',
      'location',
      'locations',
      'stored',
      'storage',
      'need',
      'needed',
      'replace',
      'replacement',
      'generator',
      'genset',
      'engine',
      'port',
      'starboard',
      'left',
      'right',
    ]);
    const specificVocabulary = new Set([
      'impeller',
      'filter',
      'filters',
      'anode',
      'anodes',
      'zinc',
      'belt',
      'belts',
      'thermostat',
      'thermostats',
      'pump',
      'pumps',
      'seal',
      'seals',
      'gasket',
      'gaskets',
      'bearing',
      'bearings',
      'cartridge',
      'cartridges',
      'coolant',
      'oil',
      'wear',
      'kit',
      'kits',
      'sensor',
      'sensors',
      'valve',
      'valves',
      'hose',
      'hoses',
      'coupling',
      'couplings',
    ]);

    const terms = this.queryService.extractRetrievalSubjectTerms(query);
    return {
      generalTerms: terms.filter((term) => !genericTerms.has(term)),
      specificTerms: terms.filter((term) => specificVocabulary.has(term)),
    };
  }

  private hasConflictingPartsEvidence(
    haystack: string,
    specificTerms: string[],
  ): boolean {
    const evidenceTerms = this.extractPartsEvidenceTerms(haystack);
    return (
      evidenceTerms.length > 0 &&
      evidenceTerms.every((term) => !specificTerms.includes(term))
    );
  }

  private extractPartsEvidenceTerms(text: string): string[] {
    const patterns: Array<[string, RegExp]> = [
      ['impeller', /\bimpellers?\b/i],
      ['filter', /\bfilters?\b/i],
      ['anode', /\b(anodes?|zincs?)\b/i],
      ['belt', /\bbelts?\b/i],
      ['thermostat', /\bthermostats?\b/i],
      ['pump', /\bpumps?\b/i],
      ['seal', /\bseals?\b/i],
      ['gasket', /\bgaskets?\b/i],
      ['bearing', /\bbearings?\b/i],
      ['cartridge', /\bcartridges?\b/i],
      ['coolant', /\bcoolant\b/i],
      ['oil', /\boil\b/i],
      ['wear', /\bwear\s*kit\b/i],
      ['sensor', /\bsensors?\b/i],
      ['valve', /\bvalves?\b/i],
      ['hose', /\bhoses?\b/i],
      ['coupling', /\bcouplings?\b/i],
    ];

    return patterns
      .filter(([, pattern]) => pattern.test(text))
      .map(([label]) => label);
  }

  private rankCitationsBySourceType(
    userQuery: string,
    citations: ChatCitation[],
    queryPlan: ChatQueryPlan,
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
    const categoryWeights = this.buildCategoryWeightMap(
      queryPlan.sourcePriorities,
    );

    return [...citations].sort((a, b) => {
      const typeA = this.classifyCitationSourceType(a);
      const typeB = this.classifyCitationSourceType(b);
      const categoryWeightA = this.getCitationCategoryWeight(
        a,
        categoryWeights,
      );
      const categoryWeightB = this.getCitationCategoryWeight(
        b,
        categoryWeights,
      );
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

      if (categoryWeightA !== categoryWeightB)
        return categoryWeightB - categoryWeightA;
      if (weightA !== weightB) return weightB - weightA;
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }

  private buildCategoryWeightMap(
    sourcePriorities: ChatSourceCategory[],
  ): Map<ChatSourceCategory, number> {
    const weights = new Map<ChatSourceCategory, number>();
    const size = sourcePriorities.length;

    sourcePriorities.forEach((category, index) => {
      weights.set(category, size - index);
    });

    return weights;
  }

  private getCitationCategoryWeight(
    citation: ChatCitation,
    categoryWeights: Map<ChatSourceCategory, number>,
  ): number {
    const category = this.inferCitationKnowledgeCategory(citation);
    if (!category) return 0;
    return categoryWeights.get(category) ?? 0;
  }

  private inferCitationKnowledgeCategory(
    citation: ChatCitation,
  ): ChatSourceCategory | null {
    const explicitCategory = citation.sourceCategory?.trim().toUpperCase();
    if (
      explicitCategory === 'MANUALS' ||
      explicitCategory === 'HISTORY_PROCEDURES' ||
      explicitCategory === 'CERTIFICATES' ||
      explicitCategory === 'REGULATION'
    ) {
      return explicitCategory;
    }

    if (this.isStandaloneCertificateLikeCitation(citation)) {
      return 'CERTIFICATES';
    }

    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
    const manualLikeTitle = this.isManualLikeCitationTitle(
      citation.sourceTitle,
    );

    if (
      !manualLikeTitle &&
      /\b(certificate|survey|class\s+certificate|valid\s+until|expiry|expire)\b/i.test(
        haystack,
      )
    ) {
      return 'CERTIFICATES';
    }

    if (
      /\b(regulation|marl?pol|imo|flag\s+state|annex|compliance|detention|fine)\b/i.test(
        haystack,
      )
    ) {
      return 'REGULATION';
    }

    if (
      /maintenance\s+tasks/i.test(citation.sourceTitle ?? '') ||
      /\b(reference\s*id|next\s+due|last\s+due|completed|postponed|maintenance\s+record|task\s+name|component\s+name)\b/i.test(
        haystack,
      )
    ) {
      return 'HISTORY_PROCEDURES';
    }

    if (citation.sourceTitle || citation.snippet) {
      return 'MANUALS';
    }

    return null;
  }

  private isManualLikeCitationTitle(sourceTitle?: string): boolean {
    return /\b(manual|guide|handbook|instruction|user'?s\s+guide|operator|operators)\b/i.test(
      sourceTitle ?? '',
    );
  }

  private isCertificateSupportDocumentTitle(sourceTitle?: string): boolean {
    return /\b(guideline|guidelines|report|record|records|checklist|history|details|administration|form|list)\b/i.test(
      sourceTitle ?? '',
    );
  }

  private isStandaloneCertificateLikeCitation(citation: ChatCitation): boolean {
    const title = citation.sourceTitle ?? '';
    const haystack = `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`;
    if (this.isManualLikeCitationTitle(title)) {
      return false;
    }

    const strongTitleSignal =
      /\b(certificate|certificato|approval|license|licence|declaration|registry|renewal|cor\b|class\b)\b/i.test(
        title,
      ) ||
      (/\bsurvey\b/i.test(title) &&
        !this.isCertificateSupportDocumentTitle(title));
    const strongSnippetSignal =
      /\b(this\s+certificate|certificate\s+no\.?|certificateof|certificate\s+of|ec\s+type-?examination|type\s+approval|product\s+design\s+assessment|manufacturing\s+assessment|declaration\s+of\s+conformity|radio\s+station\s+communication\s+license|valid\s+until|expiration\s+date|expiry\s+date|expires?\s+on|expiring:)\b/i.test(
        haystack,
      );

    const explicitCategory = citation.sourceCategory?.trim().toUpperCase();
    if (explicitCategory === 'CERTIFICATES') {
      return (
        strongSnippetSignal ||
        (strongTitleSignal && !this.isCertificateSupportDocumentTitle(title))
      );
    }

    return (
      strongSnippetSignal ||
      (strongTitleSignal && !this.isCertificateSupportDocumentTitle(title))
    );
  }

  private isEmbeddedProductApprovalCitation(citation: ChatCitation): boolean {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();

    return (
      this.isManualLikeCitationTitle(citation.sourceTitle) &&
      /\b(product\s+design\s+assessment|manufacturing\s+assessment|type\s+approval|declaration\s+of\s+conformity|module\s+[a-z]|gas\s+detector)\b/i.test(
        haystack,
      )
    );
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

  private isOfficialRegistryCertificateCitation(
    citation: ChatCitation,
  ): boolean {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();

    return /\b(certificate\s+of\s+registry|official\s+and\s+imo|name\s+of\s+ship|issued\s+in\s+terms|renewal\s+certificate)\b/i.test(
      haystack,
    );
  }

  private extractExplicitCertificateExpiryTimestamp(
    citation: ChatCitation,
  ): number | null {
    const plainText = this.stripHtmlLikeMarkup(citation.snippet ?? '');
    const patterns = [
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b/i,
    ];

    for (const pattern of patterns) {
      const match = plainText.match(pattern);
      if (!match?.[1]) {
        continue;
      }

      const timestamp = this.parseExplicitCertificateDateToken(match[1]);
      if (timestamp !== null) {
        return timestamp;
      }
    }

    return null;
  }

  private parseExplicitCertificateDateToken(token: string): number | null {
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

    const sideMatched = citations.filter((citation) =>
      this.queryService.matchesDirectionalSide(
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
        directionalSide,
      ),
    );
    let refined = sideMatched;
    if (refined.length === 0) {
      refined = citations;
    } else if (this.queryService.isProcedureQuery(query)) {
      const neutralProcedureSupport = citations.filter((citation) => {
        if (sideMatched.includes(citation)) {
          return false;
        }

        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        if (
          this.queryService.matchesDirectionalSide(haystack, 'port') ||
          this.queryService.matchesDirectionalSide(haystack, 'starboard')
        ) {
          return false;
        }

        return this.isSupplementalGeneratorProcedureCitation(query, citation);
      });

      if (neutralProcedureSupport.length > 0) {
        refined = [...refined, ...neutralProcedureSupport];
      }
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

    const scored = refined
      .map((citation) => ({
        citation,
        analysis: this.analyzeGeneratorAssetCitation(query, citation),
      }))
      .sort((left, right) => {
        if (right.analysis.score !== left.analysis.score) {
          return right.analysis.score - left.analysis.score;
        }

        return (right.citation.score ?? 0) - (left.citation.score ?? 0);
      });

    const focusFiltered = scored.filter(
      (entry) =>
        entry.analysis.focusOverlap > 0 ||
        entry.analysis.querySpecificEvidence > 0,
    );
    if (focusFiltered.length > 0) {
      return focusFiltered.map((entry) => entry.citation);
    }

    return scored.map((entry) => entry.citation);
  }

  private refineCertificateSubjectCitations(
    query: string,
    citations: ChatCitation[],
    queryPlan: ChatQueryPlan,
  ): ChatCitation[] {
    if (
      queryPlan.primaryIntent !== 'certificate_status' ||
      citations.length <= 1
    ) {
      return citations;
    }

    const normalized = query.toLowerCase();
    if (
      /\bfire\s+suppression|suppression\s+system|fixed\s+fire(?:\s*fighting|\s*extinguishing)?\s+system\b/i.test(
        normalized,
      )
    ) {
      const directSystemMatches = citations
        .filter((citation) => {
          const haystack =
            `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
          return /\bfire\s+suppression|suppression\s+system|fixed\s+fire(?:\s*fighting|\s*extinguishing)?\s+system\b/i.test(
            haystack,
          );
        })
        .sort((left, right) => {
          const leftCertificate =
            left.sourceCategory === 'CERTIFICATES' ? 1 : 0;
          const rightCertificate =
            right.sourceCategory === 'CERTIFICATES' ? 1 : 0;
          if (rightCertificate !== leftCertificate) {
            return rightCertificate - leftCertificate;
          }

          const leftSurveyEvidence =
            /\b(survey|certificate|valid\s+until|expiry|expires?)\b/i.test(
              `${left.sourceTitle ?? ''}\n${left.snippet ?? ''}`,
            )
              ? 1
              : 0;
          const rightSurveyEvidence =
            /\b(survey|certificate|valid\s+until|expiry|expires?)\b/i.test(
              `${right.sourceTitle ?? ''}\n${right.snippet ?? ''}`,
            )
              ? 1
              : 0;
          if (rightSurveyEvidence !== leftSurveyEvidence) {
            return rightSurveyEvidence - leftSurveyEvidence;
          }

          return (right.score ?? 0) - (left.score ?? 0);
        });

      if (directSystemMatches.length > 0) {
        return directSystemMatches;
      }
    }

    const focusTerms = this.queryService
      .extractRetrievalSubjectTerms(query)
      .filter(
        (term) =>
          ![
            'what',
            'when',
            'where',
            'which',
            'who',
            'will',
            'any',
            'certificate',
            'certificates',
            'expiry',
            'expire',
            'expires',
            'expired',
            'valid',
            'until',
            'renewal',
            'date',
            'soon',
            'upcoming',
          ].includes(term),
      );

    if (focusTerms.length === 0) {
      const broadSoonQuery = this.isBroadCertificateSoonQuery(normalized);
      const broadCertificateRanking = [...citations].sort((left, right) => {
        const leftHaystack =
          `${left.sourceTitle ?? ''}\n${left.snippet ?? ''}`.toLowerCase();
        const rightHaystack =
          `${right.sourceTitle ?? ''}\n${right.snippet ?? ''}`.toLowerCase();
        const leftStandalone = this.isStandaloneCertificateLikeCitation(left)
          ? 1
          : 0;
        const rightStandalone = this.isStandaloneCertificateLikeCitation(right)
          ? 1
          : 0;
        if (rightStandalone !== leftStandalone) {
          return rightStandalone - leftStandalone;
        }

        const leftEmbeddedManual = this.isEmbeddedProductApprovalCitation(left)
          ? 1
          : 0;
        const rightEmbeddedManual = this.isEmbeddedProductApprovalCitation(
          right,
        )
          ? 1
          : 0;
        if (leftEmbeddedManual !== rightEmbeddedManual) {
          return leftEmbeddedManual - rightEmbeddedManual;
        }

        const leftHasExplicitExpiry = broadSoonQuery
          ? this.extractExplicitCertificateExpiryTimestamp(left) !== null
          : false;
        const rightHasExplicitExpiry = broadSoonQuery
          ? this.extractExplicitCertificateExpiryTimestamp(right) !== null
          : false;
        if (rightHasExplicitExpiry !== leftHasExplicitExpiry) {
          return Number(rightHasExplicitExpiry) - Number(leftHasExplicitExpiry);
        }

        const leftOfficialCertificate =
          this.isOfficialRegistryCertificateCitation(left) ? 1 : 0;
        const rightOfficialCertificate =
          this.isOfficialRegistryCertificateCitation(right) ? 1 : 0;
        if (rightOfficialCertificate !== leftOfficialCertificate) {
          return broadSoonQuery
            ? leftOfficialCertificate - rightOfficialCertificate
            : rightOfficialCertificate - leftOfficialCertificate;
        }

        return (right.score ?? 0) - (left.score ?? 0);
      });

      const standaloneMatches = broadCertificateRanking.filter((citation) =>
        this.isStandaloneCertificateLikeCitation(citation),
      );
      if (standaloneMatches.length > 0 && broadSoonQuery) {
        const now = Date.now();
        const datedStandaloneMatches = standaloneMatches
          .map((citation) => ({
            citation,
            expiry: this.extractExplicitCertificateExpiryTimestamp(citation),
          }))
          .filter(
            (
              entry,
            ): entry is {
              citation: ChatCitation;
              expiry: number;
            } => entry.expiry !== null,
          )
          .sort((left, right) => left.expiry - right.expiry);

        const futureStandaloneMatches = datedStandaloneMatches
          .filter((entry) => entry.expiry >= now)
          .map((entry) => entry.citation);
        if (futureStandaloneMatches.length > 0) {
          return futureStandaloneMatches;
        }

        if (datedStandaloneMatches.length > 0) {
          return datedStandaloneMatches.map((entry) => entry.citation);
        }
      }

      if (standaloneMatches.length > 0) {
        return standaloneMatches;
      }

      return broadCertificateRanking;
    }

    const scored = citations
      .map((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        const focusOverlap = focusTerms.filter((term) =>
          haystack.includes(term),
        ).length;
        let score = (citation.score ?? 0) * 10 + focusOverlap * 8;

        if (
          /\bfire\s+suppression|suppression\s+system\b/i.test(normalized) &&
          /\bextinguisher\b/i.test(haystack) &&
          !/\bsuppression\b/i.test(haystack)
        ) {
          score -= 20;
        }

        if (
          /\bfire\s+suppression|suppression\s+system\b/i.test(normalized) &&
          /\bsurvey\b/i.test(haystack)
        ) {
          score += 6;
        }

        return {
          citation,
          focusOverlap,
          score,
        };
      })
      .sort((left, right) => {
        if (right.focusOverlap !== left.focusOverlap) {
          return right.focusOverlap - left.focusOverlap;
        }

        return right.score - left.score;
      });

    const matched = scored.filter((entry) => entry.focusOverlap > 0);
    if (matched.length > 0) {
      return matched.map((entry) => entry.citation);
    }

    return citations;
  }

  private refineTroubleshootingCitations(
    query: string,
    citations: ChatCitation[],
    queryPlan: ChatQueryPlan,
  ): ChatCitation[] {
    if (
      queryPlan.primaryIntent !== 'troubleshooting' ||
      citations.length <= 1
    ) {
      return citations;
    }

    const focusTerms = this.queryService
      .extractRetrievalSubjectTerms(query)
      .filter(
        (term) =>
          ![
            'alarm',
            'alarms',
            'fault',
            'error',
            'issue',
            'problem',
            'high',
            'low',
            'temperature',
            'temp',
            'pressure',
            'current',
            'reading',
            'value',
            'check',
            'checks',
            'first',
            'showing',
          ].includes(term),
      );

    if (focusTerms.length === 0) {
      return citations;
    }

    const scored = citations
      .map((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        const focusOverlap = focusTerms.filter((term) =>
          haystack.includes(term),
        ).length;
        const troubleshootingEvidence =
          /\b(alarm|possible\s+cause|corrective\s+action|fault|troubleshoot|check|inspect|replace|clean|blocked|impeller|thermostat|coolant|temperature|seawater|sea\s*water)\b/i.test(
            haystack,
          )
            ? 1
            : 0;
        const looksUnrelatedControlSystem =
          /\b(autopilot|rudder|plotter|compass|can\s+bus|xte|boat\s+speed|gps|nav\s+mode|work\s+profile)\b/i.test(
            haystack,
          ) && focusOverlap === 0;
        let score =
          (citation.score ?? 0) * 10 +
          focusOverlap * 8 +
          troubleshootingEvidence * 4;

        if (looksUnrelatedControlSystem) {
          score -= 20;
        }

        return {
          citation,
          focusOverlap,
          troubleshootingEvidence,
          score,
        };
      })
      .sort((left, right) => {
        if (right.focusOverlap !== left.focusOverlap) {
          return right.focusOverlap - left.focusOverlap;
        }
        if (right.troubleshootingEvidence !== left.troubleshootingEvidence) {
          return right.troubleshootingEvidence - left.troubleshootingEvidence;
        }
        return right.score - left.score;
      });

    const matched = scored.filter((entry) => entry.focusOverlap > 0);
    if (matched.length > 0) {
      return matched.map((entry) => entry.citation);
    }

    return citations;
  }

  private isSupplementalGeneratorProcedureCitation(
    query: string,
    citation: ChatCitation,
  ): boolean {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
    const subjectTerms = this.queryService
      .extractRetrievalSubjectTerms(query)
      .filter((term) => term.length >= 3);
    const subjectOverlap = subjectTerms.filter((term) =>
      haystack.includes(term),
    ).length;

    let score = 0;

    if (
      /\b(manual|handbook|operator|operators|operation|maintenance|lubrication)\b/i.test(
        citation.sourceTitle ?? '',
      )
    ) {
      score += 2;
    }

    if (
      /\b(lubrication|engine oil|oil filter|oil bypass filter|drain|fill|dipstick|do not fill up above|stop the engine|max mark)\b/i.test(
        haystack,
      )
    ) {
      score += 4;
    }

    if (/\boil\b/i.test(query) && /\boil\b/i.test(haystack)) {
      score += 3;
    }

    if (/\bfilter\b/i.test(query) && /\bfilter\b/i.test(haystack)) {
      score += 2;
    }

    score += subjectOverlap * 2;

    return score >= 6;
  }

  private analyzeGeneratorAssetCitation(
    query: string,
    citation: ChatCitation,
  ): {
    score: number;
    focusOverlap: number;
    querySpecificEvidence: number;
  } {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
    const focusKeywords = this.extractGeneratorAssetFocusKeywords(query);
    const wantsNextDue = this.queryService.isNextDueLookupQuery(query);

    let score = (citation.score ?? 0) * 10;
    let focusOverlap = 0;
    let querySpecificEvidence = 0;

    if (/reference row:/i.test(haystack)) {
      score += 8;
    }
    if (/included work items:/i.test(haystack)) {
      score += 6;
    }
    if (/spare parts:/i.test(haystack)) {
      score += 4;
    }

    for (const [keyword, pattern] of focusKeywords) {
      if (!pattern.test(haystack)) {
        continue;
      }

      focusOverlap += 1;
      score += 8;

      if (
        keyword === 'oil' &&
        /\b(replace oil and filters|take oil sample|engine oil|oil filter|oil bypass filter)\b/i.test(
          haystack,
        )
      ) {
        querySpecificEvidence += 1;
        score += 10;
      }
    }

    if (focusKeywords.length > 0 && focusOverlap === 0) {
      score -= 6;
    }

    if (wantsNextDue) {
      const due = this.extractUpcomingDueSortKey(citation.snippet ?? '');
      if (due.nextDueHours !== undefined) {
        score += Math.max(0, 8 - due.nextDueHours / 1000);
      } else if (due.nextDueDate !== undefined) {
        score += 2;
      }
    }

    return { score, focusOverlap, querySpecificEvidence };
  }

  private extractGeneratorAssetFocusKeywords(
    query: string,
  ): Array<[string, RegExp]> {
    const normalized = query.toLowerCase();
    const keywords: Array<[string, RegExp]> = [];

    const patterns: Array<[string, RegExp]> = [
      ['oil', /\boil\b/i],
      ['filter', /\bfilters?\b/i],
      ['coolant', /\bcoolant\b/i],
      ['fuel', /\bfuel\b/i],
      ['air filter', /\bair\b/i],
      ['belt', /\bbelts?\b/i],
      ['impeller', /\bimpeller\b/i],
      ['anode', /\banodes?\b|\bzincs?\b/i],
      ['pump', /\bpump\b/i],
      ['sea water', /\bsea\s*water\b/i],
      ['sample', /\bsample\b/i],
      ['thermostat', /\bthermostat\b/i],
    ];

    for (const [label, pattern] of patterns) {
      if (pattern.test(normalized)) {
        keywords.push([
          label,
          label === 'air filter'
            ? /\bair\s*filter\b/i
            : label === 'sea water'
              ? /\bsea\s*water\b|\bseawater\b/i
              : pattern,
        ]);
      }
    }

    return keywords;
  }

  private refineMaintenanceScheduleCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (this.queryService.isPartsQuery(query)) {
      return citations;
    }

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

    if (scheduleMatched.length === 0) {
      return citations;
    }

    if (!this.queryService.isProcedureQuery(query)) {
      return scheduleMatched;
    }

    const supplementalProcedureCitations = citations
      .filter(
        (citation) =>
          !/maintenance\s+tasks/i.test(citation.sourceTitle ?? '') &&
          this.isProcedureSupportCitation(query, citation),
      )
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, 2);

    if (supplementalProcedureCitations.length === 0) {
      return scheduleMatched;
    }

    return [...scheduleMatched, ...supplementalProcedureCitations];
  }

  private refineManualIntervalMaintenanceCitations(
    query: string,
    citations: ChatCitation[],
  ): ChatCitation[] {
    if (
      citations.length === 0 ||
      this.queryService.isPartsQuery(query) ||
      !this.queryService.isIntervalMaintenanceQuery(query)
    ) {
      return citations;
    }

    const intervalPhrases =
      this.queryService.extractMaintenanceIntervalSearchPhrases(query);
    const prefersHistoricalIntervalEvidence =
      this.queryService.isNextDueLookupQuery(query) ||
      /\b(last|previous|history|historical|completed|postponed|reference\s*id|task\s+name|component\s+name)\b/i.test(
        query,
      );
    const scored = citations.map((citation, index) => {
      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      let score = citation.score ?? 0;

      if (
        /\b(periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals?|maintenance\s+as\s+needed|maintenance\s+schedule|service\s+schedule)\b/i.test(
          haystack,
        )
      ) {
        score += 40;
      }

      if (
        /\b(mainten[a-z]*|service|inspection|checks?|schedule)\b/i.test(
          haystack,
        )
      ) {
        score += 12;
      }

      if (
        /\b(before\s+starting|first\s+check\s+after|every\s+\d{2,6}|annual|annually|monthly|hours?|hrs?)\b/i.test(
          haystack,
        )
      ) {
        score += 18;
      }

      if (
        /\b(replace|inspect|check|clean|change|verify|adjust|test|sample)\b/i.test(
          haystack,
        )
      ) {
        score += 8;
      }

      const intervalMatches = intervalPhrases.filter((phrase) =>
        haystack.includes(phrase.toLowerCase()),
      ).length;
      score += intervalMatches * 12;

      if (
        intervalMatches === 0 &&
        /\b\d{2,6}\s*(?:mm|mbar|bar|psi|v|volt|volts|amp|amps|a|kw|kva|rpm|c)\b/i.test(
          haystack,
        ) &&
        /\b(fuel\s+circuit|diesel\s+fuel\s+inlet|fuel\s+outlet|diameter|opening|connection)\b/i.test(
          haystack,
        )
      ) {
        score -= 25;
      }

      if (prefersHistoricalIntervalEvidence) {
        if (
          citation.sourceCategory === 'HISTORY_PROCEDURES' ||
          /maintenance\s+tasks/i.test(citation.sourceTitle ?? '') ||
          /\b(next\s+due|last\s+due|reference\s*id|task\s+name|component\s+name|completed|postponed)\b/i.test(
            haystack,
          )
        ) {
          score += 28;
        } else if (
          citation.chunkId?.startsWith('manual-interval-scan:') === true
        ) {
          score -= 6;
        }
      }

      return {
        citation,
        index,
        hasStructuredScan:
          citation.chunkId?.startsWith('manual-interval-scan:') === true,
        score,
      };
    });

    const strongestStructuredSourceTitle = scored
      .filter((entry) => entry.hasStructuredScan && entry.citation.sourceTitle)
      .sort((left, right) => right.score - left.score)[0]?.citation.sourceTitle;

    const boosted = scored
      .map((entry) => {
        let score = entry.score;

        if (strongestStructuredSourceTitle) {
          if (entry.citation.sourceTitle === strongestStructuredSourceTitle) {
            score += 14;
          } else {
            score -= 8;
          }
        }

        return {
          ...entry,
          score,
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.index - right.index;
      });

    const topScore = boosted[0]?.score ?? 0;
    if (topScore <= 0) {
      return citations;
    }

    const shortlisted = boosted.filter((entry) => entry.score >= topScore - 16);

    if (strongestStructuredSourceTitle && !prefersHistoricalIntervalEvidence) {
      const preferredSourceEntries = shortlisted.filter(
        (entry) =>
          entry.citation.sourceTitle === strongestStructuredSourceTitle,
      );

      if (preferredSourceEntries.length > 0) {
        return preferredSourceEntries.map((entry) => entry.citation);
      }
    }

    return shortlisted.map((entry) => entry.citation);
  }

  private isProcedureSupportCitation(
    query: string,
    citation: ChatCitation,
  ): boolean {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
    const subjectTerms = this.queryService
      .extractRetrievalSubjectTerms(query)
      .filter((term) => term.length >= 3);
    const overlap = subjectTerms.filter((term) =>
      haystack.includes(term),
    ).length;

    if (
      /\b(lubrication|procedure|instructions?|maintenance|engine oil|oil filter|oil bypass filter|drain|fill|dipstick)\b/i.test(
        haystack,
      )
    ) {
      return overlap > 0 || /\boil|filter|generator|engine\b/i.test(haystack);
    }

    return false;
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
    let start = Math.max(0, anchorIndex - charsBefore);
    start = this.trimLeadingForeignReferenceContext(
      snippet,
      anchor,
      start,
      anchorIndex,
    );
    let end = Math.min(
      snippet.length,
      anchorIndex + anchor.length + charsAfter,
    );

    const trailingSlice = snippet.slice(anchorIndex + anchor.length, end);
    const nextForeignReference = [
      ...trailingSlice.matchAll(/\b1p\d{2,}\b/gi),
    ].find((match) => match[0].toLowerCase() !== anchor.toLowerCase());
    if (
      nextForeignReference &&
      typeof nextForeignReference.index === 'number'
    ) {
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

  private extractMaintenanceReferenceIds(text: string): string[] {
    return [
      ...new Set(
        (text.match(MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN) ?? []).map(
          (match) => match.toLowerCase(),
        ),
      ),
    ];
  }

  private trimLeadingForeignReferenceContext(
    snippet: string,
    anchor: string,
    start: number,
    anchorIndex: number,
  ): number {
    const normalizedAnchor = anchor.toLowerCase();
    const leadingSlice = snippet.slice(start, anchorIndex);
    const leadingReferenceMatches = [
      ...leadingSlice.matchAll(MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN),
    ].filter((match) => match[0].toLowerCase() !== normalizedAnchor);

    const previousForeignReference =
      leadingReferenceMatches[leadingReferenceMatches.length - 1];
    if (
      !previousForeignReference ||
      typeof previousForeignReference.index !== 'number'
    ) {
      return start;
    }

    const foreignReferenceIndex = start + previousForeignReference.index;
    const lowerSnippet = snippet.toLowerCase();
    const boundaryMarkers = ['<tr', 'reference row:', 'component name:'];
    let boundaryIndex = -1;

    for (const marker of boundaryMarkers) {
      const candidateIndex = lowerSnippet.lastIndexOf(marker, anchorIndex);
      if (
        candidateIndex > foreignReferenceIndex &&
        candidateIndex < anchorIndex &&
        candidateIndex > boundaryIndex
      ) {
        boundaryIndex = candidateIndex;
      }
    }

    if (boundaryIndex >= 0) {
      return Math.max(start, boundaryIndex);
    }

    return Math.max(
      start,
      foreignReferenceIndex + previousForeignReference[0].length,
    );
  }

  private buildSourceEvidenceProfiles(
    retrievalQuery: string,
    citations: ChatCitation[],
  ): SourceEvidenceProfile[] {
    const grouped = new Map<string, ChatCitation[]>();

    for (const citation of citations) {
      const sourceKey = this.getSourceKey(citation);
      const existing = grouped.get(sourceKey) ?? [];
      existing.push(citation);
      grouped.set(sourceKey, existing);
    }

    const subjectTerms =
      this.queryService.extractRetrievalSubjectTerms(retrievalQuery);

    return [...grouped.entries()]
      .map(([sourceKey, sourceCitations]) => {
        const combinedText = sourceCitations
          .map((citation) => citation.snippet ?? '')
          .join('\n');
        const plainText = this.stripHtmlLikeMarkup(combinedText);
        const sourceHaystack =
          `${sourceCitations[0]?.sourceTitle ?? ''}\n${combinedText}`.toLowerCase();
        const subjectCoverage = subjectTerms.filter((term) =>
          sourceHaystack.includes(term),
        ).length;

        const intervalValues = this.extractUniqueMatches(
          plainText,
          /\b\d+(?:[\s,]\d{3})?\s*(?:hours?|hrs?|months?|years?)\b/gi,
        );
        const nextDueValues = this.extractUniqueMatches(
          plainText,
          /\bnext\s*due\b[\s\S]{0,120}?\/\s*\d{2,6}\b/gi,
        );
        const nextDueDates = this.extractUniqueMatches(
          plainText,
          /\bnext\s*due\b[\s\S]{0,80}?\d{2}[./]\d{2}[./]\d{4}\b/gi,
        );
        const lastDueValues = this.extractUniqueMatches(
          plainText,
          /\blast\s*due\b[\s\S]{0,120}?\/\s*\d{2,6}\b/gi,
        );
        const oilSpecs = this.extractUniqueMatches(
          plainText,
          /\b(?:sae\s*\d+\w*-\d+\w*|api\s*[a-z0-9-]+|vds[-\s]*\d+|iso\s*vg\s*\d+)\b/gi,
        );
        const partNumbers = this.extractUniqueMatches(
          plainText,
          /\b(?:manufacturer\s*part#?|supplier\s*part#?|part#?|p\/n)\b[\s:]*([A-Z0-9./-]{4,})/gi,
          1,
        );
        const quantityValues = this.extractUniqueMatches(
          plainText,
          /\bquantity\b[\s:]*([0-9]+(?:\.[0-9]+)?)\b/gi,
          1,
        );
        const capacityValues = this.extractUniqueMatches(
          plainText,
          /\b\d+(?:\.\d+)?\s*(?:l|liters?|litres?|ml|gal|gallons?)\b/gi,
        );
        const emailValues = this.extractUniqueMatches(
          plainText,
          /\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/gi,
        );
        const phoneValues = this.extractUniqueMatches(
          plainText,
          /\+\s*\d[\d\s()./-]{5,}\d\b/gi,
        );
        const expiryTimestamps =
          this.extractExplicitCertificateExpiryTimestampsFromText(plainText);
        const contactAnchorTerms =
          this.queryService.extractContactAnchorTerms(retrievalQuery);
        const matchedContactAnchors = contactAnchorTerms.filter((term) =>
          sourceHaystack.includes(term),
        );
        const contactEvidenceScore =
          Math.min(emailValues.length, 4) +
          Math.min(phoneValues.length, 4) +
          sourceCitations.filter((citation) =>
            /\b(email|e-mail|mobile|phone|telephone|tel[:.]?|contact\s+details|contact\s+list|company\s+contact|emergency\s+contact)\b/i.test(
              `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
            ),
          ).length +
          matchedContactAnchors.length * 3 +
          (matchedContactAnchors.includes('dpa') ? 4 : 0);
        const explicitEvidenceScore =
          this.countNonEmptyArrays([
            intervalValues,
            nextDueValues,
            nextDueDates,
            lastDueValues,
            oilSpecs,
            partNumbers,
            quantityValues,
            capacityValues,
            expiryTimestamps.map((timestamp) => String(timestamp)),
          ]) +
          contactEvidenceScore +
          sourceCitations.filter((citation) =>
            /\b(reference\s*id|interval|next\s*due|last\s*due|spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|valid\s+until|expiry|expiration|expiring|expires?\s+on|scadenza)\b/i.test(
              citation.snippet ?? '',
            ),
          ).length;

        return {
          sourceKey,
          sourceTitle: sourceCitations[0]?.sourceTitle ?? sourceKey,
          manualIds: [
            ...new Set(
              sourceCitations
                .map((citation) => citation.shipManualId?.trim())
                .filter((manualId): manualId is string => Boolean(manualId)),
            ),
          ],
          citations: sourceCitations,
          combinedText: plainText,
          subjectCoverage,
          aggregateScore: sourceCitations.reduce(
            (sum, citation) => sum + (citation.score ?? 0),
            0,
          ),
          explicitEvidenceScore,
          contactEvidenceScore,
          intervalValues,
          nextDueValues,
          nextDueDates,
          lastDueValues,
          oilSpecs,
          partNumbers,
          quantityValues,
          capacityValues,
          expiryTimestamps,
          emailValues,
          phoneValues,
        };
      })
      .sort((a, b) => {
        if (a.explicitEvidenceScore !== b.explicitEvidenceScore) {
          return b.explicitEvidenceScore - a.explicitEvidenceScore;
        }
        if (a.subjectCoverage !== b.subjectCoverage) {
          return b.subjectCoverage - a.subjectCoverage;
        }
        return b.aggregateScore - a.aggregateScore;
      });
  }

  private extractExplicitCertificateExpiryTimestampsFromText(
    plainText: string,
  ): number[] {
    const patterns = [
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b/gi,
    ];

    const timestamps = new Set<number>();
    for (const pattern of patterns) {
      for (const match of plainText.matchAll(pattern)) {
        if (!match[1]) {
          continue;
        }

        const timestamp = this.parseExplicitCertificateDateToken(match[1]);
        if (timestamp !== null) {
          timestamps.add(timestamp);
        }
      }
    }

    return [...timestamps].sort((left, right) => left - right);
  }

  private findMateriallyDifferentSourceProfiles(
    retrievalQuery: string,
    userQuery: string,
    profiles: SourceEvidenceProfile[],
  ): SourceEvidenceProfile[] {
    if (this.queryService.isPersonnelDirectoryQuery(userQuery)) {
      return [];
    }

    if (
      /\b1p\d{2,}\b/i.test(retrievalQuery) ||
      this.hasExplicitSourceRequest(userQuery)
    ) {
      return [];
    }

    const matchedProfiles = profiles.filter(
      (profile) =>
        profile.subjectCoverage > 0 && profile.explicitEvidenceScore > 0,
    );
    if (matchedProfiles.length < 2) return [];

    const comparisonSet = new Map<string, SourceEvidenceProfile>();
    for (let index = 0; index < matchedProfiles.length; index += 1) {
      for (
        let compareIndex = index + 1;
        compareIndex < matchedProfiles.length;
        compareIndex += 1
      ) {
        const a = matchedProfiles[index];
        const b = matchedProfiles[compareIndex];
        if (!this.isSameSubjectAcrossSources(a, b)) continue;
        if (!this.hasMaterialFactDifference(userQuery, a, b)) continue;

        comparisonSet.set(a.sourceKey, a);
        comparisonSet.set(b.sourceKey, b);
      }
    }

    return [...comparisonSet.values()].sort(
      (a, b) => b.aggregateScore - a.aggregateScore,
    );
  }

  private selectPreferredSourceKeys(
    retrievalQuery: string,
    userQuery: string,
    profiles: SourceEvidenceProfile[],
  ): string[] {
    if (profiles.length < 2) return [];
    if (this.hasExplicitSourceRequest(userQuery)) return [];

    const [top, second] = profiles;
    if (!top || !second) return [];
    if (top.subjectCoverage === 0) return [];

    const shouldPreferSingleBestSource =
      /\b1p\d{2,}\b/i.test(retrievalQuery) ||
      this.queryService.isNextDueLookupQuery(userQuery) ||
      this.queryService.isPersonnelDirectoryQuery(userQuery) ||
      this.isBroadCertificateSoonQuery(userQuery) ||
      this.queryService.isPartsQuery(userQuery) ||
      /\b(?:according\s+to|in|from)\s+the\s+.+?\b(manual|operator'?s\s+manual|handbook|guide|document)\b/i.test(
        userQuery,
      ) ||
      /\b(normal|recommended|specified|operating|range|limit|limits|spec(?:ification)?|grade|viscosity|interval|should\s+we\s+use)\b/i.test(
        userQuery,
      ) ||
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|what\s+should\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        userQuery,
      );
    if (!shouldPreferSingleBestSource) return [];

    const topClearlyStronger =
      (this.queryService.isPersonnelDirectoryQuery(userQuery) &&
        top.contactEvidenceScore >= second.contactEvidenceScore + 3 &&
        top.subjectCoverage >= second.subjectCoverage) ||
      (top.explicitEvidenceScore >= second.explicitEvidenceScore + 2 &&
        top.subjectCoverage >= second.subjectCoverage) ||
      (top.explicitEvidenceScore > 0 &&
        second.explicitEvidenceScore === 0 &&
        top.subjectCoverage >= second.subjectCoverage) ||
      (top.aggregateScore > 0 &&
        second.aggregateScore > 0 &&
        top.aggregateScore >= second.aggregateScore * 1.5 &&
        top.explicitEvidenceScore >= second.explicitEvidenceScore);

    return topClearlyStronger ? [top.sourceKey] : [];
  }

  private selectShortlistedAnswerSourceProfiles(
    retrievalQuery: string,
    userQuery: string,
    profiles: SourceEvidenceProfile[],
    shortlistedManualIds?: string[],
  ): SourceEvidenceProfile[] {
    if (profiles.length < 2 || this.hasExplicitSourceRequest(userQuery)) {
      return [];
    }

    const shortlist = new Set(
      (shortlistedManualIds ?? [])
        .map((manualId) => manualId.trim())
        .filter(Boolean),
    );
    if (shortlist.size < 2) {
      return [];
    }

    const shortlistedProfiles = profiles.filter((profile) =>
      profile.manualIds.some((manualId) => shortlist.has(manualId)),
    );
    if (shortlistedProfiles.length < 2) {
      return [];
    }

    const [topProfile, ...remainingProfiles] = shortlistedProfiles;
    if (!topProfile) {
      return [];
    }

    const selectedProfiles = [topProfile];
    for (const candidateProfile of remainingProfiles) {
      if (
        selectedProfiles.length >= 2 ||
        !this.isRelevantSecondarySourceProfile(
          retrievalQuery,
          topProfile,
          candidateProfile,
        )
      ) {
        continue;
      }

      selectedProfiles.push(candidateProfile);
    }

    return selectedProfiles;
  }

  private selectTopAnswerSourceProfiles(
    retrievalQuery: string,
    userQuery: string,
    profiles: SourceEvidenceProfile[],
  ): SourceEvidenceProfile[] {
    if (!this.shouldLimitToTopManualSources(userQuery)) {
      return [];
    }

    const subjectMatchedProfiles = profiles.filter(
      (profile) =>
        profile.subjectCoverage > 0 ||
        profile.explicitEvidenceScore > 0 ||
        profile.aggregateScore > 0,
    );
    const rankedProfiles =
      subjectMatchedProfiles.length > 0 ? subjectMatchedProfiles : profiles;
    const [topProfile, ...remainingProfiles] = rankedProfiles;
    if (!topProfile) {
      return [];
    }

    const selectedProfiles = [topProfile];
    for (const candidateProfile of remainingProfiles) {
      if (
        selectedProfiles.length >= 2 ||
        !this.isRelevantSecondarySourceProfile(
          retrievalQuery,
          topProfile,
          candidateProfile,
        )
      ) {
        continue;
      }

      selectedProfiles.push(candidateProfile);
    }

    return selectedProfiles;
  }

  private prepareBroadCertificateSoonAnswerCitations(
    userQuery: string,
    citations: ChatCitation[],
    profiles: SourceEvidenceProfile[],
  ): ChatCitation[] {
    if (!this.isBroadCertificateSoonQuery(userQuery)) {
      return [];
    }

    const certificateProfiles = profiles.filter((profile) =>
      profile.citations.some((citation) =>
        this.isStandaloneCertificateLikeCitation(citation),
      ),
    );
    if (certificateProfiles.length === 0) {
      return [];
    }

    const now = Date.now();
    const futureProfiles = certificateProfiles
      .filter((profile) =>
        profile.expiryTimestamps.some((timestamp) => timestamp >= now),
      )
      .sort((left, right) => {
        const leftSoonest =
          left.expiryTimestamps.find((timestamp) => timestamp >= now) ??
          Number.MAX_SAFE_INTEGER;
        const rightSoonest =
          right.expiryTimestamps.find((timestamp) => timestamp >= now) ??
          Number.MAX_SAFE_INTEGER;
        if (leftSoonest !== rightSoonest) {
          return leftSoonest - rightSoonest;
        }
        const leftRegistryProfile = this.isOfficialRegistryCertificateProfile(
          left,
        )
          ? 1
          : 0;
        const rightRegistryProfile = this.isOfficialRegistryCertificateProfile(
          right,
        )
          ? 1
          : 0;
        if (leftRegistryProfile !== rightRegistryProfile) {
          return leftRegistryProfile - rightRegistryProfile;
        }
        if (right.explicitEvidenceScore !== left.explicitEvidenceScore) {
          return right.explicitEvidenceScore - left.explicitEvidenceScore;
        }
        return right.aggregateScore - left.aggregateScore;
      });
    if (futureProfiles.length > 0) {
      return this.balanceCitationsAcrossSources(
        citations,
        new Set(futureProfiles.slice(0, 5).map((profile) => profile.sourceKey)),
        2,
      );
    }

    const embeddedApprovalProfiles = profiles.filter((profile) =>
      profile.citations.some((citation) =>
        this.isEmbeddedProductApprovalCitation(citation),
      ),
    );
    const futureEmbeddedProfiles = embeddedApprovalProfiles
      .filter((profile) =>
        profile.expiryTimestamps.some((timestamp) => timestamp >= now),
      )
      .sort((left, right) => {
        const leftSoonest =
          left.expiryTimestamps.find((timestamp) => timestamp >= now) ??
          Number.MAX_SAFE_INTEGER;
        const rightSoonest =
          right.expiryTimestamps.find((timestamp) => timestamp >= now) ??
          Number.MAX_SAFE_INTEGER;
        if (leftSoonest !== rightSoonest) {
          return leftSoonest - rightSoonest;
        }

        return right.explicitEvidenceScore - left.explicitEvidenceScore;
      });
    if (futureEmbeddedProfiles.length > 0) {
      return this.balanceCitationsAcrossSources(
        citations,
        new Set(
          futureEmbeddedProfiles
            .slice(0, 5)
            .map((profile) => profile.sourceKey),
        ),
        2,
      );
    }

    const datedProfiles = certificateProfiles.filter(
      (profile) => profile.expiryTimestamps.length > 0,
    );
    if (datedProfiles.length > 0) {
      return this.balanceCitationsAcrossSources(
        citations,
        new Set(datedProfiles.slice(0, 5).map((profile) => profile.sourceKey)),
        2,
      );
    }

    const datedEmbeddedProfiles = embeddedApprovalProfiles.filter(
      (profile) => profile.expiryTimestamps.length > 0,
    );
    if (datedEmbeddedProfiles.length > 0) {
      return this.balanceCitationsAcrossSources(
        citations,
        new Set(
          datedEmbeddedProfiles.slice(0, 5).map((profile) => profile.sourceKey),
        ),
        2,
      );
    }

    return [];
  }

  private filterCitationsBySourceKeys(
    citations: ChatCitation[],
    sourceKeys: Set<string>,
  ): ChatCitation[] {
    return citations.filter((citation) =>
      sourceKeys.has(this.getSourceKey(citation)),
    );
  }

  private shouldLimitToTopManualSources(userQuery: string): boolean {
    return (
      !this.queryService.isPersonnelDirectoryQuery(userQuery) &&
      !this.isBroadCertificateSoonQuery(userQuery)
    );
  }

  private isRelevantSecondarySourceProfile(
    retrievalQuery: string,
    topProfile: SourceEvidenceProfile,
    candidateProfile: SourceEvidenceProfile,
  ): boolean {
    if (candidateProfile.sourceKey === topProfile.sourceKey) {
      return false;
    }

    if (
      topProfile.subjectCoverage > 0 &&
      !this.isSameSubjectAcrossSources(topProfile, candidateProfile)
    ) {
      return false;
    }

    if (
      topProfile.subjectCoverage > 0 &&
      candidateProfile.subjectCoverage === 0 &&
      candidateProfile.explicitEvidenceScore < topProfile.explicitEvidenceScore
    ) {
      return false;
    }

    if (
      /\b1p\d{2,}\b/i.test(retrievalQuery) &&
      candidateProfile.subjectCoverage < topProfile.subjectCoverage
    ) {
      return false;
    }

    if (
      topProfile.explicitEvidenceScore >=
        candidateProfile.explicitEvidenceScore + 4 &&
      topProfile.subjectCoverage >= candidateProfile.subjectCoverage + 1 &&
      topProfile.aggregateScore >= candidateProfile.aggregateScore * 1.75
    ) {
      return false;
    }

    return (
      candidateProfile.explicitEvidenceScore > 0 ||
      candidateProfile.subjectCoverage > 0 ||
      candidateProfile.aggregateScore >=
        Math.max(topProfile.aggregateScore * 0.45, 1)
    );
  }

  private isOfficialRegistryCertificateProfile(
    profile: SourceEvidenceProfile,
  ): boolean {
    return profile.citations.some((citation) =>
      this.isOfficialRegistryCertificateCitation(citation),
    );
  }

  private balanceCitationsAcrossSources(
    citations: ChatCitation[],
    sourceKeys: Set<string>,
    perSourceLimit: number,
  ): ChatCitation[] {
    const grouped = new Map<string, ChatCitation[]>();
    for (const citation of citations) {
      const sourceKey = this.getSourceKey(citation);
      if (!sourceKeys.has(sourceKey)) continue;
      const existing = grouped.get(sourceKey) ?? [];
      existing.push(citation);
      grouped.set(sourceKey, existing);
    }

    const balanced: ChatCitation[] = [];
    for (const sourceKey of sourceKeys) {
      const sourceCitations = grouped.get(sourceKey) ?? [];
      balanced.push(...sourceCitations.slice(0, perSourceLimit));
    }

    return balanced.length > 0 ? balanced : citations;
  }

  private getCitationIdentity(citation: ChatCitation): string {
    return [
      citation.chunkId ?? '',
      citation.pageNumber ?? '',
      citation.sourceTitle ?? '',
      citation.snippet ?? '',
    ].join('::');
  }

  private getSourceKey(citation: ChatCitation): string {
    return (
      this.queryService.normalizeSourceTitleHint(citation.sourceTitle) ??
      citation.sourceTitle ??
      'unknown-source'
    ).toLowerCase();
  }

  private extractUniqueMatches(
    text: string,
    pattern: RegExp,
    captureGroupIndex?: number,
  ): string[] {
    const matches = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      const value =
        captureGroupIndex !== undefined ? match[captureGroupIndex] : match[0];
      const normalized = value?.replace(/\s+/g, ' ').trim();
      if (normalized) {
        matches.add(normalized.toLowerCase());
      }
    }
    return [...matches];
  }

  private countNonEmptyArrays(values: string[][]): number {
    return values.filter((value) => value.length > 0).length;
  }

  private isSameSubjectAcrossSources(
    a: SourceEvidenceProfile,
    b: SourceEvidenceProfile,
  ): boolean {
    return Math.min(a.subjectCoverage, b.subjectCoverage) > 0;
  }

  private hasMaterialFactDifference(
    userQuery: string,
    a: SourceEvidenceProfile,
    b: SourceEvidenceProfile,
  ): boolean {
    if (this.queryService.isPersonnelDirectoryQuery(userQuery)) {
      if (this.hasConflictingValueSet(a.emailValues, b.emailValues)) {
        return true;
      }
      if (this.hasConflictingValueSet(a.phoneValues, b.phoneValues)) {
        return true;
      }
    }

    if (this.hasConflictingValueSet(a.intervalValues, b.intervalValues)) {
      return true;
    }
    if (this.hasConflictingValueSet(a.nextDueValues, b.nextDueValues)) {
      return true;
    }
    if (this.hasConflictingValueSet(a.nextDueDates, b.nextDueDates)) {
      return true;
    }
    if (this.hasConflictingValueSet(a.lastDueValues, b.lastDueValues)) {
      return true;
    }
    if (this.hasConflictingValueSet(a.oilSpecs, b.oilSpecs)) {
      return true;
    }
    if (this.hasConflictingValueSet(a.capacityValues, b.capacityValues)) {
      return true;
    }

    if (this.queryService.isPartsQuery(userQuery)) {
      if (this.hasConflictingValueSet(a.partNumbers, b.partNumbers)) {
        return true;
      }
      if (this.hasConflictingValueSet(a.quantityValues, b.quantityValues)) {
        return true;
      }
    }

    return false;
  }

  private hasConflictingValueSet(a: string[], b: string[]): boolean {
    if (a.length === 0 || b.length === 0) return false;

    const setA = new Set(a);
    const setB = new Set(b);
    if (
      setA.size === setB.size &&
      [...setA].every((value) => setB.has(value))
    ) {
      return false;
    }

    return true;
  }

  private hasExplicitSourceRequest(query: string): boolean {
    return /\b(?:according\s+to|from|in)\s+the\s+.+?\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document)\b/i.test(
      query,
    );
  }

  private stripHtmlLikeMarkup(snippet: string): string {
    return snippet
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
