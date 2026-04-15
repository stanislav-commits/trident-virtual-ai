import { Injectable } from '@nestjs/common';
import {
  isGreetingOnlyQuery,
  isThanksOnlyQuery,
  localizeChatText,
} from './chat-language.utils';
import {
  ChatCitation,
  ChatClarificationDomain,
  ChatClarificationField,
  ChatClarificationState,
  ChatHistoryMessage,
  ChatNormalizedQuery,
} from './chat.types';

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
      isGreetingOnlyQuery(userQuery) ||
      isThanksOnlyQuery(userQuery) ||
      /^\s*(ok|okay|great)\s*[!.?]*\s*$/i.test(userQuery) ||
      this.isTelemetryListQuery(userQuery) ||
      this.isExplicitTelemetrySourceQuery(userQuery)
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
      const followUpQuery = this.extractAssistantFollowUpQuery(ragflowContext);
      if (followUpQuery) {
        return followUpQuery;
      }
    }

    return null;
  }

  private extractAssistantFollowUpQuery(
    ragflowContext: Record<string, unknown> | null,
  ): string | null {
    if (!ragflowContext) {
      return null;
    }

    const telemetryFollowUpQuery =
      typeof ragflowContext.telemetryFollowUpQuery === 'string' &&
      ragflowContext.telemetryFollowUpQuery.trim()
        ? ragflowContext.telemetryFollowUpQuery.trim()
        : null;
    const resolvedSubjectQuery =
      typeof ragflowContext.resolvedSubjectQuery === 'string' &&
      ragflowContext.resolvedSubjectQuery.trim()
        ? ragflowContext.resolvedSubjectQuery.trim()
        : null;
    const candidate = telemetryFollowUpQuery ?? resolvedSubjectQuery;
    if (!candidate) {
      return null;
    }

    const normalizedQuery =
      ragflowContext.normalizedQuery &&
      typeof ragflowContext.normalizedQuery === 'object'
        ? (ragflowContext.normalizedQuery as ChatNormalizedQuery)
        : undefined;

    return this.hydrateAssistantFollowUpQuery(candidate, normalizedQuery);
  }

  private hydrateAssistantFollowUpQuery(
    query: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): string {
    let hydrated = query.trim();
    if (!hydrated) {
      return hydrated;
    }

    hydrated = this.ensureAggregateStoredFluidLevelTankContext(hydrated);

    if (normalizedQuery?.operation) {
      hydrated = this.applyAggregateOperationHint(
        hydrated,
        normalizedQuery.operation,
      );
      if (
        normalizedQuery.operation === 'sum' ||
        normalizedQuery.operation === 'average' ||
        normalizedQuery.operation === 'min' ||
        normalizedQuery.operation === 'max'
      ) {
        hydrated = this.buildAggregateContinuationQuery(hydrated);
      }
    }

    if (
      normalizedQuery?.timeIntent?.kind === 'current' &&
      !/\b(current|currently|now|right now|latest|live)\b/i.test(hydrated)
    ) {
      hydrated = this.composeTemporalContinuationQuery(
        this.stripHistoricalContinuationTime(hydrated)
          .replace(/\b(?:was|were)\b/gi, 'is')
          .replace(/\s+/g, ' ')
          .trim(),
        'right now',
      );
    }

    return hydrated;
  }

  private applyAggregateOperationHint(
    query: string,
    operation: ChatNormalizedQuery['operation'],
  ): string {
    if (
      operation !== 'sum' &&
      operation !== 'average' &&
      operation !== 'min' &&
      operation !== 'max'
    ) {
      return query;
    }

    const normalized = query.trim();
    if (!normalized) {
      return normalized;
    }

    const existingPattern =
      operation === 'sum'
        ? /\b(how much|how many|total|sum|overall|combined|together)\b/i
        : operation === 'average'
          ? /\b(average|avg|mean)\b/i
          : operation === 'min'
            ? /\b(min|minimum|lowest|smallest|least)\b/i
            : /\b(max|maximum|highest|peak|largest|greatest)\b/i;
    if (existingPattern.test(normalized)) {
      return normalized;
    }

    const stripped = normalized
      .replace(
        /^(?:what\s+(?:is|was|are|were)|show(?:\s+me)?|list|display|give(?:\s+me)?|tell(?:\s+me)?|provide)\s+/i,
        '',
      )
      .replace(/^the\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const base = stripped || normalized;
    const prefix =
      operation === 'sum'
        ? 'how much total'
        : operation === 'average'
          ? 'average'
          : operation === 'min'
            ? 'minimum'
            : 'maximum';

    return `${prefix} ${base}`.replace(/\s+/g, ' ').trim();
  }

  getPendingClarificationQuery(messages?: ChatHistoryMessage[]): string | null {
    return this.getPendingClarificationState(messages)?.pendingQuery ?? null;
  }

  getPendingClarificationState(
    messages?: ChatHistoryMessage[],
  ): ChatClarificationState | null {
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
      const awaitingClarification = ragflowContext?.awaitingClarification;

      if (awaitingClarification === true) {
        return this.extractClarificationState(ragflowContext);
      }

      return null;
    }

    return null;
  }

  buildClarificationState(params: {
    clarificationDomain: ChatClarificationDomain;
    pendingQuery: string;
    normalizedQuery?: ChatNormalizedQuery;
    clarificationReason?: string;
    resolvedSubjectQuery?: string;
    requiredFields?: ChatClarificationField[];
    resolvedFields?: Partial<Record<ChatClarificationField, string>>;
  }): ChatClarificationState {
    const pendingQuery = params.pendingQuery.trim();
    const requiredFields =
      params.requiredFields?.filter((field) => field.trim()) ??
      this.deriveRequiredClarificationFields(params);
    const resolvedFields = {
      ...this.deriveResolvedClarificationFields(params.normalizedQuery),
      ...(params.resolvedFields ?? {}),
    };
    const resolvedSubjectQuery = params.resolvedSubjectQuery?.trim();

    return {
      clarificationDomain: params.clarificationDomain,
      pendingQuery,
      ...(requiredFields.length > 0 ? { requiredFields } : {}),
      ...(Object.keys(resolvedFields).length > 0 ? { resolvedFields } : {}),
      ...(resolvedSubjectQuery ? { resolvedSubjectQuery } : {}),
    };
  }

  resolveClarificationState(
    clarificationState: ChatClarificationState,
    clarificationReply: string,
  ): ChatClarificationState {
    const resolvedFields = {
      ...(clarificationState.resolvedFields ?? {}),
    } as Partial<Record<ChatClarificationField, string>>;
    const normalizedTimeReply =
      this.normalizeHistoricalTimeReply(clarificationReply);
    if (normalizedTimeReply) {
      resolvedFields.time_of_day = normalizedTimeReply;
    }

    const normalizedDateReply =
      this.normalizeHistoricalDateReply(clarificationReply);
    if (normalizedDateReply) {
      resolvedFields.date = normalizedDateReply;
    }

    const normalizedYearReply =
      this.normalizeHistoricalYearReply(clarificationReply);
    if (normalizedYearReply) {
      resolvedFields.year = normalizedYearReply;
    }

    return {
      ...clarificationState,
      ...(Object.keys(resolvedFields).length > 0 ? { resolvedFields } : {}),
    };
  }

  buildRetrievalQuery(
    userQuery: string,
    previousUserQuery: string | null,
  ): string {
    const trimmed = userQuery.trim();
    if (!trimmed) return trimmed;
    const normalizedPreviousUserQuery = previousUserQuery?.trim() ?? '';

    if (
      normalizedPreviousUserQuery &&
      this.isTemporalRangeFollowUpQuery(trimmed) &&
      this.isAnalyticalContinuationContext(normalizedPreviousUserQuery)
    ) {
      return this.buildTemporalContinuationQuery(
        normalizedPreviousUserQuery,
        trimmed,
      );
    }

    if (
      normalizedPreviousUserQuery &&
      this.isExplicitCurrentTimeFollowUpQuery(trimmed) &&
      this.hasHistoricalTimeAnchor(normalizedPreviousUserQuery)
    ) {
      return this.composeTemporalContinuationQuery(
        this.normalizeCurrentTimeContinuationSubject(
          normalizedPreviousUserQuery,
        ),
        'right now',
      );
    }

    const normalizedPersonnelQuery =
      this.buildPersonnelDirectoryRetrievalQuery(trimmed);
    if (normalizedPersonnelQuery) {
      return normalizedPersonnelQuery;
    }

    const normalizedRoleDescriptionQuery =
      this.buildRoleDescriptionRetrievalQuery(trimmed);
    if (normalizedRoleDescriptionQuery) {
      return normalizedRoleDescriptionQuery;
    }

    if (
      normalizedPreviousUserQuery &&
      this.isLowInformationContinuationQuery(trimmed)
    ) {
      return normalizedPreviousUserQuery;
    }

    if (normalizedPreviousUserQuery && this.isSummaryFollowUpQuery(trimmed)) {
      return normalizedPreviousUserQuery;
    }

    if (
      normalizedPreviousUserQuery &&
      this.isContinuationRefinementFragment(trimmed) &&
      this.isAnalyticalContinuationContext(normalizedPreviousUserQuery)
    ) {
      return `${normalizedPreviousUserQuery.replace(/[?!.]+$/g, '')} ${trimmed}`
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (
      normalizedPreviousUserQuery &&
      this.isAggregateContinuationFollowUpQuery(trimmed) &&
      this.isAggregateContinuationContext(normalizedPreviousUserQuery)
    ) {
      return this.buildAggregateContinuationQuery(normalizedPreviousUserQuery);
    }

    const sourceScopeFollowUp = this.isSourceScopeFollowUpQuery(trimmed);
    const completenessFollowUp = this.isCompletenessVerificationFollowUpQuery(
      trimmed,
      normalizedPreviousUserQuery,
    );
    const shouldCarryPreviousSubject =
      Boolean(normalizedPreviousUserQuery) &&
      (!this.isSelfContainedSubjectQuery(trimmed) ||
        sourceScopeFollowUp ||
        completenessFollowUp) &&
      (this.isContextualFollowUpQuery(trimmed) ||
        this.shouldInheritPreviousSubject(
          trimmed,
          normalizedPreviousUserQuery,
        ) ||
        this.isSubjectDetailFollowUpQuery(trimmed) ||
        completenessFollowUp ||
        sourceScopeFollowUp);

    if (!normalizedPreviousUserQuery || !shouldCarryPreviousSubject) {
      return trimmed;
    }

    const normalizedFollowUp = this.normalizeInheritedFollowUpQuery(
      trimmed,
      normalizedPreviousUserQuery,
    );
    const followUpSubject = this.resolveInheritedFollowUpSubject({
      previousUserQuery: normalizedPreviousUserQuery,
      currentUserQuery: trimmed,
      completenessFollowUp,
    });
    if (!followUpSubject) return trimmed;
    return this.mergeFollowUpSubjectAndReply(
      followUpSubject,
      normalizedFollowUp || trimmed,
    );
  }

  shouldPromoteRetrievalQueryToAnswerQuery(
    userQuery: string,
    previousUserQuery: string | null,
    retrievalQuery: string,
  ): boolean {
    const trimmed = userQuery.trim();
    const normalizedRetrievalQuery = retrievalQuery.trim();
    if (
      !trimmed ||
      !previousUserQuery ||
      !normalizedRetrievalQuery ||
      normalizedRetrievalQuery.toLowerCase() === trimmed.toLowerCase()
    ) {
      return false;
    }

    return (
      this.isLowInformationContinuationQuery(trimmed) ||
      (this.isTemporalRangeFollowUpQuery(trimmed) &&
        this.isAnalyticalContinuationContext(previousUserQuery)) ||
      (this.isContinuationRefinementFragment(trimmed) &&
        this.isAnalyticalContinuationContext(previousUserQuery)) ||
      this.isSubjectDetailFollowUpQuery(trimmed) ||
      this.isCompletenessVerificationFollowUpQuery(
        trimmed,
        previousUserQuery,
      ) ||
      this.isSourceScopeFollowUpQuery(trimmed)
    );
  }

  shouldUseDocumentationFollowUpState(
    userQuery: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): boolean {
    if (
      normalizedQuery?.followUpMode === 'follow_up' ||
      normalizedQuery?.followUpMode === 'clarification_reply'
    ) {
      return true;
    }

    const trimmed = userQuery.trim();
    if (!trimmed) {
      return false;
    }

    if (this.isGenericDocumentationDetailFollowUp(trimmed)) {
      return true;
    }

    if (this.isLowInformationContinuationQuery(trimmed)) {
      return true;
    }

    if (
      this.hasStrongSpecificAnchor(trimmed) &&
      !this.isContextualFollowUpQuery(trimmed)
    ) {
      return false;
    }

    return (
      this.isContextualFollowUpQuery(trimmed) ||
      this.isSubjectDetailFollowUpQuery(trimmed) ||
      this.isCompletenessVerificationFollowUpQuery(
        trimmed,
        normalizedQuery?.previousUserQuery ?? null,
      ) ||
      this.isSummaryFollowUpQuery(trimmed) ||
      this.isBroadContinuationQuery(trimmed)
    );
  }

  buildClarificationResolvedQuery(
    pendingClarification: ChatClarificationState | string | null | undefined,
    clarificationReply: string,
  ): string {
    const clarificationState =
      this.normalizeClarificationStateInput(pendingClarification);
    const baseQuery = clarificationState?.pendingQuery ?? pendingClarification;
    if (clarificationState) {
      const structuredResolvedQuery =
        this.buildStructuredClarificationResolvedQuery(
          clarificationState,
          clarificationReply,
        );
      if (structuredResolvedQuery) {
        return structuredResolvedQuery;
      }
    }

    const base = (typeof baseQuery === 'string' ? baseQuery : '')
      .trim()
      .replace(/[?!.]+$/g, '');
    const normalizedReply =
      this.normalizeInheritedFollowUpQuery(clarificationReply, base) ||
      clarificationReply;
    const reply = normalizedReply.trim().replace(/\s+/g, ' ');
    if (!base) return reply;
    if (!reply) return base;
    return `${base} ${reply}`.replace(/\s+/g, ' ').trim();
  }

  shouldTreatAsClarificationReply(
    userQuery: string,
    pendingClarification: ChatClarificationState | string | null | undefined,
  ): boolean {
    const clarificationState =
      this.normalizeClarificationStateInput(pendingClarification);
    const pendingClarificationQuery = clarificationState?.pendingQuery ?? null;
    if (!pendingClarificationQuery?.trim()) return false;

    const trimmed = userQuery.trim();
    if (!trimmed) return false;
    if (this.shouldSkipDocumentationRetrieval(trimmed)) return false;

    if (
      clarificationState &&
      this.matchesStructuredClarificationReply(trimmed, clarificationState)
    ) {
      return true;
    }

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (
      wordCount <= 8 &&
      (!this.looksLikeFreshQuestion(trimmed) ||
        this.isSubjectDetailFollowUpQuery(trimmed) ||
        this.isBroadContinuationQuery(trimmed))
    ) {
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

    if (
      this.shouldTreatAsClarificationReply(trimmed, pendingClarificationQuery)
    ) {
      return false;
    }

    if (/\b1p\d{2,}\b/i.test(retrievalQuery)) return false;
    if (this.hasExplicitSourceRequest(retrievalQuery)) return false;
    if (this.isDirectLookupSubjectQuery(retrievalQuery)) return false;

    if (
      previousUserQuery &&
      (this.isContextualFollowUpQuery(trimmed) ||
        this.isSubjectDetailFollowUpQuery(trimmed) ||
        this.isCompletenessVerificationFollowUpQuery(
          trimmed,
          previousUserQuery,
        )) &&
      (this.isSelfContainedSubjectQuery(previousUserQuery) ||
        this.hasStrongSpecificAnchor(previousUserQuery))
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
      return localizeChatText(userQuery, {
        en: 'Which exact asset, component, maintenance task, or reference ID do you want next-due information for? If you can, include the asset name or side so I can match the correct schedule row.',
        uk: 'Для якого саме обладнання, компонента, задачі з обслуговування або Reference ID потрібна інформація про наступний термін? Якщо можете, вкажіть назву вузла або сторону, щоб я зіставив правильний рядок графіка.',
        it: 'Per quale asset, componente, attività di manutenzione o Reference ID ti serve l’informazione sulla prossima scadenza? Se puoi, indica il nome dell’asset o il lato così posso abbinare la riga corretta del programma.',
        ru: 'Для какого именно оборудования, компонента, задачи по обслуживанию или Reference ID нужна информация о следующем сроке? Если можешь, укажи название узла или сторону, чтобы я сопоставил правильную строку графика.',
      });
    }

    if (/\b(oil|coolant|fluid|fluids?)\b/i.test(lowered)) {
      return localizeChatText(userQuery, {
        en: 'Which exact component or system is this fluid-related request for? If you can, include the asset name or side, the component, task title, or reference ID.',
        uk: 'Якого саме компонента або системи стосується цей запит про рідину? Якщо можете, вкажіть назву вузла або сторону, сам компонент, назву задачі або Reference ID.',
        it: 'Per quale componente o sistema esatto è questa richiesta relativa ai fluidi? Se puoi, indica il nome dell’asset o il lato, il componente, il titolo dell’attività o il Reference ID.',
        ru: 'Какого именно компонента или системы касается этот запрос по жидкости? Если можешь, укажи название узла или сторону, сам компонент, название задачи или Reference ID.',
      });
    }

    if (
      /\b(parts?|spares?|filters?|part\s*numbers?|consumables?)\b/i.test(
        lowered,
      )
    ) {
      return localizeChatText(userQuery, {
        en: 'Which exact component, system, or maintenance task is this parts request for? If you have it, include the asset name or side, task title, or reference ID.',
        uk: 'Для якого саме компонента, системи або задачі з обслуговування цей запит на запчастини? Якщо маєте, вкажіть назву вузла або сторону, назву задачі чи Reference ID.',
        it: 'Per quale componente, sistema o attività di manutenzione esatta è questa richiesta di ricambi? Se lo hai, indica il nome dell’asset o il lato, il titolo dell’attività o il Reference ID.',
        ru: 'Для какого именно компонента, системы или задачи по обслуживанию этот запрос на запчасти? Если есть, укажи название узла или сторону, название задачи или Reference ID.',
      });
    }

    if (
      /\b(fault|alarm|error|troubleshoot|issue|problem|not\s+working|failure)\b/i.test(
        lowered,
      )
    ) {
      return localizeChatText(userQuery, {
        en: 'Which exact component or system has this issue? If you can, include the asset name or side, the component, and any reference ID or alarm label.',
        uk: 'У якого саме компонента або системи ця проблема? Якщо можете, вкажіть назву вузла або сторону, сам компонент і будь-який Reference ID чи назву аварії.',
        it: 'Quale componente o sistema esatto ha questo problema? Se puoi, indica il nome dell’asset o il lato, il componente e qualsiasi Reference ID o etichetta dell’allarme.',
        ru: 'У какого именно компонента или системы эта проблема? Если можешь, укажи название узла или сторону, сам компонент и любой Reference ID или название аварии.',
      });
    }

    if (
      /\b(status|telemetry|running\s+hours|runtime|hour\s*meter)\b/i.test(
        lowered,
      )
    ) {
      return localizeChatText(userQuery, {
        en: 'Which exact asset or component do you want this status for? If you can, include the asset name or side, the component, or a reference ID.',
        uk: 'Для якого саме обладнання або компонента вам потрібен цей статус? Якщо можете, вкажіть назву вузла або сторону, сам компонент або Reference ID.',
        it: 'Per quale asset o componente esatto vuoi questo stato? Se puoi, indica il nome dell’asset o il lato, il componente o un Reference ID.',
        ru: 'Для какого именно оборудования или компонента нужен этот статус? Если можешь, укажи название узла или сторону, сам компонент или Reference ID.',
      });
    }

    return localizeChatText(userQuery, {
      en: 'Which exact component, system, task, or reference ID is this for? If you can, include the asset name or side so I can look up the correct documentation.',
      uk: 'Для чого саме це: компонент, система, задача чи Reference ID? Якщо можете, вкажіть назву вузла або сторону, щоб я знайшов правильну документацію.',
      it: 'Per quale componente, sistema, attività o Reference ID esatto è questa richiesta? Se puoi, indica il nome dell’asset o il lato così posso cercare la documentazione corretta.',
      ru: 'Для чего именно это: компонент, система, задача или Reference ID? Если можешь, укажи название узла или сторону, чтобы я нашёл правильную документацию.',
    });
  }

  extractRetrievalSubjectTerms(query: string): string[] {
    const stopWords = new Set([
      'what',
      'when',
      'where',
      'who',
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

  isContactLookupQuery(query: string): boolean {
    return /\b(contact|contacts|contact\s+details?|email|emails|phone|telephone|mobile|number|numbers|address|reach|call)\b/i.test(
      query,
    );
  }

  isSummaryFollowUpQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) {
      return false;
    }

    const hasSummaryIntent =
      /\b(?:summari[sz]e|sum\s+up|condense|brief(?:ly)?|in\s+short|one[-\s]?line|one[-\s]?sentence|in\s+one\s+line|in\s+one\s+sentence)\b/i.test(
        trimmed,
      ) || /\b(?:make|keep)\b[\s\S]{0,12}\b(?:brief|short)\b/i.test(trimmed);
    if (!hasSummaryIntent) {
      return false;
    }

    return (
      this.isContextualFollowUpQuery(trimmed) ||
      /\b(?:previous|prior|above)\b/i.test(trimmed)
    );
  }

  private isAggregateContinuationFollowUpQuery(query: string): boolean {
    const normalized = query
      .trim()
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return false;
    }

    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length === 0 || tokens.length > 8) {
      return false;
    }

    const aggregateTokens = new Set([
      'sum',
      'total',
      'combined',
      'overall',
      'altogether',
    ]);
    const allowedTokens = new Set([
      'what',
      'whats',
      'is',
      'the',
      'sum',
      'total',
      'combined',
      'overall',
      'altogether',
      'of',
      'it',
      'them',
      'those',
      'these',
      'that',
      'this',
      'current',
      'currently',
      'now',
      'how',
      'much',
      'many',
      'in',
      'all',
    ]);

    return (
      tokens.some((token) => aggregateTokens.has(token)) &&
      tokens.every((token) => allowedTokens.has(token))
    );
  }

  private isAggregateContinuationContext(query: string): boolean {
    if (
      this.hasExplicitSourceRequest(query) ||
      /\b(manual|documentation|docs?|guide|handbook|procedure|steps?|certificate|policy|spec(?:ification)?|insured)\b/i.test(
        query,
      )
    ) {
      return false;
    }

    return (
      /\b(telemetry|metric|metrics|reading|readings|value|values|tank|tanks|fuel|oil|water|coolant|def|urea|bilge|alarm|alarms|temperature|temperatures|pressure|pressures|voltage|voltages|current|currents|power|energy|runtime|hours?|generator|genset|engine|battery|batteries|charger|chargers|coordinates?|position|latitude|longitude|gps)\b/i.test(
        query,
      ) || this.hasHistoricalTimeAnchor(query)
    );
  }

  isRoleInventoryQuery(query: string): boolean {
    if (
      this.isRoleDescriptionQuery(query) ||
      this.isNavigationPositionQuery(query)
    ) {
      return false;
    }

    if (
      /\bwho\b/i.test(query) ||
      /\bwho\s+else\b/i.test(query) ||
      (/\bhas\b/i.test(query) && /\brole\b/i.test(query))
    ) {
      return false;
    }

    return (
      /\b(role|roles|position|positions|title|titles)\b/i.test(query) &&
      /\b(list|show|what|which|other|else|available|mentioned|listed|there)\b/i.test(
        query,
      )
    );
  }

  private isNavigationPositionQuery(query: string): boolean {
    if (
      !/\b(position|positions|coordinates?|latitude|longitude|gps|location)\b/i.test(
        query,
      )
    ) {
      return false;
    }

    if (
      /\b(role|roles|title|titles|job|responsibilit(?:y|ies)|manager|director|officer|engineer|captain|master|crew|staff|personnel|contact|contacts|email|emails|phone|telephone|mobile|number|numbers|address|dpa|cso)\b/i.test(
        query,
      )
    ) {
      return false;
    }

    return (
      /\b(yacht|vessel|ship|boat|navigation|navigational|where|located|current|currently|right\s+now|now|today|yesterday|our|we|us)\b/i.test(
        query,
      ) || this.hasHistoricalTimeAnchor(query)
    );
  }

  isPersonnelDirectoryQuery(query: string): boolean {
    return (
      this.isContactLookupQuery(query) ||
      this.isRoleInventoryQuery(query) ||
      this.isRoleHolderLookupQuery(query)
    );
  }

  extractContactAnchorTerms(query: string): string[] {
    if (
      !this.isPersonnelDirectoryQuery(query) &&
      !this.isRoleDescriptionQuery(query)
    ) {
      return [];
    }

    const genericTerms = new Set([
      'contact',
      'contacts',
      'email',
      'emails',
      'phone',
      'telephone',
      'mobile',
      'number',
      'numbers',
      'address',
      'details',
      'detail',
      'reach',
      'call',
      'emergency',
      'company',
      'vessel',
      'yacht',
      'ship',
      'crew',
      'staff',
      'person',
      'people',
      'personnel',
      'directory',
      'designated',
      'ashore',
      'holder',
      'name',
      'only',
      'same',
      'another',
      'one',
      'has',
      'his',
      'her',
      'him',
      'their',
      'them',
      'its',
      'this',
      'that',
      'these',
      'those',
      'role',
      'roles',
      'position',
      'positions',
      'title',
      'titles',
      'listed',
      'list',
      'show',
      'who',
      'what',
      'which',
      'other',
      'else',
      'there',
      'available',
      'mentioned',
      'document',
      'documents',
      'doc',
      'file',
      'files',
      'pdf',
    ]);

    return [
      ...new Set(
        this.extractRetrievalSubjectTerms(query)
          .map((term) => this.normalizePersonnelAnchorTerm(term))
          .filter((term) => !genericTerms.has(term)),
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
    return (
      /\b(procedure|steps?|how\s+to|how\s+do\s+i|how\s+can\s+i|how\s+should(?:\s+i|\s+the|\s+it)?|instruction|instructions|checklist|perform|carry\s+out|install|installation|mounted|mounting|wire|wiring|connect|connection|configure|configuration|setup|set\s+up|start|stop|restart|flush|create\s+(?:a\s+)?route|make\s+(?:a\s+)?route|enter\s+(?:a\s+)?route|add\s+(?:a\s+)?waypoint|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|what\s+should\s+be\s+done)\b/i.test(
        query,
      ) || this.isIntervalMaintenanceQuery(query)
    );
  }

  isIntervalMaintenanceQuery(query: string): boolean {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return false;

    const hasIntervalSignal =
      /\b\d{2,6}(?:\s*-\s*|\s+)?(?:h(?:ours?|rs?)?|hourly|months?|month|years?|year)\b/i.test(
        normalized,
      ) ||
      /\b(annual|annually|monthly|weekly|daily|periodic|intervals?|as\s+needed)\b/i.test(
        normalized,
      );
    if (!hasIntervalSignal) {
      return false;
    }

    const hasMaintenanceSignal =
      /\b(service|servicing|mainten[a-z]*|inspection|checks?|tasks?|schedule|overhaul|included|due)\b/i.test(
        normalized,
      );
    const hasActionSignal =
      /\b(how\s+to|how\s+do\s+i|what\s+should\s+i\s+do|what\s+shoul\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|what\s+is\s+included|what\s+should\s+be\s+done|perform|carry\s+out)\b/i.test(
        normalized,
      );

    return hasMaintenanceSignal || hasActionSignal;
  }

  isAuditChecklistLookupQuery(query: string): boolean {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (
      !/\b(audit|audits|compliance|inspection|inspections|checklist|checklists|survey|surveys)\b/i.test(
        normalized,
      )
    ) {
      return false;
    }

    return /\b(audit|audits|compliance|inspection|inspections|survey|surveys|finding|findings|defect|defects|deficienc(?:y|ies)|non[-\s]?conform(?:ity|ities)|psc|port\s+state\s+control)\b/i.test(
      normalized,
    );
  }

  isTankCapacityLookupQuery(query: string): boolean {
    return (
      /\btanks?\b/i.test(query) &&
      /\b(capacity|capacities)\b/i.test(query) &&
      !/\b(current|currently|level|levels|reading|readings|status|value|values)\b/i.test(
        query,
      )
    );
  }

  isTelemetryListQuery(query: string): boolean {
    if (
      this.isManualSpecificationQuery(query) ||
      this.isProcedureQuery(query) ||
      this.isPartsQuery(query)
    ) {
      return false;
    }

    const asksForInventory =
      /\b(show|display|give|return|output|write|provide|enumerate)\b/i.test(
        query,
      ) ||
      /^\s*list\b/i.test(query) ||
      /\b(?:can|could|would|will|please)\s+(?:you\s+)?list\b/i.test(query) ||
      /\blist\s+of\b/i.test(query) ||
      /\b(random|available|all|full|complete|entire|every|\d{1,2})\b/i.test(
        query,
      );
    const mentionsTelemetryInventory =
      /\b(metrics?|telemetry|readings?|values?|signals?|sensors?)\b/i.test(
        query,
      ) ||
      (/\b(alarms?|warnings?|faults?|trips?)\b/i.test(query) &&
        asksForInventory);
    if (!mentionsTelemetryInventory) {
      return false;
    }

    return asksForInventory;
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
        (query.match(/\b1p\d{2,}\b/gi) ?? []).map((value) =>
          value.toUpperCase(),
        ),
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
        (retrievalQuery.match(/\b1[a-z]\d{2,}\b/gi) ?? []).map((match) =>
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

    const hintedSourceCitations = citations.filter((citation) =>
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`
        .toLowerCase()
        .includes(referenceIds[0].toLowerCase()),
    );
    const hintedSources = new Set(
      (hintedSourceCitations.length > 0 ? hintedSourceCitations : citations)
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
        queries.add(
          `${engineSide} MAIN GENERATOR ${focusTerm} maintenance schedule`,
        );
        queries.add(
          `${assetFocus}. Focus on ${focusTerm} work items, task lines, and spare-parts rows for this generator asset.`,
        );
      }
    }

    return [...queries];
  }

  detectDirectionalSide(query: string): 'port' | 'starboard' | null {
    const normalized = query
      .replace(/\bright\s+now\b/gi, ' ')
      .replace(/\b(?:time|hours?)\s+left\b/gi, ' ');

    if (
      /\b(port(?:\s+side)?|portside|ps)\b/i.test(normalized) ||
      /\bleft(?:\s+side|\s+(?:engine|generator|genset|pump|motor|tank|battery|charger|thruster|shaft|coupling|gearbox|bilge))\b/i.test(
        normalized,
      )
    ) {
      return 'port';
    }

    if (
      /\b(starboard(?:\s+side)?|starboardside|sb|stbd)\b/i.test(normalized) ||
      /\bright(?:\s+side|\s+(?:engine|generator|genset|pump|motor|tank|battery|charger|thruster|shaft|coupling|gearbox|bilge))\b/i.test(
        normalized,
      )
    ) {
      return 'starboard';
    }

    return null;
  }

  matchesDirectionalSide(text: string, side: 'port' | 'starboard'): boolean {
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
    return (
      /\b(next\s+due|what\s+is\s+next\s+due|next\s+due\s+value|when\s+is\s+.*(?:maintenance|service).*\sdue|what\s+is\s+the\s+next\s+(maintenance|service)|what\s+(maintenance|service)\s+is\s+next|how\s+many\s+hours?\s+(?:remain|remaining|left)?\s*until|remaining\s+hours?)\b/i.test(
        query,
      ) ||
      /\bwhen\s+(?:is|will)\s+.+\b(?:maintenance|service|oil\s+change|filter(?:\s+change)?|inspection|overhaul|greasing|grease|calibration|cleaning)\b.+\bdue\b/i.test(
        query,
      )
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

    for (const phrase of this.extractMaintenanceIntervalSearchPhrases(query)) {
      tokens.add(phrase);
    }

    for (const match of query.matchAll(/\b1p\d{2,}\b/gi)) {
      tokens.add(match[0].toLowerCase());
    }

    return [...tokens];
  }

  extractMaintenanceIntervalSearchPhrases(query: string): string[] {
    const phrases = new Set<string>();

    for (const match of query.matchAll(
      /\b(\d{2,6})(?:\s*-\s*|\s+)?(h(?:ours?|rs?)?|hourly)\b/gi,
    )) {
      const value = match[1];
      phrases.add(`${value} hour`);
      phrases.add(`${value} hours`);
      phrases.add(`${value} hrs`);
      phrases.add(`every ${value}`);
    }

    for (const match of query.matchAll(
      /\b(\d{1,4})(?:\s*-\s*|\s+)?(months?|month)\b/gi,
    )) {
      const value = match[1];
      phrases.add(`${value} month`);
      phrases.add(`${value} months`);
      phrases.add(`every ${value}`);
    }

    for (const match of query.matchAll(
      /\b(\d{1,4})(?:\s*-\s*|\s+)?(years?|year)\b/gi,
    )) {
      const value = match[1];
      phrases.add(`${value} year`);
      phrases.add(`${value} years`);
      phrases.add(`every ${value}`);
    }

    if (/\bannual|annually\b/i.test(query)) {
      phrases.add('annual');
      phrases.add('annually');
      phrases.add('once per year');
      phrases.add('yearly');
    }

    if (/\byearly\b/i.test(query)) {
      phrases.add('annual');
      phrases.add('annually');
      phrases.add('once per year');
      phrases.add('yearly');
    }

    if (/\bweekly\b/i.test(query)) {
      phrases.add('weekly');
      phrases.add('weekly operations');
      phrases.add('weekly maintenance');
      phrases.add('once per week');
    }

    if (/\bmonthly\b/i.test(query)) {
      phrases.add('monthly');
      phrases.add('monthly operations');
      phrases.add('monthly maintenance');
      phrases.add('once per month');
    }

    if (/\bdaily\b/i.test(query)) {
      phrases.add('daily');
      phrases.add('daily operations');
      phrases.add('daily maintenance');
      phrases.add('once per day');
    }

    if (/\bperiodic\b/i.test(query)) {
      phrases.add('periodic');
    }

    if (/\bas\s+needed\b/i.test(query)) {
      phrases.add('as needed');
      phrases.add('maintenance as needed');
    }

    return [...phrases];
  }

  private isContextualFollowUpQuery(query: string): boolean {
    return (
      /\b(it|its|that|this|they|them|their|those|these|same|next one|this one|his|her|him)\b/i.test(
        query,
      ) ||
      /\b(?:other|another|same)\s+one\b/i.test(query) ||
      /\bwhat\s+about\s+(?:the\s+)?(?:other|another|same)\b/i.test(query)
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

  private isSubjectDetailFollowUpQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) return false;

    if (this.isNavigationPositionQuery(trimmed)) {
      return false;
    }

    if (
      /^(?:(?:only)\s+)?(?:the\s+)?(?:contact|contacts|contact\s+details?|details?|email|emails|phone|telephone|mobile|number|numbers|address|role|roles|position|positions|title|titles)(?:\s+only)?[!.?]*$/i.test(
        trimmed,
      )
    ) {
      return true;
    }

    if (
      /\b(his|her|him|their|them|its)\b[\s\S]{0,24}\b(contact|contacts|email|emails|phone|telephone|mobile|number|numbers|address|details?)\b/i.test(
        trimmed,
      )
    ) {
      return true;
    }

    if (
      /^(?:yes|yeah|yep|ok|okay|please|just|only)\b[\s,.:;-]*(?:the\s+)?(?:contact|contacts|contact\s+details?|details?|email|emails|phone|telephone|mobile|number|numbers|address)\b/i.test(
        trimmed,
      )
    ) {
      return true;
    }

    if (
      /\b(?:his|her|him|their|them|its|this|that|these|those)\b[\s\S]{0,24}\b(role|roles|position|positions|title|titles)\b/i.test(
        trimmed,
      ) ||
      /\b(?:what|which)\b[\s\S]{0,24}\b(other|else)\b[\s\S]{0,24}\b(role|roles|position|positions|title|titles)\b/i.test(
        trimmed,
      ) ||
      /\bwho\s+else\b/i.test(trimmed)
    ) {
      return true;
    }

    return /\b(?:provide|give|share|send|show|write|list|what|which|who)\b[\s\S]{0,32}\b(contact|contacts|email|emails|phone|telephone|mobile|number|numbers|address|details?|role|roles|position|positions|title|titles)\b/i.test(
      trimmed,
    );
  }

  private isCompletenessVerificationFollowUpQuery(
    query: string,
    previousUserQuery?: string | null,
  ): boolean {
    return (
      this.isPhraseBasedCompletenessVerificationFollowUpQuery(query) ||
      this.isSemanticCountCorrectionFollowUpQuery(query, previousUserQuery)
    );
  }

  private isPhraseBasedCompletenessVerificationFollowUpQuery(
    query: string,
  ): boolean {
    return /\b(are you sure|is that all|is this all|complete list|full list|complete checklist|full checklist|did you miss|missing any|missing some|any more|anything else|any others|all of them|all certificates|you missed|write all|show all|list all|all available|full inventory|complete inventory)\b/i.test(
      query,
    );
  }

  private isSemanticCountCorrectionFollowUpQuery(
    query: string,
    previousUserQuery?: string | null,
  ): boolean {
    if (!previousUserQuery?.trim()) {
      return false;
    }

    const normalized = query.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return false;
    }

    if (
      this.isPhraseBasedCompletenessVerificationFollowUpQuery(normalized) ||
      !/\b\d+\b/.test(normalized)
    ) {
      return false;
    }

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (wordCount > 12) {
      return false;
    }

    if (
      !/^(?:there\s+(?:is|are|were)|there\s+should\s+be|should\s+be|only\b|just\b|looks\s+like|i\s+(?:count|see|have|got)|it(?:'s| is)\b)/i.test(
        normalized,
      )
    ) {
      return false;
    }

    const previousTerms =
      this.extractCompletenessSubjectTerms(previousUserQuery);
    const currentTerms = this.extractCompletenessSubjectTerms(normalized);
    if (currentTerms.length === 0) {
      return false;
    }

    return this.hasCompletenessSubjectRelation(currentTerms, previousTerms);
  }

  private normalizeInheritedFollowUpQuery(
    query: string,
    previousUserQuery?: string | null,
  ): string {
    const trimmed = query.trim().replace(/\s+/g, ' ');
    if (!trimmed) {
      return trimmed;
    }

    const withoutAffirmation = trimmed.replace(
      /^(?:yes|yeah|yep|ok|okay|please|just|only)\b[\s,.:;-]*/i,
      '',
    );
    const sourceScopeOverride =
      this.normalizeSourceScopeFollowUp(withoutAffirmation);
    if (sourceScopeOverride) {
      return sourceScopeOverride;
    }
    const completenessFollowUp = this.normalizeCompletenessFollowUp(
      withoutAffirmation,
      previousUserQuery,
    );
    if (completenessFollowUp) {
      return completenessFollowUp;
    }
    const detailFocus = this.extractDetailFocus(withoutAffirmation);
    if (detailFocus) {
      return detailFocus;
    }

    return withoutAffirmation || trimmed;
  }

  private mergeFollowUpSubjectAndReply(
    subject: string,
    followUp: string,
  ): string {
    const normalizedSubject = subject.trim().replace(/\s+/g, ' ');
    const normalizedFollowUp = followUp.trim().replace(/\s+/g, ' ');
    if (!normalizedSubject) {
      return normalizedFollowUp;
    }
    if (!normalizedFollowUp) {
      return normalizedSubject;
    }

    const subjectTokens = normalizedSubject.split(' ');
    const followUpTokens = normalizedFollowUp.split(' ');
    let overlap = 0;
    const maxOverlap = Math.min(subjectTokens.length, followUpTokens.length);
    for (let size = maxOverlap; size > 0; size -= 1) {
      const subjectTail = subjectTokens.slice(-size).join(' ').toLowerCase();
      const followUpHead = followUpTokens
        .slice(0, size)
        .join(' ')
        .toLowerCase();
      if (subjectTail === followUpHead) {
        overlap = size;
        break;
      }
    }

    return [...subjectTokens, ...followUpTokens.slice(overlap)]
      .join(' ')
      .trim();
  }

  private extractDetailFocus(query: string): string | null {
    if (!this.isSubjectDetailFollowUpQuery(query)) {
      return null;
    }

    const focusTerms: string[] = [];
    const normalized = query.toLowerCase();

    if (/\bcontacts?\b|\bcontact\s+details?\b|\bdetails?\b/.test(normalized)) {
      focusTerms.push('contact details');
    }
    if (/\bemails?\b/.test(normalized)) {
      focusTerms.push('email');
    }
    if (/\b(phone|telephone)\b/.test(normalized)) {
      focusTerms.push('phone');
    }
    if (/\bmobile\b/.test(normalized)) {
      focusTerms.push('mobile');
    }
    if (
      /\bnumbers?\b/.test(normalized) &&
      !focusTerms.includes('phone') &&
      !focusTerms.includes('mobile')
    ) {
      focusTerms.push('contact number');
    }
    if (/\baddress\b/.test(normalized)) {
      focusTerms.push('address');
    }
    if (/\broles?\b/.test(normalized)) {
      focusTerms.push('roles');
    }
    if (/\bpositions?\b/.test(normalized)) {
      focusTerms.push('positions');
    }
    if (/\btitles?\b/.test(normalized)) {
      focusTerms.push('titles');
    }

    if (focusTerms.length === 0) {
      return null;
    }

    return [...new Set(focusTerms)].join(' ');
  }

  private isRoleHolderLookupQuery(query: string): boolean {
    if (this.isRoleDescriptionQuery(query)) {
      return false;
    }

    const hasRoleAnchor =
      /\b(?:manager|managers|director|directors|officer|officers|engineer|engineers|captain|master|founder|president|head|dpa|cso)\b/i.test(
        query,
      );
    if (!hasRoleAnchor) {
      return false;
    }

    return (
      /\b(?:who|which|list|show|give|provide|find|extract|share)\b/i.test(
        query,
      ) ||
      /\bwho\s+else\b/i.test(query) ||
      /\bhas\s+the\b[\s\S]{0,24}\brole\b/i.test(query) ||
      (/\bwhat\b/i.test(query) && this.isContactLookupQuery(query))
    );
  }

  private normalizePersonnelAnchorTerm(term: string): string {
    const normalized = term.toLowerCase();
    const singularMap: Record<string, string> = {
      managers: 'manager',
      directors: 'director',
      officers: 'officer',
      engineers: 'engineer',
      roles: 'role',
      positions: 'position',
      titles: 'title',
    };

    return singularMap[normalized] ?? normalized;
  }

  private hasExplicitSourceRequest(query: string): boolean {
    return /\b(?:according\s+to|from|in)\s+the\s+.+?\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document)\b/i.test(
      query,
    );
  }

  private isExplicitTelemetrySourceQuery(query: string): boolean {
    return /\b(?:based on|from|in|using)\b[\s\S]{0,32}\b(telemetry|metrics?)\b/i.test(
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

  private isLowInformationContinuationQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || this.looksLikeFreshQuestion(trimmed)) {
      return false;
    }

    const subjectTerms = this.extractRetrievalSubjectTerms(trimmed);
    if (subjectTerms.length === 0) {
      return true;
    }

    const genericContinuationTerms = new Set([
      'yes',
      'yeah',
      'yep',
      'ok',
      'okay',
      'sure',
      'please',
      'continue',
      'show',
      'want',
      'go',
      'ahead',
      'more',
      'do',
      'it',
      'that',
    ]);

    return subjectTerms.every((term) =>
      genericContinuationTerms.has(term.toLowerCase()),
    );
  }

  private isGenericDocumentationDetailFollowUp(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) {
      return false;
    }

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 10) {
      return false;
    }

    return (
      /\b(parts?|spares?|items?|components?|quantit(?:y|ies)|qty|pages?|sources?|steps?|procedures?|records?|checks?|checklists?|warnings?|requirements?|limits?|limitations?|tools?|materials?|tables?|diagrams?|figures?|drawings?|charts?|summar(?:y|ies|ize)|process(?:es)?|sequence|overview)\b/i.test(
        trimmed,
      ) ||
      /\b(?:who|what|which)\s+should\s+(?:be\s+)?(?:notified|involved|checked|recorded|completed)\b/i.test(
        trimmed,
      ) ||
      /\bwhat\s+(?:should|do)\s+i\s+check\s+first\b/i.test(trimmed)
    );
  }

  private isSourceScopeFollowUpQuery(query: string): boolean {
    return (
      this.isExplicitTelemetrySourceQuery(query) ||
      /\b(?:based on|from|in|using)\b[\s\S]{0,32}\b(manuals?|docs?|documentation|certificates?|regulations?|history|historical|procedures?)\b/i.test(
        query,
      )
    );
  }

  private normalizeSourceScopeFollowUp(query: string): string | null {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !this.isSourceScopeFollowUpQuery(normalized)) {
      return null;
    }
    if (!this.isPureSourceScopeOverride(normalized)) {
      return null;
    }

    if (/\b(telemetry|metrics?)\b/.test(normalized)) {
      return 'from telemetry';
    }
    if (/\b(manuals?|docs?|documentation)\b/.test(normalized)) {
      return 'from documentation';
    }
    if (/\b(certificates?)\b/.test(normalized)) {
      return 'from certificates';
    }
    if (/\b(regulations?)\b/.test(normalized)) {
      return 'from regulations';
    }
    if (/\b(history|historical|procedures?)\b/.test(normalized)) {
      return 'from history procedures';
    }

    return null;
  }

  private isContinuationRefinementFragment(query: string): boolean {
    const trimmed = query.trim();
    if (
      !trimmed ||
      this.looksLikeFreshQuestion(trimmed) ||
      this.isSourceScopeFollowUpQuery(trimmed)
    ) {
      return false;
    }

    if (!/^(?:based on|using|via|according to|from)\b/i.test(trimmed)) {
      return false;
    }

    return this.extractRetrievalSubjectTerms(trimmed).length > 0;
  }

  private isPureSourceScopeOverride(query: string): boolean {
    const normalized = query
      .replace(/[?.!]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return false;
    }

    return /^(?:(?:based\s+on|from|in|inside|using)\s+(?:the\s+)?)?(?:manuals?|docs?|documentation|certificates?|regulations?|history|historical|procedures?|telemetry|metrics?)(?:\s+(?:only|instead))?$/.test(
      normalized,
    );
  }

  private normalizeCompletenessFollowUp(
    query: string,
    previousUserQuery?: string | null,
  ): string | null {
    if (this.isPhraseBasedCompletenessVerificationFollowUpQuery(query)) {
      return 'show all available';
    }

    if (
      !this.isSemanticCountCorrectionFollowUpQuery(query, previousUserQuery)
    ) {
      return null;
    }

    return this.isTelemetryCompletenessFollowUpContext(previousUserQuery)
      ? 'show all available telemetry readings'
      : 'show all available';
  }

  private resolveInheritedFollowUpSubject(params: {
    previousUserQuery: string;
    currentUserQuery: string;
    completenessFollowUp: boolean;
  }): string | null {
    const { previousUserQuery, currentUserQuery, completenessFollowUp } =
      params;

    if (
      this.shouldReusePreviousHistoricalQueryForCompletenessFollowUp(
        previousUserQuery,
        currentUserQuery,
        completenessFollowUp,
      )
    ) {
      return this.normalizeInheritedFollowUpSubjectBase(previousUserQuery);
    }

    if (
      completenessFollowUp &&
      this.isSemanticCountCorrectionFollowUpQuery(
        currentUserQuery,
        previousUserQuery,
      )
    ) {
      const semanticCorrectionSubject =
        this.buildSemanticCompletenessFollowUpSubject(
          previousUserQuery,
          currentUserQuery,
        );
      if (semanticCorrectionSubject) {
        return semanticCorrectionSubject;
      }
    }

    return this.extractFollowUpSubject(previousUserQuery);
  }

  private shouldReusePreviousHistoricalQueryForCompletenessFollowUp(
    previousUserQuery: string,
    currentUserQuery: string,
    completenessFollowUp: boolean,
  ): boolean {
    return (
      completenessFollowUp &&
      this.hasHistoricalTimeAnchor(previousUserQuery) &&
      !this.hasExplicitTimeOverride(currentUserQuery)
    );
  }

  private normalizeInheritedFollowUpSubjectBase(query: string): string {
    return query
      .trim()
      .replace(/[?!.]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  private hasHistoricalTimeAnchor(query: string): boolean {
    return (
      Boolean(this.extractHistoricalAbsoluteDateForContinuation(query)) ||
      /\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i.test(
        query,
      ) ||
      /\b(?:last|past|previous)\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/i.test(
        query,
      ) ||
      /\b(?:yesterday|last\s+week|last\s+month|last\s+year)\b/i.test(query)
    );
  }

  private hasExplicitTimeOverride(query: string): boolean {
    return (
      this.isTemporalRangeFollowUpQuery(query) ||
      /\b(?:now|right\s+now|current|currently|today|this\s+week|this\s+month|this\s+year)\b/i.test(
        query,
      )
    );
  }

  private isExplicitCurrentTimeFollowUpQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || this.isSelfContainedSubjectQuery(trimmed)) {
      return false;
    }

    return (
      /^(?:what|how)\s+about\s+now[?.!]*$/i.test(trimmed) ||
      /^(?:and\s+)?now[?.!]*$/i.test(trimmed) ||
      /^(?:what|how)\s+about\s+(?:right\s+)?now[?.!]*$/i.test(trimmed) ||
      /^(?:current|currently|right\s+now)[?.!]*$/i.test(trimmed)
    );
  }

  private normalizeCurrentTimeContinuationSubject(query: string): string {
    const normalized = this.stripHistoricalContinuationTime(
      this.stripFollowUpScopeScaffolding(query),
    )
      .replace(/\b(?:was|were)\b/gi, 'is')
      .replace(/\s+/g, ' ')
      .trim();

    return this.ensureAggregateStoredFluidTankContext(normalized);
  }

  private buildAggregateContinuationQuery(previousUserQuery: string): string {
    const normalizedBase = this.normalizeInheritedFollowUpSubjectBase(
      this.stripFollowUpScopeScaffolding(previousUserQuery),
    );
    if (!normalizedBase) {
      return normalizedBase;
    }

    const canonicalTime =
      this.extractCanonicalHistoricalContinuationTime(normalizedBase);
    const subject =
      canonicalTime !== null
        ? this.stripHistoricalContinuationTime(normalizedBase)
        : normalizedBase;
    const normalizedSubject =
      this.ensureAggregateStoredFluidLevelTankContext(subject);

    return canonicalTime
      ? this.composeTemporalContinuationQuery(normalizedSubject, canonicalTime)
      : normalizedSubject;
  }

  private stripFollowUpScopeScaffolding(value: string): string {
    return value
      .replace(/\bshow all available\b/gi, ' ')
      .replace(/\bfrom telemetry\b/gi, ' ')
      .replace(/\bfrom documentation\b/gi, ' ')
      .replace(/\bfrom certificates\b/gi, ' ')
      .replace(/\bfrom regulations\b/gi, ' ')
      .replace(/\bfrom history procedures\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private ensureAggregateStoredFluidLevelTankContext(query: string): string {
    if (!query) {
      return query;
    }

    if (!/\b(fuel|oil|water|coolant|def|urea)\b/i.test(query)) {
      return query;
    }

    if (
      !/\b(level|levels|reading|readings|value|values|quantity|quantities|amount|amounts)\b/i.test(
        query,
      )
    ) {
      return query;
    }

    if (/\b(tank|tanks|onboard)\b/i.test(query)) {
      return query;
    }

    return `${query} in the tanks`.replace(/\s+/g, ' ').trim();
  }

  private ensureAggregateStoredFluidTankContext(query: string): string {
    if (!query) {
      return query;
    }

    const asksForQuantity =
      /\b(how much|how many|total|sum|overall|combined|together|calculate)\b/i.test(
        query,
      ) || /\b(onboard|remaining|left|available)\b/i.test(query);
    if (!asksForQuantity) {
      return query;
    }

    if (!/\b(fuel|oil|water|coolant|def|urea)\b/i.test(query)) {
      return query;
    }

    if (/\b(tank|tanks|onboard)\b/i.test(query)) {
      return query;
    }

    return `${query} in the tanks`.replace(/\s+/g, ' ').trim();
  }

  private isTemporalRangeFollowUpQuery(query: string): boolean {
    return (
      /\b(?:based on|for|using)\b[\s\S]{0,40}\b(last|past|previous|this)\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/i.test(
        query,
      ) ||
      /\b(?:last|past|previous)\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/i.test(
        query,
      ) ||
      /\b(?:this|last)\s+(?:week|month|year)\b/i.test(query) ||
      /\b(?:today|yesterday)\b/i.test(query) ||
      /\bon\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/i.test(
        query,
      ) ||
      /\bon\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/i.test(
        query,
      ) ||
      /\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i.test(
        query,
      )
    );
  }

  private isAnalyticalContinuationContext(query: string): boolean {
    return (
      /\b(forecast|budget|trend|history|historical|consumption|usage|need\s+to\s+order|order)\b/i.test(
        query,
      ) ||
      (/\bfuel\b/i.test(query) &&
        /\b(how\s+much|how\s+many|need|next\s+month|coming\s+month|upcoming\s+month)\b/i.test(
          query,
        ))
    );
  }

  private buildTemporalContinuationQuery(
    previousUserQuery: string,
    followUpQuery: string,
  ): string {
    const previous = previousUserQuery.trim().replace(/[?!.]+$/g, '');
    const followUp = followUpQuery.trim().replace(/[?!.]+$/g, '');
    if (!previous) {
      return followUp;
    }
    if (!followUp) {
      return previous;
    }

    if (/^(?:based on|for|using)\b/i.test(followUp)) {
      return `${this.stripHistoricalContinuationTime(previous)} ${followUp}`
        .replace(/\s+/g, ' ')
        .trim();
    }

    const canonicalTime =
      this.extractCanonicalHistoricalContinuationTime(followUp) ??
      this.extractCanonicalHistoricalContinuationTime(previous);

    if (this.hasStandaloneTemporalContinuationSubject(followUp)) {
      return this.composeTemporalContinuationQuery(
        this.stripHistoricalContinuationTime(followUp),
        canonicalTime,
      );
    }

    const subject = this.stripHistoricalContinuationTime(previous);
    if (!canonicalTime) {
      return `${subject} ${followUp}`.replace(/\s+/g, ' ').trim();
    }

    return this.composeTemporalContinuationQuery(subject, canonicalTime);
  }

  private composeTemporalContinuationQuery(
    subject: string,
    canonicalTime: string | null,
  ): string {
    const normalizedSubject = subject.trim().replace(/\s+/g, ' ');
    if (!canonicalTime) {
      return normalizedSubject;
    }

    if (!normalizedSubject) {
      return canonicalTime;
    }

    return `${normalizedSubject} ${canonicalTime}`.replace(/\s+/g, ' ').trim();
  }

  private hasStandaloneTemporalContinuationSubject(query: string): boolean {
    return /\b(fuel|tank|tanks|oil|coolant|water|generator|engine|telemetry|load|voltage|pressure|temperature|position|coordinates?|location|bunkering|refill|increase|consumption|used|remaining|total|average|onboard)\b/i.test(
      query,
    );
  }

  private stripHistoricalContinuationTime(value: string): string {
    return value
      .replace(/[?!.]+/g, ' ')
      .replace(
        /\b(?:based on|for|using)\b[\s\S]{0,40}\b(last|past|previous|this)\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/gi,
        ' ',
      )
      .replace(
        /\b(?:last|past|previous)\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/gi,
        ' ',
      )
      .replace(/\b(?:this|last)\s+(?:week|month|year)\b/gi, ' ')
      .replace(/\b(?:today|yesterday)\b/gi, ' ')
      .replace(
        /\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/gi,
        ' ',
      )
      .replace(/\bon\s+\d{4}-\d{2}-\d{2}\b/gi, ' ')
      .replace(
        /\bon\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/gi,
        ' ',
      )
      .replace(
        /\bon\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
        ' ',
      )
      .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*utc)?\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractCanonicalHistoricalContinuationTime(
    value: string,
  ): string | null {
    const absoluteDate =
      this.extractHistoricalAbsoluteDateForContinuation(value);
    if (absoluteDate) {
      return `on ${absoluteDate}`;
    }

    const relativeMatch = value.match(
      /\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i,
    );
    if (relativeMatch?.[0]) {
      return relativeMatch[0].trim().toLowerCase();
    }

    const explicitRangeMatch = value.match(
      /\b(?:last|past|previous)\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/i,
    );
    if (explicitRangeMatch?.[0]) {
      return explicitRangeMatch[0].trim().toLowerCase();
    }

    if (/\b(?:today|yesterday)\b/i.test(value)) {
      return (
        value.match(/\b(?:today|yesterday)\b/i)?.[0]?.toLowerCase() ?? null
      );
    }

    if (/\b(?:this|last)\s+(?:week|month|year)\b/i.test(value)) {
      return (
        (
          value.match(/\b(?:this|last)\s+(?:week|month|year)\b/i)?.[0] ?? null
        )?.toLowerCase() ?? null
      );
    }

    return null;
  }

  private extractHistoricalAbsoluteDateForContinuation(
    value: string,
  ): string | null {
    const isoMatch = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    const dayMonthMatch = value.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/i,
    );
    if (dayMonthMatch) {
      return this.formatHistoricalContinuationIsoDate(
        Number.parseInt(
          dayMonthMatch[3] ?? String(new Date().getUTCFullYear()),
          10,
        ),
        this.getHistoricalContinuationMonthIndex(dayMonthMatch[2]) + 1,
        Number.parseInt(dayMonthMatch[1], 10),
      );
    }

    const monthDayMatch = value.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
    );
    if (monthDayMatch) {
      return this.formatHistoricalContinuationIsoDate(
        Number.parseInt(
          monthDayMatch[3] ?? String(new Date().getUTCFullYear()),
          10,
        ),
        this.getHistoricalContinuationMonthIndex(monthDayMatch[1]) + 1,
        Number.parseInt(monthDayMatch[2], 10),
      );
    }

    return null;
  }

  private getHistoricalContinuationMonthIndex(monthName: string): number {
    return [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ].indexOf(monthName.toLowerCase());
  }

  private formatHistoricalContinuationIsoDate(
    year: number,
    month: number,
    day: number,
  ): string {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(
      2,
      '0',
    )}-${String(day).padStart(2, '0')}`;
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

  private buildSemanticCompletenessFollowUpSubject(
    previousUserQuery: string,
    currentUserQuery: string,
  ): string | null {
    const previousTerms =
      this.extractCompletenessSubjectTerms(previousUserQuery);
    const currentTerms = this.extractCompletenessSubjectTerms(currentUserQuery);
    if (currentTerms.length === 0) {
      return previousTerms.length > 0 ? previousTerms.join(' ') : null;
    }

    if (!this.hasCompletenessSubjectRelation(currentTerms, previousTerms)) {
      return null;
    }

    const normalizedPrevious = new Set(
      previousTerms.map((term) => this.normalizeCompletenessSubjectTerm(term)),
    );
    const normalizedCurrent = new Set(
      currentTerms.map((term) => this.normalizeCompletenessSubjectTerm(term)),
    );
    const currentAddsSpecificity = currentTerms.some(
      (term) =>
        !normalizedPrevious.has(this.normalizeCompletenessSubjectTerm(term)),
    );

    if (!currentAddsSpecificity) {
      return previousTerms.length > 0 ? previousTerms.join(' ') : null;
    }

    return [
      ...currentTerms,
      ...previousTerms.filter(
        (term) =>
          !normalizedCurrent.has(this.normalizeCompletenessSubjectTerm(term)),
      ),
    ].join(' ');
  }

  private extractCompletenessSubjectTerms(query: string): string[] {
    const genericTerms = new Set([
      'active',
      'actually',
      'all',
      'already',
      'any',
      'available',
      'complete',
      'count',
      'counts',
      'current',
      'currently',
      'exact',
      'exactly',
      'full',
      'got',
      'have',
      'just',
      'left',
      'list',
      'lot',
      'lots',
      'many',
      'miss',
      'missed',
      'missing',
      'more',
      'now',
      'number',
      'numbers',
      'only',
      'other',
      'others',
      'remaining',
      'rest',
      'right',
      'see',
      'should',
      'show',
      'still',
      'sure',
      'that',
      'there',
      'these',
      'they',
      'those',
      'total',
      'was',
      'were',
      'write',
    ]);

    return this.extractRetrievalSubjectTerms(query).filter(
      (term) => !genericTerms.has(this.normalizeCompletenessSubjectTerm(term)),
    );
  }

  private normalizeCompletenessSubjectTerm(term: string): string {
    const normalized = term.trim().toLowerCase();
    if (!normalized) {
      return normalized;
    }
    if (normalized.endsWith('ies') && normalized.length > 4) {
      return `${normalized.slice(0, -3)}y`;
    }
    if (normalized.endsWith('es') && normalized.length > 4) {
      return normalized.slice(0, -2);
    }
    if (normalized.endsWith('s') && normalized.length > 3) {
      return normalized.slice(0, -1);
    }
    return normalized;
  }

  private hasCompletenessSubjectRelation(
    currentTerms: string[],
    previousTerms: string[],
  ): boolean {
    if (currentTerms.length === 0 || previousTerms.length === 0) {
      return false;
    }

    const normalizedPrevious = previousTerms.map((term) =>
      this.normalizeCompletenessSubjectTerm(term),
    );

    return currentTerms.some((term) => {
      const normalizedCurrent = this.normalizeCompletenessSubjectTerm(term);
      return normalizedPrevious.some(
        (previousTerm) =>
          previousTerm === normalizedCurrent ||
          previousTerm.includes(normalizedCurrent) ||
          normalizedCurrent.includes(previousTerm),
      );
    });
  }

  private isTelemetryCompletenessFollowUpContext(
    query?: string | null,
  ): boolean {
    if (!query?.trim()) {
      return false;
    }

    if (
      this.hasExplicitSourceRequest(query) ||
      this.isSourceScopeFollowUpQuery(query) ||
      this.isPersonnelDirectoryQuery(query) ||
      this.isRoleDescriptionQuery(query) ||
      this.isProcedureQuery(query) ||
      this.isPartsQuery(query)
    ) {
      return false;
    }

    if (this.isTelemetryListQuery(query)) {
      return true;
    }

    return (
      this.isAggregateContinuationContext(query) ||
      /\b(telemetry|metric|metrics|reading|readings|value|values|signal|signals|sensor|sensors|current|currently|now|right now|historical|history|today|yesterday|active|inactive|enabled|disabled|onboard)\b/i.test(
        query,
      )
    );
  }

  private isSelfContainedSubjectQuery(query: string): boolean {
    if (/\b1p\d{2,}\b/i.test(query)) return true;
    if (
      (this.isPersonnelDirectoryQuery(query) ||
        this.isRoleDescriptionQuery(query)) &&
      this.extractContactAnchorTerms(query).length > 0
    ) {
      return true;
    }

    return /\b(generator|genset|engine|pump|compressor|watermaker|manual|filter|alarm|fault|error|telemetry)\b/i.test(
      query,
    );
  }

  private buildPersonnelDirectoryRetrievalQuery(query: string): string | null {
    const anchorTerms = this.extractContactAnchorTerms(query);
    if (anchorTerms.length === 0) {
      return null;
    }

    const normalizedAnchors = [...new Set(anchorTerms)].join(' ');
    const expandedAnchors = /\bdpa\b/i.test(query)
      ? `${normalizedAnchors} designated person ashore`
      : normalizedAnchors;
    const directoryContext =
      'contact details personnel directory company contact list';

    if (
      this.isContactLookupQuery(query) ||
      /\bwho\s+else\b/i.test(query) ||
      /\b(list|show)\b/i.test(query) ||
      /\ball\b/i.test(query)
    ) {
      return `${expandedAnchors} ${directoryContext}`;
    }

    if (this.isRoleInventoryQuery(query)) {
      return `${expandedAnchors} roles ${directoryContext}`;
    }

    if (this.isRoleHolderLookupQuery(query)) {
      return `${expandedAnchors} role holder name ${directoryContext}`;
    }

    return null;
  }

  private buildRoleDescriptionRetrievalQuery(query: string): string | null {
    if (!this.isRoleDescriptionQuery(query)) {
      return null;
    }

    const anchorTerms = this.extractContactAnchorTerms(query);
    const normalizedAnchors = [...new Set(anchorTerms)].join(' ');
    if (/\bdpa\b/i.test(query)) {
      return 'dpa designated person ashore role responsibility responsibilities sms company safety management system administration';
    }
    if (/\bcso\b/i.test(query)) {
      return 'cso company security officer role responsibility responsibilities security management system';
    }

    return normalizedAnchors
      ? `${normalizedAnchors} role responsibilities`
      : null;
  }

  isRoleDescriptionQuery(query: string): boolean {
    return (
      /\bwhat\s+does\b[\s\S]{0,40}\b(?:dpa|cso|manager|director|officer|engineer|captain|master|founder|president|head|role)\b/i.test(
        query,
      ) ||
      /\b(?:role|responsibilit(?:y|ies)|job)\b[\s\S]{0,20}\b(?:of|for)\b/i.test(
        query,
      ) ||
      /\bwhat\s+is\s+(?:the\s+)?(?:role|responsibility|job)\b/i.test(query) ||
      /\bwhat\s+is\b[\s\S]{0,40}\bresponsible\s+for\b/i.test(query) ||
      /\b(?:dpa|cso|manager|director|officer|engineer|captain|master|founder|president|head)\b[\s\S]{0,80}\bresponsibilit(?:y|ies)\b/i.test(
        query,
      ) ||
      /\b(?:describe|explain)\b[\s\S]{0,24}\b(?:role|responsibilit(?:y|ies)|dpa|cso)\b/i.test(
        query,
      )
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
        (citation) =>
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`,
      )
      .join('\n');
    const referenceId = combinedText.match(/\b1p\d{2,}\b/i)?.[0]?.toUpperCase();
    if (!referenceId) return null;

    return `${referenceId} spare name quantity location manufacturer part supplier part`;
  }

  private extractClarificationState(
    ragflowContext: Record<string, unknown> | null,
  ): ChatClarificationState | null {
    if (!ragflowContext) {
      return null;
    }

    const rawState =
      ragflowContext.clarificationState &&
      typeof ragflowContext.clarificationState === 'object'
        ? (ragflowContext.clarificationState as Record<string, unknown>)
        : null;
    const pendingQuery =
      typeof rawState?.pendingQuery === 'string' && rawState.pendingQuery.trim()
        ? rawState.pendingQuery.trim()
        : typeof ragflowContext.pendingClarificationQuery === 'string' &&
            ragflowContext.pendingClarificationQuery.trim()
          ? ragflowContext.pendingClarificationQuery.trim()
          : null;
    if (!pendingQuery) {
      return null;
    }

    const normalizedQuery =
      ragflowContext.normalizedQuery &&
      typeof ragflowContext.normalizedQuery === 'object'
        ? (ragflowContext.normalizedQuery as ChatNormalizedQuery)
        : undefined;
    const clarificationReason =
      typeof ragflowContext.clarificationReason === 'string'
        ? ragflowContext.clarificationReason
        : undefined;
    const resolvedSubjectQuery =
      typeof rawState?.resolvedSubjectQuery === 'string' &&
      rawState.resolvedSubjectQuery.trim()
        ? rawState.resolvedSubjectQuery.trim()
        : typeof ragflowContext.resolvedSubjectQuery === 'string' &&
            ragflowContext.resolvedSubjectQuery.trim()
          ? ragflowContext.resolvedSubjectQuery.trim()
          : undefined;
    const clarificationDomain =
      this.readClarificationDomain(rawState?.clarificationDomain) ??
      this.deriveClarificationDomain(ragflowContext);
    const requiredFields =
      this.normalizeClarificationFields(rawState?.requiredFields) ??
      this.deriveRequiredClarificationFields({
        clarificationDomain,
        pendingQuery,
        normalizedQuery,
        clarificationReason,
        resolvedSubjectQuery,
      });
    const resolvedFields = {
      ...this.deriveResolvedClarificationFields(normalizedQuery),
      ...(this.normalizeResolvedClarificationFields(rawState?.resolvedFields) ??
        {}),
    };

    return {
      clarificationDomain,
      pendingQuery,
      ...(requiredFields.length > 0 ? { requiredFields } : {}),
      ...(Object.keys(resolvedFields).length > 0 ? { resolvedFields } : {}),
      ...(resolvedSubjectQuery ? { resolvedSubjectQuery } : {}),
    };
  }

  private normalizeClarificationStateInput(
    pendingClarification: ChatClarificationState | string | null | undefined,
  ): ChatClarificationState | null {
    if (!pendingClarification) {
      return null;
    }

    if (typeof pendingClarification === 'string') {
      const pendingQuery = pendingClarification.trim();
      return pendingQuery
        ? {
            clarificationDomain: 'documentation',
            pendingQuery,
          }
        : null;
    }

    const pendingQuery = pendingClarification.pendingQuery?.trim();
    if (!pendingQuery) {
      return null;
    }

    return {
      ...pendingClarification,
      pendingQuery,
      ...(pendingClarification.requiredFields?.length
        ? { requiredFields: [...pendingClarification.requiredFields] }
        : {}),
      ...(pendingClarification.resolvedFields &&
      Object.keys(pendingClarification.resolvedFields).length > 0
        ? {
            resolvedFields: { ...pendingClarification.resolvedFields },
          }
        : {}),
      ...(pendingClarification.resolvedSubjectQuery?.trim()
        ? {
            resolvedSubjectQuery:
              pendingClarification.resolvedSubjectQuery.trim(),
          }
        : {}),
    };
  }

  private buildStructuredClarificationResolvedQuery(
    clarificationState: ChatClarificationState,
    clarificationReply: string,
  ): string | null {
    if (clarificationState.clarificationDomain !== 'historical_telemetry') {
      return null;
    }

    const base = clarificationState.pendingQuery.trim().replace(/[?!.]+$/g, '');
    if (!base) {
      return null;
    }

    const normalizedTimeReply =
      this.normalizeHistoricalTimeReply(clarificationReply);
    if (normalizedTimeReply) {
      return `${base
        .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?(?:\s*utc)?\b/i, '')
        .trim()} at ${normalizedTimeReply}`
        .replace(/\s+/g, ' ')
        .trim();
    }

    const normalizedDateReply =
      this.normalizeHistoricalDateReply(clarificationReply);
    if (
      normalizedDateReply &&
      !/\b\d{4}-\d{2}-\d{2}\b/.test(base) &&
      !/\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i.test(
        base,
      )
    ) {
      return `${base} on ${normalizedDateReply}`.replace(/\s+/g, ' ').trim();
    }

    const normalizedYearReply =
      this.normalizeHistoricalYearReply(clarificationReply);
    if (
      normalizedYearReply &&
      /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
        base,
      ) &&
      !/\b\d{4}\b/.test(base)
    ) {
      return `${base} ${normalizedYearReply}`.replace(/\s+/g, ' ').trim();
    }

    return null;
  }

  private matchesStructuredClarificationReply(
    userQuery: string,
    clarificationState: ChatClarificationState,
  ): boolean {
    const requiredFields = clarificationState.requiredFields ?? [];
    if (
      (requiredFields.includes('time_of_day') ||
        clarificationState.clarificationDomain === 'historical_telemetry') &&
      this.normalizeHistoricalTimeReply(userQuery)
    ) {
      return true;
    }

    if (
      requiredFields.includes('date') &&
      this.normalizeHistoricalDateReply(userQuery)
    ) {
      return true;
    }

    if (
      requiredFields.includes('year') &&
      this.normalizeHistoricalYearReply(userQuery)
    ) {
      return true;
    }

    return false;
  }

  private readClarificationDomain(
    value: unknown,
  ): ChatClarificationDomain | null {
    if (
      value === 'documentation' ||
      value === 'current_telemetry' ||
      value === 'historical_telemetry'
    ) {
      return value;
    }

    return null;
  }

  private deriveClarificationDomain(
    ragflowContext: Record<string, unknown>,
  ): ChatClarificationDomain {
    const answerRoute =
      typeof ragflowContext.answerRoute === 'string'
        ? ragflowContext.answerRoute
        : '';
    const clarificationReason =
      typeof ragflowContext.clarificationReason === 'string'
        ? ragflowContext.clarificationReason
        : '';

    if (
      answerRoute === 'historical_telemetry' ||
      /^historical_telemetry(?:_|$)/i.test(clarificationReason) ||
      clarificationReason === 'historical_current_fallback_blocked' ||
      ragflowContext.historicalTelemetry === true
    ) {
      return 'historical_telemetry';
    }

    if (
      answerRoute === 'current_telemetry' ||
      clarificationReason === 'related_telemetry_options'
    ) {
      return 'current_telemetry';
    }

    return 'documentation';
  }

  private deriveRequiredClarificationFields(params: {
    clarificationDomain: ChatClarificationDomain;
    pendingQuery: string;
    normalizedQuery?: ChatNormalizedQuery;
    clarificationReason?: string;
    resolvedSubjectQuery?: string;
  }): ChatClarificationField[] {
    if (
      params.clarificationDomain === 'historical_telemetry' &&
      params.normalizedQuery?.ambiguityFlags.includes('missing_year')
    ) {
      return ['year'];
    }

    if (
      params.clarificationDomain === 'historical_telemetry' &&
      params.normalizedQuery?.timeIntent.absoluteDate &&
      params.normalizedQuery.ambiguityFlags.includes('missing_explicit_time')
    ) {
      return ['time_of_day'];
    }

    if (
      params.clarificationDomain === 'current_telemetry' &&
      params.clarificationReason === 'related_telemetry_options'
    ) {
      return ['metric_selection'];
    }

    if (
      params.clarificationDomain === 'historical_telemetry' &&
      params.clarificationReason === 'historical_current_fallback_blocked'
    ) {
      return ['metric_or_time_window'];
    }

    if (params.clarificationDomain === 'documentation') {
      return ['subject'];
    }

    return [];
  }

  private deriveResolvedClarificationFields(
    normalizedQuery?: ChatNormalizedQuery,
  ): Partial<Record<ChatClarificationField, string>> {
    const resolvedFields: Partial<Record<ChatClarificationField, string>> = {};

    if (normalizedQuery?.timeIntent.absoluteDate) {
      resolvedFields.date = normalizedQuery.timeIntent.absoluteDate;
    }

    if (normalizedQuery?.subject?.trim()) {
      resolvedFields.subject = normalizedQuery.subject.trim();
    }

    return resolvedFields;
  }

  private normalizeClarificationFields(
    value: unknown,
  ): ChatClarificationField[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const fields = value.filter(
      (field): field is ChatClarificationField =>
        field === 'subject' ||
        field === 'metric_selection' ||
        field === 'year' ||
        field === 'date' ||
        field === 'time_of_day' ||
        field === 'metric_or_time_window',
    );

    return [...new Set(fields)];
  }

  private normalizeResolvedClarificationFields(
    value: unknown,
  ): Partial<Record<ChatClarificationField, string>> | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const normalized: Partial<Record<ChatClarificationField, string>> = {};
    for (const [key, fieldValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        (key === 'subject' ||
          key === 'metric_selection' ||
          key === 'year' ||
          key === 'date' ||
          key === 'time_of_day' ||
          key === 'metric_or_time_window') &&
        typeof fieldValue === 'string' &&
        fieldValue.trim()
      ) {
        normalized[key] = fieldValue.trim();
      }
    }

    return normalized;
  }

  private normalizeHistoricalTimeReply(reply: string): string | null {
    const trimmed = reply.trim().replace(/[?!.]+$/g, '');
    if (!trimmed) {
      return null;
    }

    const clockWithMinutes = trimmed.match(
      /^(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s*utc)?$/i,
    );
    const meridiemOnly = trimmed.match(
      /^(?:at\s+)?(\d{1,2})\s*(am|pm)(?:\s*utc)?$/i,
    );
    const match = clockWithMinutes ?? meridiemOnly;
    if (!match) {
      return null;
    }

    let hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2] ?? '0', 10);
    const meridiem = match[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) {
      hours += 12;
    } else if (meridiem === 'am' && hours === 12) {
      hours = 0;
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
      2,
      '0',
    )} UTC`;
  }

  private normalizeHistoricalDateReply(reply: string): string | null {
    const trimmed = reply.trim().replace(/[?!.]+$/g, '');
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    return null;
  }

  private normalizeHistoricalYearReply(reply: string): string | null {
    const trimmed = reply.trim().replace(/[?!.]+$/g, '');
    return /^\d{4}$/.test(trimmed) ? trimmed : null;
  }
}
