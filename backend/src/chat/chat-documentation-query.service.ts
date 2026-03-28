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
    return (
      /^\s*(hi|hello|hey|thanks|thank you|ok|okay|great)\s*[!.?]*\s*$/i.test(
        userQuery,
      ) || this.isTelemetryListQuery(userQuery)
    );
  }

  getPreviousResolvedUserQuery(messages?: ChatHistoryMessage[]): string | null {
    if (!messages?.length) return null;

    let skippedLatestUser = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user') {
        if (!skippedLatestUser) {
          skippedLatestUser = true;
          continue;
        }

        const content = message.content?.trim();
        if (content) return content;
        continue;
      }

      if (message.role !== 'assistant') continue;

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
    }

    return null;
  }

  getPendingClarificationQuery(messages?: ChatHistoryMessage[]): string | null {
    if (!messages?.length) return null;

    let skippedLatestUser = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (message.role === 'user') {
        if (!skippedLatestUser) {
          skippedLatestUser = true;
          continue;
        }

        return null;
      }

      if (message.role !== 'assistant') continue;

      const ragflowContext =
        message.ragflowContext && typeof message.ragflowContext === 'object'
          ? (message.ragflowContext as Record<string, unknown>)
          : null;
      const pendingClarificationQuery =
        ragflowContext?.pendingClarificationQuery;
      const awaitingClarification = ragflowContext?.awaitingClarification;

      if (
        awaitingClarification === true &&
        typeof pendingClarificationQuery === 'string' &&
        pendingClarificationQuery.trim()
      ) {
        return pendingClarificationQuery.trim();
      }

      return null;
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
      (!this.isContextualFollowUpQuery(trimmed) &&
        !this.shouldInheritPreviousSubject(trimmed, previousUserQuery)) ||
      this.isSelfContainedSubjectQuery(trimmed)
    ) {
      return trimmed;
    }

    const followUpSubject = this.extractFollowUpSubject(previousUserQuery);
    if (!followUpSubject) return trimmed;

    return `${followUpSubject} ${trimmed}`.trim();
  }

  buildClarificationResolvedQuery(
    pendingClarificationQuery: string,
    clarificationReply: string,
  ): string {
    const base = pendingClarificationQuery.trim().replace(/[?!.]+$/g, '');
    const reply = clarificationReply.trim().replace(/\s+/g, ' ');
    if (!base) return reply;
    if (!reply) return base;
    return `${base} ${reply}`.replace(/\s+/g, ' ').trim();
  }

  shouldTreatAsClarificationReply(
    userQuery: string,
    pendingClarificationQuery: string | null,
  ): boolean {
    if (!pendingClarificationQuery?.trim()) return false;

    const trimmed = userQuery.trim();
    if (!trimmed) return false;
    if (this.shouldSkipDocumentationRetrieval(trimmed)) return false;

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 8 && !this.looksLikeFreshQuestion(trimmed)) {
      return true;
    }

    return false;
  }

  shouldAskClarifyingQuestion(params: {
    userQuery: string;
    retrievalQuery: string;
    previousUserQuery: string | null;
    pendingClarificationQuery: string | null;
  }): boolean {
    const {
      userQuery,
      retrievalQuery,
      previousUserQuery,
      pendingClarificationQuery,
    } = params;
    const trimmed = userQuery.trim();
    if (!trimmed) return false;
    if (this.shouldSkipDocumentationRetrieval(trimmed)) return false;

    if (this.shouldTreatAsClarificationReply(trimmed, pendingClarificationQuery)) {
      return false;
    }

    if (/\b1p\d{2,}\b/i.test(retrievalQuery)) return false;
    if (this.hasExplicitSourceRequest(retrievalQuery)) return false;
    if (this.isDirectLookupSubjectQuery(retrievalQuery)) return false;

    if (
      previousUserQuery &&
      this.isContextualFollowUpQuery(trimmed) &&
      this.isSelfContainedSubjectQuery(previousUserQuery)
    ) {
      return false;
    }

    if (this.hasStrongSpecificAnchor(retrievalQuery)) {
      return false;
    }

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const disambiguatingTerms =
      this.extractDisambiguatingSubjectTerms(retrievalQuery);
    const broadIntent = this.isBroadActionOrLookupQuery(trimmed);
    const nextDueLookup = this.isNextDueLookupQuery(trimmed);
    const qualifiedProcedureTarget =
      this.isProcedureQuery(trimmed) &&
      this.hasQualifiedComponentPhrase(retrievalQuery);

    if (qualifiedProcedureTarget) {
      return false;
    }

    if (nextDueLookup) {
      return disambiguatingTerms.length === 0;
    }

    if (broadIntent && disambiguatingTerms.length === 0) {
      return true;
    }

    if (broadIntent && wordCount <= 3 && disambiguatingTerms.length <= 1) {
      return true;
    }

    if (wordCount <= 3 && disambiguatingTerms.length === 0) {
      return true;
    }

    return false;
  }

  buildClarificationQuestion(userQuery: string): string {
    const lowered = userQuery.toLowerCase();

    if (this.isNextDueLookupQuery(userQuery)) {
      return 'Which exact asset, component, maintenance task, or reference ID do you want next-due information for? If you can, include the asset name or side so I can match the correct schedule row.';
    }

    if (/\b(oil|coolant|fluid|fluids?)\b/i.test(lowered)) {
      return 'Which exact component or system is this fluid-related request for? If you can, include the asset name or side, the component, task title, or reference ID.';
    }

    if (/\b(parts?|spares?|filters?|part\s*numbers?|consumables?)\b/i.test(lowered)) {
      return 'Which exact component, system, or maintenance task is this parts request for? If you have it, include the asset name or side, task title, or reference ID.';
    }

    if (
      /\b(fault|alarm|error|troubleshoot|issue|problem|not\s+working|failure)\b/i.test(
        lowered,
      )
    ) {
      return 'Which exact component or system has this issue? If you can, include the asset name or side, the component, and any reference ID or alarm label.';
    }

    if (/\b(status|telemetry|running\s+hours|runtime|hour\s*meter)\b/i.test(lowered)) {
      return 'Which exact asset or component do you want this status for? If you can, include the asset name or side, the component, or a reference ID.';
    }

    return 'Which exact component, system, task, or reference ID is this for? If you can, include the asset name or side so I can look up the correct documentation.';
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
      'runtime',
      'meter',
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
    const hasExplicitPartsIntent =
      /\b(parts?|spares?|part\s*numbers?|consumables?|quantit(?:y|ies)|locations?|manufacturer\s*part|supplier\s*part)\b/i.test(
        query,
      );
    if (hasExplicitPartsIntent) {
      return true;
    }

    if (this.isProcedureQuery(query)) {
      return false;
    }

    return (
      /\b(oil|coolant|fluid|fluids?)\b/i.test(query) &&
      /\b(quantity|quantities|capacity|capacities|grade|viscosity|available|onboard|how\s+much|how\s+many|need|order)\b/i.test(
        query,
      )
    );
  }

  isProcedureQuery(query: string): boolean {
    return /\b(procedure|steps?|how\s+to|how\s+do\s+i|instruction|instructions|checklist|perform|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|what\s+should\s+be\s+done)\b/i.test(
      query,
    );
  }

  isTelemetryListQuery(query: string): boolean {
    return (
      /\b(show|list|display|give|return|output)\b/i.test(query) &&
      /\b(metrics?|telemetry|readings?|values?)\b/i.test(query) &&
      /\b(active|connected|enabled|current|random|\d{1,2})\b/i.test(query)
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
      this.isProcedureQuery(userQuery) ||
      /\b(tasks?|included|include|replace|inspect|clean|check|adjust|overhaul|sample|test)\b/i.test(
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

    if (this.isNextDueLookupQuery(userQuery)) {
      return `${assetFocus}. Focus on task name, reference ID, interval, last due and next due in the maintenance schedule.`;
    }

    if (this.isProcedureQuery(userQuery)) {
      return `${assetFocus}. Focus on the documented maintenance schedule task list and included work items.`;
    }

    if (this.isPartsQuery(userQuery)) {
      return `${assetFocus}. Focus on spare name, quantity, location, manufacturer part number and supplier part number for the maintenance schedule row.`;
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

    if (
      this.isProcedureQuery(userQuery) ||
      this.isPartsQuery(userQuery) ||
      /\b(maintenance|service|tasks?|included)\b/i.test(userQuery)
    ) {
      const engineSide = directionalSide === 'port' ? 'PS ENGINE' : 'SB ENGINE';
      queries.add(`${engineSide} MAIN GENERATOR maintenance schedule`);
      queries.add(`0212 ENGINES ${engineSide} MAIN GENERATOR`);
      queries.add(
        `${assetFocus}. Focus on the exact maintenance schedule row, included work items, and spare-parts table for this generator asset.`,
      );

      const focusTerms = this.extractGeneratorMaintenanceFocusTerms(
        `${retrievalQuery} ${userQuery}`,
      );
      for (const focusTerm of focusTerms) {
        queries.add(`${engineSide} MAIN GENERATOR ${focusTerm} maintenance schedule`);
        queries.add(
          `${assetFocus}. Focus on ${focusTerm} work items, task lines, and spare-parts rows for this generator asset.`,
        );
      }
    }

    return [...queries];
  }

  detectDirectionalSide(query: string): 'port' | 'starboard' | null {
    if (/\b(port(?:\s+side)?|portside|ps|left(?:\s+side)?)\b/i.test(query)) {
      return 'port';
    }

    if (/\b(starboard(?:\s+side)?|starboardside|sb|stbd|right(?:\s+side)?)\b/i.test(query)) {
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

    return (
      this.isNextDueLookupQuery(userQuery) ||
      this.isProcedureQuery(userQuery) ||
      this.isPartsQuery(userQuery) ||
      /\b(maintenance|service|tasks?|included)\b/i.test(userQuery)
    );
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
    const wantsProcedure = this.isProcedureQuery(userQuery);
    const wantsManualSpecification = this.isManualSpecificationQuery(userQuery);

    if (isExactReference) {
      return { topK: 72, candidateK: 216 };
    }

    if (wantsExhaustiveList) {
      return { topK: 48, candidateK: 144 };
    }

    if (wantsParts || wantsProcedure || wantsNextDue) {
      return { topK: 24, candidateK: 72 };
    }

    if (wantsManualSpecification) {
      return { topK: 16, candidateK: 48 };
    }

    return {
      topK: DEFAULT_RAGFLOW_CONTEXT_TOP_K,
      candidateK: Math.max(DEFAULT_RAGFLOW_CONTEXT_TOP_K * 3, 24),
    };
  }

  isNextDueLookupQuery(query: string): boolean {
    return /\b(next\s+due|what\s+is\s+next\s+due|next\s+due\s+value|when\s+is\s+.*(?:maintenance|service).*\sdue|what\s+is\s+the\s+next\s+(maintenance|service)|what\s+(maintenance|service)\s+is\s+next)\b/i.test(
      query,
    ) || /\bwhen\s+(?:is|will)\s+.+\b(?:maintenance|service|oil\s+change|filter(?:\s+change)?|inspection|overhaul|greasing|grease|calibration|cleaning)\b.+\bdue\b/i.test(
      query,
    );
  }

  private isManualSpecificationQuery(query: string): boolean {
    return (
      /\b(?:according\s+to|in|from)\s+the\s+.+?\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document)\b/i.test(
        query,
      ) ||
      /\b(normal|recommended|specified|operating)\b[\s\S]{0,40}\b(range|limit|limits|grade|viscosity|temperature|pressure|oil)\b/i.test(
        query,
      ) ||
      /\b(range|limit|limits|grade|viscosity|capacity|torque|spec(?:ification)?)\b[\s\S]{0,40}\b(?:manual|handbook|guide|volvo|mase)\b/i.test(
        query,
      )
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

  private shouldInheritPreviousSubject(
    query: string,
    previousUserQuery: string,
  ): boolean {
    if (!query.trim() || !previousUserQuery.trim()) return false;
    if (this.hasStrongSpecificAnchor(query)) return false;
    if (!this.hasStrongSpecificAnchor(previousUserQuery)) return false;

    return this.isBroadContinuationQuery(query);
  }

  private hasExplicitSourceRequest(query: string): boolean {
    return /\b(?:according\s+to|from|in)\s+the\s+.+?\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document)\b/i.test(
      query,
    );
  }

  private hasStrongSpecificAnchor(query: string): boolean {
    const disambiguatingTerms = this.extractDisambiguatingSubjectTerms(query);
    if (disambiguatingTerms.length >= 2) return true;

    if (
      /\b(reference\s*id|port|starboard|portside|starboardside|ps|sb|stbd|box\s+\d+|p\/n|part\s*#|serial|model)\b/i.test(
        query,
      )
    ) {
      return true;
    }

    return false;
  }

  private hasQualifiedComponentPhrase(query: string): boolean {
    const normalized = query
      .toLowerCase()
      .replace(/[^a-z0-9\s/-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) return false;

    const componentTokens = new Set([
      'filter',
      'filters',
      'pump',
      'pumps',
      'impeller',
      'impellers',
      'generator',
      'generators',
      'genset',
      'gensets',
      'engine',
      'engines',
      'belt',
      'belts',
      'anode',
      'anodes',
      'cooler',
      'coolers',
      'strainer',
      'strainers',
      'compressor',
      'compressors',
      'watermaker',
      'watermakers',
      'cartridge',
      'cartridges',
      'valve',
      'valves',
      'sensor',
      'sensors',
      'thermostat',
      'thermostats',
    ]);
    const qualifierTokens = new Set([
      'oil',
      'fuel',
      'air',
      'coolant',
      'sea',
      'seawater',
      'water',
      'fresh',
      'freshwater',
      'raw',
      'aux',
      'auxiliary',
      'alternator',
      'drive',
      'intake',
      'outlet',
      'suction',
      'pressure',
      'temperature',
      'zinc',
      'sacrificial',
      'exhaust',
      'bypass',
      'prefilter',
      'pre-filter',
    ]);
    const tokens = normalized.split(/\s+/).filter(Boolean);

    for (let index = 0; index < tokens.length; index += 1) {
      if (!componentTokens.has(tokens[index])) continue;

      const previous = tokens[index - 1];
      const previousPrevious = tokens[index - 2];
      const next = tokens[index + 1];

      if (
        (previous && qualifierTokens.has(previous)) ||
        (previousPrevious && qualifierTokens.has(previousPrevious)) ||
        (next && qualifierTokens.has(next))
      ) {
        return true;
      }
    }

    return false;
  }

  private looksLikeFreshQuestion(query: string): boolean {
    return (
      query.includes('?') ||
      /\b(what|when|where|why|how|which|show|list|give|find|tell|explain)\b/i.test(
        query,
      )
    );
  }

  private isBroadContinuationQuery(query: string): boolean {
    const trimmed = query.trim();
    if (
      /^(?:tasks?|spares?|parts?|procedure|steps?|tasks?\s+and\s+(?:spare\s+)?parts?)\b/i.test(
        trimmed,
      )
    ) {
      return true;
    }

    return /\b(when\s+should\s+we\s+do\s+next\s+maintenance|when\s+is\s+the\s+next\s+maintenance|what\s+maintenance\s+is\s+(?:next|due)|what\s+service\s+is\s+(?:next|due)|what\s+maintenance\s+is\s+last\s+due|what\s+service\s+is\s+last\s+due|last\s+due|next\s+due|next\s+maintenance|next\s+service|what\s+tasks?\s+are\s+included|what\s+(?:spare\s+)?parts?\s+are\s+(?:needed|required|listed)|how\s+do\s+i|how\s+to|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
      query,
    );
  }

  private isBroadActionOrLookupQuery(query: string): boolean {
    return /\b(how\s+to|how\s+do\s+i|what\s+should\s+i\s+do|what\s+do\s+i\s+do|replace|change|clean|inspect|check|adjust|test|sample|overhaul|service|maintain|parts?|spares?|oil|coolant|fluid|filter|filters|troubleshoot|fault|alarm|error|issue|problem|status|telemetry|runtime|running\s+hours|next\s+due|when\s+is\s+.*(?:maintenance|service).*\sdue|when\s+should\s+we\s+do\s+next\s+(?:maintenance|service)|remaining\s+hours|hours\s+until\s+next)\b/i.test(
      query,
    );
  }

  private extractDisambiguatingSubjectTerms(query: string): string[] {
    const genericTerms = new Set([
      'what',
      'when',
      'where',
      'why',
      'how',
      'which',
      'show',
      'list',
      'give',
      'find',
      'tell',
      'explain',
      'help',
      'replace',
      'change',
      'clean',
      'inspect',
      'check',
      'adjust',
      'test',
      'sample',
      'overhaul',
      'service',
      'maintenance',
      'maintain',
      'next',
      'last',
      'due',
      'procedure',
      'procedures',
      'steps',
      'task',
      'tasks',
      'part',
      'parts',
      'spare',
      'spares',
      'consumable',
      'consumables',
      'oil',
      'coolant',
      'fluid',
      'fluids',
      'filter',
      'filters',
      'impeller',
      'belt',
      'belts',
      'battery',
      'batteries',
      'anode',
      'anodes',
      'zinc',
      'valve',
      'valves',
      'seal',
      'seals',
      'sensor',
      'sensors',
      'pump',
      'pumps',
      'engine',
      'engines',
      'generator',
      'generators',
      'genset',
      'gensets',
      'gearbox',
      'gearboxes',
      'transmission',
      'transmissions',
      'status',
      'telemetry',
      'runtime',
      'running',
      'hours',
      'hour',
      'meter',
      'issue',
      'issues',
      'problem',
      'problems',
      'fault',
      'faults',
      'alarm',
      'alarms',
      'error',
      'errors',
      'working',
      'not',
      'do',
      'does',
      'did',
      'is',
      'are',
      'should',
      'would',
      'could',
      'can',
      'need',
      'needs',
      'needed',
      'require',
      'required',
      'listed',
      'for',
      'from',
      'with',
      'into',
      'onto',
      'this',
      'that',
      'these',
      'those',
      'same',
      'exact',
      'asset',
      'component',
      'system',
      'reference',
      'id',
      'the',
      'a',
      'an',
      'in',
      'on',
      'to',
      'of',
      'my',
      'our',
      'your',
      'i',
      'we',
      'you',
    ]);

    return [
      ...new Set(
        query
          .toLowerCase()
          .replace(/[^a-z0-9\s/-]/g, ' ')
          .split(/\s+/)
          .map((term) => term.trim())
          .filter(Boolean)
          .filter((term) => term.length >= 2)
          .filter((term) => !genericTerms.has(term))
          .filter((term) => !/^\d+$/.test(term)),
      ),
    ];
  }

  private extractFollowUpSubject(previousUserQuery: string): string | null {
    const subjectTerms = this.extractRetrievalSubjectTerms(previousUserQuery);
    if (subjectTerms.length === 0) return null;
    return subjectTerms.join(' ');
  }

  private isSelfContainedSubjectQuery(query: string): boolean {
    if (/\b1p\d{2,}\b/i.test(query)) return true;
    return /\b(generator|genset|engine|pump|compressor|watermaker|manual|filter|alarm|fault|error|telemetry)\b/i.test(
      query,
    );
  }

  private isDirectLookupSubjectQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || trimmed.includes('?')) return false;
    if (/\b(?:reference\s*id\s*)?1p\d{2,}\b/i.test(trimmed)) return true;

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 10) return false;

    return /\b(service|maintenance|task|annual|biennial|monthly|weekly|daily|hrs?|hours?|overhaul|inspection|engine|generator|genset|pump|filter|filters|compressor|watermaker|reference\s*id)\b/i.test(
      trimmed,
    );
  }

  private extractGeneratorMaintenanceFocusTerms(query: string): string[] {
    const normalized = query.toLowerCase();
    const terms: string[] = [];

    if (/\boil\b/.test(normalized) && /\bfilters?\b/.test(normalized)) {
      terms.push('replace oil and filters');
    }
    if (/\bfuel\b/.test(normalized) && /\bfilters?\b/.test(normalized)) {
      terms.push('fuel prefilter and filter');
    }

    const genericPatterns: Array<[RegExp, string]> = [
      [/\boil\b/i, 'oil'],
      [/\bcoolant\b/i, 'coolant'],
      [/\bfuel\b/i, 'fuel'],
      [/\bair\b/i, 'air filter'],
      [/\bfilters?\b/i, 'filter'],
      [/\bbelts?\b/i, 'belt'],
      [/\bimpeller\b/i, 'impeller'],
      [/\banodes?\b|\bzincs?\b/i, 'anode'],
      [/\bpump\b/i, 'pump'],
      [/\bsea\s*water\b/i, 'sea water'],
      [/\bthermostat\b/i, 'thermostat'],
      [/\bsample\b/i, 'sample'],
      [/\bvalves?\b|\bclearance\b/i, 'valve clearance'],
    ];

    for (const [pattern, term] of genericPatterns) {
      if (pattern.test(normalized) && !terms.includes(term)) {
        terms.push(term);
      }
    }

    return terms.slice(0, 4);
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
