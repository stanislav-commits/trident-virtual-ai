import { Injectable, Logger } from '@nestjs/common';
import type { ChatNormalizedQuery } from '../chat/chat.types';
import { ChatQueryPlannerService } from '../chat/chat-query-planner.service';
import {
  SEMANTIC_QUERY_CLARIFICATION_THRESHOLD,
  SEMANTIC_PROFILE_SCHEMA_VERSION,
} from './semantic.constants';
import { DOCUMENTATION_SEMANTIC_QUERY_SCHEMA } from './semantic.schemas';
import type {
  ConceptCandidate,
  ConceptDefinition,
  DocumentationFollowUpState,
  DocumentationSemanticQuery,
  SemanticAnswerFormat,
  SemanticConceptFamily,
  SemanticIntent,
  SemanticSourceCategory,
} from './semantic.types';
import {
  parseDocumentationSemanticQuery,
  serializeConceptCatalogEntry,
} from './semantic.validators';
import { ConceptCatalogService } from './concept-catalog.service';
import { SemanticLlmService } from './semantic-llm.service';

@Injectable()
export class DocumentationQuerySemanticNormalizerService {
  private readonly logger = new Logger(
    DocumentationQuerySemanticNormalizerService.name,
  );
  private readonly queryPlanner = new ChatQueryPlannerService();

  constructor(
    private readonly conceptCatalog: ConceptCatalogService,
    private readonly semanticLlm: SemanticLlmService,
  ) {}

  async normalize(params: {
    userQuery: string;
    retrievalQuery: string;
    normalizedQuery?: ChatNormalizedQuery;
    followUpState?: DocumentationFollowUpState | null;
  }): Promise<DocumentationSemanticQuery> {
    const queryText = this.buildQueryText(params);
    const conceptFamilies = await this.buildFamilyShortlist(queryText, params);
    const conceptCandidates = await this.conceptCatalog.shortlistConcepts(
      queryText,
      {
        families: conceptFamilies.length > 0 ? conceptFamilies : undefined,
        limit: 14,
      },
    );
    const conceptDefinitions =
      await this.resolveConceptDefinitions(conceptCandidates);
    const fallback = this.buildFallbackQuery(params, conceptCandidates);

    if (!this.semanticLlm.isConfigured()) {
      this.logger.debug(
        `Semantic query normalization using deterministic fallback: query="${this.truncate(params.userQuery)}" intent=${fallback.intent} concepts=${fallback.selectedConceptIds.join(',') || 'none'}`,
      );
      return fallback;
    }

    try {
      const raw = await this.semanticLlm.generateStructuredObject<unknown>({
        name: 'documentation_semantic_query',
        description:
          'Structured semantic interpretation of a vessel knowledge-base user query.',
        schema: DOCUMENTATION_SEMANTIC_QUERY_SCHEMA as Record<string, unknown>,
        instructions: this.buildInstructions(),
        input: this.buildPromptInput({
          ...params,
          conceptFamilies,
          conceptDefinitions,
        }),
      });
      const parsed = parseDocumentationSemanticQuery(raw);
      if (!parsed) {
        throw new Error('Semantic query payload did not match validator');
      }

      const normalized = this.postProcessQuery(
        parsed,
        fallback,
        conceptCandidates,
        params,
      );
      this.logger.debug(
        `Semantic query normalized intent=${normalized.intent} family=${normalized.conceptFamily} confidence=${normalized.confidence.toFixed(2)} selected=${normalized.selectedConceptIds.join(',') || 'none'} candidates=${normalized.candidateConceptIds.join(',') || 'none'} sources=${normalized.sourcePreferences.join(',') || 'none'} page=${normalized.pageHint ?? 'none'} source="${normalized.explicitSource ?? ''}"`,
      );
      return normalized;
    } catch (error) {
      this.logger.warn(
        `Semantic query normalization fallback used for "${this.truncate(params.userQuery)}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  private buildQueryText(params: {
    userQuery: string;
    retrievalQuery: string;
    followUpState?: DocumentationFollowUpState | null;
  }): string {
    return [
      params.userQuery,
      params.retrievalQuery,
      params.followUpState?.lockedManualTitle ?? '',
      ...(params.followUpState?.conceptIds ?? []),
      ...(params.followUpState?.systems ?? []),
      ...(params.followUpState?.equipment ?? []),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async buildFamilyShortlist(
    queryText: string,
    params: {
      normalizedQuery?: ChatNormalizedQuery;
      followUpState?: DocumentationFollowUpState | null;
    },
  ): Promise<SemanticConceptFamily[]> {
    const families = new Set<SemanticConceptFamily>();

    for (const family of await this.conceptCatalog.shortlistFamilies(
      queryText,
      4,
    )) {
      families.add(family);
    }

    const intentFamily = this.mapIntentToFamily(
      this.mapPlannerIntentToSemanticIntent(
        this.queryPlanner.classifyPrimaryIntent(queryText),
      ),
    );
    families.add(intentFamily);

    if (params.followUpState?.conceptIds.length) {
      for (const conceptId of params.followUpState.conceptIds) {
        const concept = await this.conceptCatalog.getConceptById(conceptId);
        if (concept) {
          families.add(concept.family);
        }
      }
    }

    return [...families].slice(0, 4);
  }

  private async resolveConceptDefinitions(
    candidates: ConceptCandidate[],
  ): Promise<ConceptDefinition[]> {
    const concepts = await this.conceptCatalog.listConcepts();
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    return candidates
      .map((candidate) => byId.get(candidate.conceptId))
      .filter((concept): concept is ConceptDefinition => Boolean(concept));
  }

  private buildInstructions(): string {
    return [
      'You normalize vessel knowledge-base user queries into strict JSON.',
      'Do not answer the user.',
      'Select canonical concepts only from the provided candidate concept shortlist.',
      'If no candidate concept fits, leave selectedConceptIds empty rather than inventing a concept.',
      'Prefer exact source/page/section hints when the user names a concrete manual/document title or asks for a page.',
      'When the user says "this manual", "that document", or similar contextual wording, keep explicitSource null and rely on follow-up state.',
      'Use sourcePreferences to route retrieval, not to answer the question.',
      'Set needsClarification only when the query cannot be safely routed even with follow-up state.',
    ].join('\n');
  }

  private buildPromptInput(params: {
    userQuery: string;
    retrievalQuery: string;
    normalizedQuery?: ChatNormalizedQuery;
    followUpState?: DocumentationFollowUpState | null;
    conceptFamilies: SemanticConceptFamily[];
    conceptDefinitions: ConceptDefinition[];
  }): string {
    const normalizedQuery = params.normalizedQuery
      ? JSON.stringify(params.normalizedQuery)
      : 'null';
    const followUpState = params.followUpState
      ? JSON.stringify(params.followUpState)
      : 'null';
    const concepts =
      params.conceptDefinitions.length > 0
        ? params.conceptDefinitions
            .map((concept) => `- ${serializeConceptCatalogEntry(concept)}`)
            .join('\n')
        : '- none';

    return [
      `Raw user query: ${params.userQuery}`,
      `Retrieval query: ${params.retrievalQuery}`,
      `Existing deterministic normalized query: ${normalizedQuery}`,
      `Prior documentation follow-up state: ${followUpState}`,
      `Candidate concept families: ${params.conceptFamilies.join(', ') || 'none'}`,
      'Candidate concepts:',
      concepts,
    ].join('\n\n');
  }

  private buildFallbackQuery(
    params: {
      userQuery: string;
      retrievalQuery: string;
      normalizedQuery?: ChatNormalizedQuery;
      followUpState?: DocumentationFollowUpState | null;
    },
    candidates: ConceptCandidate[],
  ): DocumentationSemanticQuery {
    const query = params.retrievalQuery || params.userQuery;
    const plannedIntent = this.queryPlanner.classifyPrimaryIntent(query);
    const intent = this.resolveFallbackIntent(
      this.mapPlannerIntentToSemanticIntent(plannedIntent),
      candidates[0]?.family,
    );
    const sourcePreferences = this.mergeSourcePreferences(
      this.mapNormalizedSourceHints(params.normalizedQuery),
      ...candidates.map((candidate) =>
        this.mapFamilyToSourcePreferences(candidate.family),
      ),
      params.followUpState?.sourcePreferences ?? [],
    );
    const selectedConceptIds = this.selectFallbackConceptIds(candidates);
    const confidence =
      selectedConceptIds.length > 0
        ? Math.min(0.78, 0.54 + candidates[0].score / 50)
        : 0.42;
    const contextualFollowUp = this.isContextualFollowUp(params.userQuery);

    const explicitSource = this.extractExplicitSource(params.userQuery);

    return {
      schemaVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
      intent,
      conceptFamily: candidates[0]?.family ?? this.mapIntentToFamily(intent),
      selectedConceptIds:
        selectedConceptIds.length > 0
          ? selectedConceptIds
          : contextualFollowUp
            ? (params.followUpState?.conceptIds ?? [])
            : [],
      candidateConceptIds: candidates.map((candidate) => candidate.conceptId),
      equipment: params.followUpState?.equipment ?? [],
      systems: params.followUpState?.systems ?? [],
      vendor: params.followUpState?.vendor ?? null,
      model: params.followUpState?.model ?? null,
      sourcePreferences,
      explicitSource,
      pageHint:
        this.extractPageHint(params.userQuery) ??
        (contextualFollowUp ? (params.followUpState?.pageHint ?? null) : null),
      sectionHint:
        this.extractSectionHint(params.userQuery) ??
        (contextualFollowUp
          ? (params.followUpState?.sectionHint ?? null)
          : null),
      answerFormat: this.detectAnswerFormat(params.userQuery),
      needsClarification:
        confidence < SEMANTIC_QUERY_CLARIFICATION_THRESHOLD &&
        !contextualFollowUp &&
        !explicitSource,
      clarificationReason:
        confidence < SEMANTIC_QUERY_CLARIFICATION_THRESHOLD &&
        !contextualFollowUp
          ? 'semantic_low_confidence'
          : null,
      confidence,
    };
  }

  private postProcessQuery(
    parsed: DocumentationSemanticQuery,
    fallback: DocumentationSemanticQuery,
    candidates: ConceptCandidate[],
    params: {
      userQuery: string;
      followUpState?: DocumentationFollowUpState | null;
    },
  ): DocumentationSemanticQuery {
    const candidateIds = candidates.map((candidate) => candidate.conceptId);
    const selectedConceptIds = parsed.selectedConceptIds.filter((conceptId) =>
      candidateIds.includes(conceptId),
    );
    const contextualFollowUp = this.isContextualFollowUp(params.userQuery);
    const inheritedConceptIds =
      contextualFollowUp && selectedConceptIds.length === 0
        ? (params.followUpState?.conceptIds ?? [])
        : [];
    const confidence = Math.max(0, Math.min(1, parsed.confidence));
    const pageHint =
      this.extractPageHint(params.userQuery) ??
      parsed.pageHint ??
      (contextualFollowUp ? (params.followUpState?.pageHint ?? null) : null);
    const sectionHint =
      this.extractSectionHint(params.userQuery) ??
      parsed.sectionHint ??
      (contextualFollowUp ? (params.followUpState?.sectionHint ?? null) : null);

    const explicitSource =
      this.sanitizeExplicitSource(parsed.explicitSource) ??
      this.extractExplicitSource(params.userQuery);

    return {
      ...parsed,
      schemaVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
      selectedConceptIds:
        selectedConceptIds.length > 0
          ? selectedConceptIds
          : inheritedConceptIds.length > 0
            ? inheritedConceptIds
            : fallback.selectedConceptIds,
      candidateConceptIds: candidateIds,
      sourcePreferences: this.mergeSourcePreferences(
        parsed.sourcePreferences,
        fallback.sourcePreferences,
      ),
      explicitSource,
      pageHint,
      sectionHint,
      confidence,
      needsClarification:
        parsed.needsClarification ||
        (confidence < SEMANTIC_QUERY_CLARIFICATION_THRESHOLD &&
          !contextualFollowUp &&
          !explicitSource),
      clarificationReason:
        parsed.clarificationReason ??
        (confidence < SEMANTIC_QUERY_CLARIFICATION_THRESHOLD &&
        !contextualFollowUp
          ? 'semantic_low_confidence'
          : null),
    };
  }

  private selectFallbackConceptIds(candidates: ConceptCandidate[]): string[] {
    if (candidates.length === 0) {
      return [];
    }

    const best = candidates[0].score;
    return candidates
      .filter((candidate) => candidate.score >= Math.max(6, best * 0.6))
      .slice(0, 3)
      .map((candidate) => candidate.conceptId);
  }

  private mapPlannerIntentToSemanticIntent(value: string): SemanticIntent {
    switch (value) {
      case 'maintenance_procedure':
      case 'maintenance_due_now':
      case 'next_due_calculation':
      case 'last_maintenance':
        return 'maintenance_procedure';
      case 'troubleshooting':
        return 'troubleshooting';
      case 'parts_fluids_consumables':
        return 'parts_lookup';
      case 'regulation_compliance':
        return 'regulation_compliance';
      case 'certificate_status':
        return 'certificate_lookup';
      case 'manual_specification':
        return 'manual_lookup';
      default:
        return 'general_information';
    }
  }

  private resolveFallbackIntent(
    plannedIntent: SemanticIntent,
    topFamily?: SemanticConceptFamily,
  ): SemanticIntent {
    if (plannedIntent !== 'general_information') {
      return plannedIntent;
    }

    switch (topFamily) {
      case 'operational_topic':
        return 'operational_procedure';
      case 'regulation_topic':
        return 'regulation_compliance';
      case 'certificate_topic':
        return 'certificate_lookup';
      case 'maintenance_topic':
        return 'maintenance_procedure';
      default:
        return plannedIntent;
    }
  }

  private mapIntentToFamily(intent: SemanticIntent): SemanticConceptFamily {
    switch (intent) {
      case 'maintenance_procedure':
      case 'troubleshooting':
      case 'parts_lookup':
      case 'manual_lookup':
        return 'asset_system';
      case 'operational_procedure':
        return 'operational_topic';
      case 'regulation_compliance':
        return 'regulation_topic';
      case 'certificate_lookup':
        return 'certificate_topic';
      default:
        return 'general_reference';
    }
  }

  private mapFamilyToSourcePreferences(
    family: SemanticConceptFamily,
  ): SemanticSourceCategory[] {
    switch (family) {
      case 'operational_topic':
        return ['HISTORY_PROCEDURES', 'REGULATION'];
      case 'regulation_topic':
        return ['REGULATION'];
      case 'certificate_topic':
        return ['CERTIFICATES', 'REGULATION'];
      default:
        return ['MANUALS'];
    }
  }

  private mapNormalizedSourceHints(
    normalizedQuery?: ChatNormalizedQuery,
  ): SemanticSourceCategory[] {
    const hints = normalizedQuery?.sourceHints ?? [];
    const mapped: SemanticSourceCategory[] = [];
    const add = (value: SemanticSourceCategory) => {
      if (!mapped.includes(value)) {
        mapped.push(value);
      }
    };

    for (const hint of hints) {
      if (hint === 'CERTIFICATES') add('CERTIFICATES');
      if (hint === 'REGULATION') add('REGULATION');
      if (hint === 'HISTORY') add('HISTORY_PROCEDURES');
      if (hint === 'DOCUMENTATION') add('MANUALS');
    }

    return mapped;
  }

  private mergeSourcePreferences(
    ...groups: Array<SemanticSourceCategory[]>
  ): SemanticSourceCategory[] {
    const result: SemanticSourceCategory[] = [];
    for (const group of groups) {
      for (const value of group) {
        if (!result.includes(value)) {
          result.push(value);
        }
      }
    }
    return result;
  }

  private detectAnswerFormat(query: string): SemanticAnswerFormat {
    if (/\b(step\s*by\s*step|procedure|how\s+to)\b/i.test(query)) {
      return 'step_by_step';
    }
    if (/\b(checklist|check\s+list)\b/i.test(query)) {
      return 'checklist';
    }
    if (/\b(table|tabular)\b/i.test(query)) {
      return 'table';
    }
    if (/\b(compare|comparison|versus|vs\.?)\b/i.test(query)) {
      return 'comparison';
    }
    if (/\b(summary|summarize|overview)\b/i.test(query)) {
      return 'summary';
    }
    return 'direct_answer';
  }

  private extractPageHint(query: string): number | null {
    const match = query.match(/\b(?:page|p\.?)\s*#?\s*(\d{1,4})\b/i);
    if (!match?.[1]) {
      return null;
    }
    const page = Number.parseInt(match[1], 10);
    return Number.isFinite(page) && page > 0 ? page : null;
  }

  private extractSectionHint(query: string): string | null {
    const trailingMatch = query.match(
      /\b(?:the\s+)?([a-z0-9][a-z0-9.\-_/ ]{0,40}?)\s+(?:section|chapter)\b/i,
    );
    const leadingMatch = query.match(
      /\b(?:section|chapter|paragraph|para\.?)\s+(?:about|on|for\s+)?([a-z0-9][a-z0-9.\-_/ ]{0,40})/i,
    );
    const match = trailingMatch ?? leadingMatch;
    return match?.[1] ? this.cleanSectionHint(match[1]) : null;
  }

  private cleanSectionHint(value: string): string | null {
    const normalized = value
      .replace(
        /^(?:(?:what|which|where|how|does|do|is|are|the|a|an|about|on|for|say|says|tell|show|give|me)\b[\s:,-]*)+/i,
        '',
      )
      .replace(
        /\b(?:in|from)\s+(?:this|that|same|current|previous)\s+(?:manual|guide|handbook|document|procedure|file|pdf|one)\b.*$/i,
        '',
      )
      .replace(/\b(?:say|says|mean|include|contain|show)\b.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized || null;
  }

  private extractExplicitSource(query: string): string | null {
    const match = query.match(
      /\b(?:according\s+to|from|inside|in)\s+(?:the\s+)?(.{2,90}?)\s+(manual|guide|handbook|document|procedure)\b/i,
    );
    const source = match?.[1]?.trim();
    return this.sanitizeExplicitSource(source);
  }

  private sanitizeExplicitSource(
    value: string | null | undefined,
  ): string | null {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    const lower = normalized
      .toLowerCase()
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
      .replace(/[.?!:;,\s]+$/g, '')
      .replace(/^(?:the|a|an)\s+/, '')
      .trim();
    const withoutDocumentNoun = lower
      .replace(
        /\s+(?:manual|guide|handbook|document|procedure|file|pdf|one)$/i,
        '',
      )
      .trim();
    const contextualSourceReferences = new Set([
      'this',
      'that',
      'same',
      'current',
      'previous',
      'last',
      'above',
      'earlier',
      'it',
      'one',
      'this one',
      'that one',
      'same one',
    ]);
    const genericSourceReferences = new Set([
      'manual',
      'guide',
      'handbook',
      'document',
      'procedure',
      'file',
      'pdf',
      'the manual',
      'the document',
      'the guide',
      'the procedure',
    ]);

    if (
      contextualSourceReferences.has(lower) ||
      contextualSourceReferences.has(withoutDocumentNoun) ||
      genericSourceReferences.has(lower)
    ) {
      return null;
    }

    if (
      /^(?:this|that|same|current|previous|last|above|earlier)\s+(?:manual|guide|handbook|document|procedure|file|pdf|one)$/i.test(
        lower,
      )
    ) {
      return null;
    }

    return normalized;
  }

  private isContextualFollowUp(query: string): boolean {
    return (
      /\b(this|that|same|current|previous)\s+(manual|guide|document|procedure|one)\b/i.test(
        query,
      ) || /\b(page|p\.?|section|chapter)\s*#?\s*\d{1,4}\b/i.test(query)
    );
  }

  private truncate(value: string, maxLength = 160): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }
}
