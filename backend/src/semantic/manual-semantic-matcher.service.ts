import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  DocumentationSemanticCandidate,
  DocumentationSemanticQuery,
  ManualSemanticProfile,
  SemanticSourceCategory,
} from './semantic.types';
import { parseManualSemanticProfile } from './semantic.validators';

interface SearchableSemanticManual {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  category: string | null;
  semanticProfile: unknown;
  tags?: Array<{
    tag: {
      key: string;
      category: string;
      subcategory: string;
      item: string;
      description: string | null;
    };
  }>;
}

interface DistinctiveQueryAnchor {
  token: string;
  emphasized: boolean;
}

interface ConcreteSubjectSignal {
  normalized: string;
  collapsed: string;
  tokens: string[];
  weight: number;
}

interface SpecificSubjectPhrase {
  normalized: string;
  collapsed: string;
  tokens: string[];
}

interface SpecificSubjectCandidateRank {
  candidate: DocumentationSemanticCandidate;
  specificityScore: number;
  explicitSourceMatched: boolean;
  vendorMatched: boolean;
  modelMatched: boolean;
  identifierMatched: boolean;
}

const PROFILE_MATCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'show',
  'tell',
  'the',
  'to',
  'what',
  'which',
  'with',
]);

const GENERIC_EXPLICIT_SOURCE_TOKENS = new Set([
  'document',
  'file',
  'guide',
  'handbook',
  'manual',
  'operator',
  'pdf',
  'procedure',
  'user',
]);

const QUERY_ANCHOR_STOP_WORDS = new Set([
  ...PROFILE_MATCH_STOP_WORDS,
  ...GENERIC_EXPLICIT_SOURCE_TOKENS,
  'alarm',
  'alarms',
  'catalog',
  'catalogue',
  'check',
  'configure',
  'configuration',
  'connect',
  'connecting',
  'connection',
  'control',
  'converter',
  'display',
  'equipment',
  'information',
  'inspect',
  'inspection',
  'install',
  'installation',
  'instruction',
  'kit',
  'limit',
  'limitation',
  'maintenance',
  'mode',
  'mount',
  'mounting',
  'operate',
  'operating',
  'operation',
  'overview',
  'page',
  'part',
  'procedure',
  'repair',
  'replace',
  'replacement',
  'service',
  'setup',
  'seal',
  'source',
  'spare',
  'system',
  'transfer',
  'transfers',
  'another',
  'unit',
  'vessel',
]);

const PROFILE_TEXT_QUERY_STOP_WORDS = new Set([
  ...PROFILE_MATCH_STOP_WORDS,
  ...GENERIC_EXPLICIT_SOURCE_TOKENS,
  'another',
  'configure',
  'configuration',
  'connect',
  'connecting',
  'connection',
  'control',
  'information',
  'inspect',
  'inspection',
  'install',
  'installation',
  'maintenance',
  'mount',
  'mounting',
  'operate',
  'operating',
  'operation',
  'overview',
  'procedure',
  'quick',
  'repair',
  'replace',
  'replacement',
  'service',
  'setup',
  'start',
  'startup',
  'transfer',
  'transfers',
]);

const CONCEPT_TEXT_STOP_WORDS = new Set([
  ...PROFILE_TEXT_QUERY_STOP_WORDS,
  'equipment',
  'sb',
  'system',
  'systems',
  'tag',
]);

@Injectable()
export class ManualSemanticMatcherService {
  private readonly logger = new Logger(ManualSemanticMatcherService.name);

  constructor(private readonly prisma: PrismaService) {}

  async shortlistManuals(params: {
    shipId: string | null;
    role: string;
    queryText: string;
    semanticQuery: DocumentationSemanticQuery;
    allowedDocumentCategories?: string[];
    limit?: number;
  }): Promise<DocumentationSemanticCandidate[]> {
    const manuals = await this.loadManuals(params);
    if (manuals.length === 0) {
      return [];
    }

    const candidates = this.filterSpecificSubjectCandidates(
      this.filterConcreteSubjectCandidates(
        manuals
          .map((manual) => this.scoreManual(manual, params))
          .filter((candidate) => candidate.score > 0),
        params,
      ),
      params,
    )
      .sort((left, right) => right.score - left.score)
      .slice(0, params.limit ?? 8);

    if (candidates.length > 0) {
      this.logger.debug(
        `Semantic manual shortlist query="${this.truncate(params.queryText)}" intent=${params.semanticQuery.intent} concepts=${params.semanticQuery.selectedConceptIds.join(',') || 'none'} candidates=${candidates.map((candidate) => `${candidate.manualId}:${candidate.score.toFixed(1)}`).join(',')}`,
      );
    }

    return candidates;
  }

  private async loadManuals(params: {
    shipId: string | null;
    role: string;
    allowedDocumentCategories?: string[];
  }): Promise<SearchableSemanticManual[]> {
    const categoryFilter = this.buildCategoryFilter(
      params.allowedDocumentCategories,
    );

    if (params.shipId && params.role !== 'admin') {
      const ship = await this.prisma.ship.findUnique({
        where: { id: params.shipId },
        select: {
          manuals: {
            where: categoryFilter
              ? { category: { in: categoryFilter } }
              : undefined,
            select: {
              id: true,
              ragflowDocumentId: true,
              filename: true,
              category: true,
              semanticProfile: true,
              tags: {
                select: {
                  tag: {
                    select: {
                      key: true,
                      category: true,
                      subcategory: true,
                      item: true,
                      description: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      return ship?.manuals ?? [];
    }

    return this.prisma.shipManual.findMany({
      where: categoryFilter ? { category: { in: categoryFilter } } : undefined,
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        category: true,
        semanticProfile: true,
        tags: {
          select: {
            tag: {
              select: {
                key: true,
                category: true,
                subcategory: true,
                item: true,
                description: true,
              },
            },
          },
        },
      },
    });
  }

  private scoreManual(
    manual: SearchableSemanticManual,
    params: {
      queryText: string;
      semanticQuery: DocumentationSemanticQuery;
    },
  ): DocumentationSemanticCandidate {
    const profile = parseManualSemanticProfile(manual.semanticProfile);
    const reasons: string[] = [];
    let score = 0;
    const category = this.normalizeCategory(manual.category);
    const semanticQuery = params.semanticQuery;

    const explicitSourceScore = this.scoreExplicitSource(
      manual.filename,
      semanticQuery.explicitSource,
    );
    if (explicitSourceScore > 0) {
      score += explicitSourceScore;
      reasons.push('explicit_source');
    }

    const filenameScore = this.scoreTextOverlap(
      manual.filename,
      params.queryText,
    );
    if (filenameScore > 0) {
      score += filenameScore;
      reasons.push('filename_overlap');
    }

    const anchorScore = this.scoreDistinctiveQueryAnchors(
      manual,
      profile,
      params.queryText,
    );
    if (anchorScore > 0) {
      score += anchorScore;
      reasons.push('query_anchor');
    }

    const sourcePreferenceScore = this.scoreSourcePreference(
      category,
      semanticQuery.sourcePreferences,
    );
    if (sourcePreferenceScore > 0) {
      score += sourcePreferenceScore;
      reasons.push('source_preference');
    }

    const tagScore = this.scoreManualTags(manual, semanticQuery, params.queryText);
    if (tagScore.score > 0) {
      score += tagScore.score;
      reasons.push(...tagScore.reasons);
    }

    if (profile) {
      const profileScore = this.scoreSemanticProfile(
        profile,
        semanticQuery,
        params.queryText,
      );
      if (profileScore.score > 0) {
        score += profileScore.score;
        reasons.push(...profileScore.reasons);
      }
    }

    const concreteSubjectScore = this.scoreConcreteSubjectSignals(
      manual,
      profile,
      params.semanticQuery,
      params.queryText,
    );
    if (concreteSubjectScore > 0) {
      score += concreteSubjectScore;
      reasons.push('concrete_subject');
    }

    return {
      manualId: manual.id,
      documentId: manual.ragflowDocumentId,
      filename: manual.filename,
      category,
      score,
      reasons: [...new Set(reasons)],
      semanticProfile: profile,
    };
  }

  private scoreSemanticProfile(
    profile: ManualSemanticProfile,
    query: DocumentationSemanticQuery,
    queryText: string,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    if (profile.documentType === query.intent) {
      score += 18;
      reasons.push('intent');
    } else if (this.areCompatibleIntents(profile.documentType, query.intent)) {
      score += 8;
      reasons.push('compatible_intent');
    }

    if (
      profile.sourceCategory &&
      query.sourcePreferences.includes(profile.sourceCategory)
    ) {
      score += 8;
      reasons.push('profile_source');
    }

    const primaryConcepts = new Set(profile.primaryConceptIds);
    const secondaryConcepts = new Set(profile.secondaryConceptIds);
    for (const conceptId of query.selectedConceptIds) {
      if (primaryConcepts.has(conceptId)) {
        score += 28;
        reasons.push('primary_concept');
      } else if (secondaryConcepts.has(conceptId)) {
        score += 14;
        reasons.push('secondary_concept');
      }
    }

    for (const conceptId of query.candidateConceptIds) {
      if (primaryConcepts.has(conceptId) || secondaryConcepts.has(conceptId)) {
        score += 2;
      }
    }

    score += this.scoreArrayOverlap(profile.systems, query.systems) * 8;
    score += this.scoreArrayOverlap(profile.equipment, query.equipment) * 8;
    const systemOverlapScore = this.scoreStructuredPhraseOverlap(
      profile.systems,
      query.systems,
    );
    if (systemOverlapScore > 0) {
      score += systemOverlapScore * 6;
      reasons.push('system_overlap');
    }
    const equipmentOverlapScore = this.scoreStructuredPhraseOverlap(
      profile.equipment,
      query.equipment,
    );
    if (equipmentOverlapScore > 0) {
      score += equipmentOverlapScore * 8;
      reasons.push('equipment_overlap');
    }

    if (
      query.vendor &&
      profile.vendor &&
      this.normalizeText(query.vendor) === this.normalizeText(profile.vendor)
    ) {
      score += 16;
      reasons.push('vendor');
    }

    if (
      query.model &&
      profile.model &&
      this.normalizeText(query.model) === this.normalizeText(profile.model)
    ) {
      score += 16;
      reasons.push('model');
    }

    const sectionConcepts = new Set(
      profile.sections.flatMap((section) => section.conceptIds),
    );
    const pageConcepts = new Set(
      profile.pageTopics.flatMap((topic) => topic.conceptIds),
    );
    for (const conceptId of query.selectedConceptIds) {
      if (sectionConcepts.has(conceptId) || pageConcepts.has(conceptId)) {
        score += 6;
        reasons.push('structured_concept');
      }
    }

    const selectedConceptTextScore = this.scoreSelectedConceptText(
      profile,
      query.selectedConceptIds.filter(
        (conceptId) =>
          !primaryConcepts.has(conceptId) &&
          !secondaryConcepts.has(conceptId) &&
          !sectionConcepts.has(conceptId) &&
          !pageConcepts.has(conceptId),
      ),
    );
    if (selectedConceptTextScore > 0) {
      score += selectedConceptTextScore;
      reasons.push('selected_concept_text');
    }

    const profileTextScore = this.scoreProfileText(profile, queryText);
    if (profileTextScore > 0) {
      score += profileTextScore;
      reasons.push('profile_text');
    }

    const sectionHintScore = this.scoreSectionHint(profile, query);
    if (sectionHintScore > 0) {
      score += sectionHintScore;
      reasons.push('section_hint');
    }

    return { score, reasons };
  }

  private scoreManualTags(
    manual: SearchableSemanticManual,
    query: DocumentationSemanticQuery,
    queryText: string,
  ): { score: number; reasons: string[] } {
    const manualTags = manual.tags ?? [];
    const tagKeys = manualTags.map((entry) => entry.tag.key);
    if (tagKeys.length === 0) {
      return { score: 0, reasons: [] };
    }

    const reasons: string[] = [];
    let score = 0;

    const selectedTagConcepts = query.selectedConceptIds
      .filter((conceptId) => conceptId.startsWith('tag:'))
      .map((conceptId) => conceptId.slice(4));
    const candidateTagConcepts = query.candidateConceptIds
      .filter((conceptId) => conceptId.startsWith('tag:'))
      .map((conceptId) => conceptId.slice(4));
    const tagKeySet = new Set(tagKeys);

    for (const tagKey of selectedTagConcepts) {
      if (tagKeySet.has(tagKey)) {
        score += 30;
        reasons.push('manual_tag');
      }
    }

    for (const tagKey of candidateTagConcepts) {
      if (tagKeySet.has(tagKey)) {
        score += 4;
      }
    }

    const queryTokens = this.tokenize(queryText).filter(
      (token) => !PROFILE_TEXT_QUERY_STOP_WORDS.has(token),
    );
    if (queryTokens.length > 0) {
      const scoreBeforeTagText = score;
      const manualTagText = manualTags
        .flatMap(({ tag }) => [
          tag.key,
          tag.category,
          tag.subcategory,
          tag.item,
          tag.description,
        ])
        .filter((value): value is string => Boolean(value))
        .join(' ');
      score += this.scoreProfileField(manualTagText, queryTokens, 4, 20);
      if (score > scoreBeforeTagText) {
        reasons.push('manual_tag_text');
      }
    }

    return { score, reasons: [...new Set(reasons)] };
  }

  private filterConcreteSubjectCandidates(
    candidates: DocumentationSemanticCandidate[],
    params: {
      queryText: string;
      semanticQuery: DocumentationSemanticQuery;
    },
  ): DocumentationSemanticCandidate[] {
    const subjectSignals = this.collectConcreteSubjectSignals(
      params.semanticQuery,
      params.queryText,
    );
    if (
      subjectSignals.length === 0 ||
      !this.shouldRequireConcreteSubjectEvidence(
        params.semanticQuery,
        subjectSignals,
      )
    ) {
      return candidates;
    }

    const concreteMatches = candidates.filter((candidate) =>
      candidate.reasons.includes('concrete_subject'),
    );
    if (concreteMatches.length > 0) {
      return concreteMatches;
    }

    const gatedCandidates = candidates.filter((candidate) =>
      this.hasConcreteSubjectEvidence(candidate),
    );
    return gatedCandidates.length > 0 ? gatedCandidates : candidates;
  }

  private filterSpecificSubjectCandidates(
    candidates: DocumentationSemanticCandidate[],
    params: {
      queryText: string;
      semanticQuery: DocumentationSemanticQuery;
    },
  ): DocumentationSemanticCandidate[] {
    if (candidates.length <= 1) {
      return candidates;
    }

    const queryVendor = this.normalizeText(params.semanticQuery.vendor ?? '');
    const queryModel = this.normalizeText(params.semanticQuery.model ?? '');
    const explicitSource = this.normalizeText(
      params.semanticQuery.explicitSource ?? '',
    );
    const sectionHint = this.normalizeText(params.semanticQuery.sectionHint ?? '');
    const queryIdentifiers = new Set(
      this.extractIdentifierAnchors([
        params.queryText,
        params.semanticQuery.model,
        ...params.semanticQuery.equipment,
        ...params.semanticQuery.systems,
      ]),
    );
    const subjectPhrases = this.collectSpecificSubjectPhrases(
      params.semanticQuery,
    );

    if (
      !queryVendor &&
      !queryModel &&
      !explicitSource &&
      !sectionHint &&
      queryIdentifiers.size === 0 &&
      subjectPhrases.length === 0
    ) {
      return candidates;
    }

    const rankedCandidates = candidates.map((candidate) => ({
      candidate,
      explicitSourceMatched: this.matchesExplicitSourceHint(
        candidate,
        explicitSource,
      ),
      vendorMatched: this.matchesVendorHint(candidate, queryVendor),
      modelMatched: this.matchesModelHint(candidate, queryModel),
      identifierMatched: this.matchesIdentifierHint(candidate, queryIdentifiers),
      specificityScore: this.scoreSpecificSubjectCandidate(candidate, {
        queryVendor,
        queryModel,
        explicitSource,
        sectionHint,
        queryIdentifiers,
        subjectPhrases,
      }),
    }));
    const anchoredCandidates =
      this.filterByHardSpecificityAnchors(rankedCandidates);
    const bestScore = Math.max(
      ...anchoredCandidates.map((entry) => entry.specificityScore),
    );

    if (bestScore <= 0) {
      return anchoredCandidates.map((entry) => entry.candidate);
    }

    return anchoredCandidates
      .filter((entry) => entry.specificityScore === bestScore)
      .map((entry) => entry.candidate);
  }

  private scoreProfileText(
    profile: ManualSemanticProfile,
    queryText: string,
  ): number {
    const queryTokens = this.tokenize(queryText).filter(
      (token) => !PROFILE_TEXT_QUERY_STOP_WORDS.has(token),
    );
    if (queryTokens.length === 0) {
      return 0;
    }

    let score = 0;
    score += this.scoreProfileField(profile.vendor, queryTokens, 14);
    score += this.scoreProfileField(profile.model, queryTokens, 18);
    score += this.scoreProfileFields(profile.aliases, queryTokens, 5, 24);
    score += this.scoreProfileFields(profile.equipment, queryTokens, 4, 22);
    score += this.scoreProfileFields(profile.systems, queryTokens, 5, 28);
    score += this.scoreProfileFields(
      profile.sections.map((section) => section.title),
      queryTokens,
      6,
      28,
    );
    score += this.scoreProfileFields(
      profile.sections.map((section) => section.summary),
      queryTokens,
      3,
      18,
    );
    score += this.scoreProfileField(profile.summary, queryTokens, 3, 18);
    score += this.scoreProfileFields(
      profile.pageTopics.map((topic) => topic.summary),
      queryTokens,
      3,
      18,
    );

    return Math.min(score, 72);
  }

  private scoreSectionHint(
    profile: ManualSemanticProfile,
    query: DocumentationSemanticQuery,
  ): number {
    const normalizedHint = this.normalizeText(query.sectionHint ?? '');
    if (!normalizedHint) {
      return 0;
    }

    const hintTokens = [...this.tokenizeStructuredPhrase(normalizedHint)].filter(
      (token) => token.length > 3 || /\d/.test(token),
    );
    if (hintTokens.length === 0) {
      return 0;
    }

    const searchableText = [
      profile.summary,
      ...profile.sections.flatMap((section) => [section.title, section.summary]),
      ...profile.pageTopics.map((topic) => topic.summary),
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ');
    const normalizedSearchableText = this.normalizeText(searchableText);
    if (!normalizedSearchableText) {
      return 0;
    }

    const collapsedSearchableText = this.collapseText(searchableText);
    const searchableTokens = new Set(this.tokenize(normalizedSearchableText));
    const matchedTokens = hintTokens.filter((token) =>
      this.matchesToken(searchableTokens, collapsedSearchableText, token),
    );
    if (matchedTokens.length === 0) {
      return 0;
    }

    let score = 0;
    if (
      normalizedSearchableText.includes(normalizedHint) ||
      collapsedSearchableText.includes(this.collapseText(normalizedHint))
    ) {
      score += 10;
    } else {
      const overlapRatio = matchedTokens.length / hintTokens.length;
      if (overlapRatio >= 0.8) {
        score += 8;
      } else if (overlapRatio >= 0.5) {
        score += 5;
      } else if (
        matchedTokens.some((token) => token.length >= 7 || /\d/.test(token))
      ) {
        score += 3;
      }
    }

    if (
      this.isProcedureIntent(query.intent) &&
      profile.sections.some(
        (section) =>
          section.sectionType === 'procedure' &&
          this.matchesSectionHintText(
            `${section.title} ${section.summary ?? ''}`,
            normalizedHint,
            hintTokens,
          ),
      )
    ) {
      score += 6;
    }

    return Math.min(score, 18);
  }

  private areCompatibleIntents(
    documentType: ManualSemanticProfile['documentType'],
    queryIntent: DocumentationSemanticQuery['intent'],
  ): boolean {
    const procedureIntents = new Set([
      'maintenance_procedure',
      'operational_procedure',
      'troubleshooting',
      'regulation_compliance',
    ]);
    return (
      procedureIntents.has(documentType) && procedureIntents.has(queryIntent)
    );
  }

  private scoreProfileFields(
    values: string[],
    queryTokens: string[],
    perToken: number,
    maxScore: number,
  ): number {
    return Math.min(
      values.reduce(
        (total, value) =>
          total + this.scoreProfileField(value, queryTokens, perToken),
        0,
      ),
      maxScore,
    );
  }

  private scoreProfileField(
    value: string | null | undefined,
    queryTokens: string[],
    perToken: number,
    maxScore = 24,
  ): number {
    if (!value) {
      return 0;
    }

    const normalizedValue = this.normalizeText(value);
    const fieldTokens = new Set(this.tokenize(normalizedValue));
    const collapsedValue = this.collapseText(normalizedValue);
    if (fieldTokens.size === 0) {
      return 0;
    }

    const matches = queryTokens.filter((token) =>
      this.matchesToken(fieldTokens, collapsedValue, token),
    );
    return Math.min(matches.length * perToken, maxScore);
  }

  private scoreSelectedConceptText(
    profile: ManualSemanticProfile,
    selectedConceptIds: string[],
  ): number {
    if (selectedConceptIds.length === 0) {
      return 0;
    }

    const profileTokens = new Set(
      this.tokenize(this.buildProfileAnchorText(profile)),
    );
    if (profileTokens.size === 0) {
      return 0;
    }

    const conceptTokens = [
      ...new Set(
        selectedConceptIds
          .flatMap((conceptId) => this.tokenize(conceptId))
          .filter(
            (token) => token.length > 2 && !CONCEPT_TEXT_STOP_WORDS.has(token),
          ),
      ),
    ];
    if (conceptTokens.length === 0) {
      return 0;
    }

    const matches = conceptTokens.filter((token) => profileTokens.has(token));
    return Math.min(matches.length * 8, 24);
  }

  private buildCategoryFilter(categories?: string[]): string[] | null {
    const normalized =
      categories
        ?.map((category) => this.normalizeCategory(category))
        .filter((category): category is string => Boolean(category)) ?? [];
    return normalized.length > 0 ? [...new Set(normalized)] : null;
  }

  private scoreExplicitSource(
    filename: string,
    explicitSource: string | null,
  ): number {
    if (!explicitSource) {
      return 0;
    }

    const normalizedFilename = this.normalizeText(filename);
    const normalizedSource = this.normalizeText(explicitSource);
    if (!normalizedSource) {
      return 0;
    }

    if (normalizedFilename.includes(normalizedSource)) {
      return 90;
    }

    const sourceTokens = normalizedSource
      .split(' ')
      .filter(
        (token) =>
          token.length > 2 && !GENERIC_EXPLICIT_SOURCE_TOKENS.has(token),
      );
    if (sourceTokens.length === 0) {
      return 0;
    }

    const matchedTokens = sourceTokens.filter((token) =>
      normalizedFilename.includes(token),
    ).length;

    if (matchedTokens === sourceTokens.length) {
      return sourceTokens.length === 1 ? 36 : 60;
    }

    return matchedTokens >= Math.min(2, sourceTokens.length)
      ? matchedTokens * 8
      : 0;
  }

  private scoreTextOverlap(left: string, right: string): number {
    const normalizedLeft = this.normalizeText(left);
    const leftTokens = new Set(
      this.tokenize(normalizedLeft).filter((token) => token.length > 2),
    );
    const collapsedLeft = this.collapseText(normalizedLeft);
    const rightTokens = [
      ...new Set(
        this.tokenize(right).filter(
          (token) =>
            token.length > 2 && !PROFILE_TEXT_QUERY_STOP_WORDS.has(token),
        ),
      ),
    ];

    let overlap = 0;
    for (const token of rightTokens) {
      if (this.matchesToken(leftTokens, collapsedLeft, token)) {
        overlap += /\d/.test(token) || token.length >= 6 ? 3 : 1;
      }
    }

    return Math.min(overlap * 2, 30);
  }

  private scoreDistinctiveQueryAnchors(
    manual: SearchableSemanticManual,
    profile: ManualSemanticProfile | null,
    queryText: string,
  ): number {
    const anchors = this.extractDistinctiveQueryAnchors(queryText);
    if (anchors.length === 0) {
      return 0;
    }

    const normalizedFilename = this.normalizeText(manual.filename);
    const filenameTokens = new Set(this.tokenize(normalizedFilename));
    const collapsedFilename = this.collapseText(normalizedFilename);
    const profileTokens = profile
      ? new Set(this.tokenize(this.buildProfileAnchorText(profile)))
      : new Set<string>();
    const collapsedProfile = profile
      ? this.collapseText(this.buildProfileAnchorText(profile))
      : '';
    let matchedAnchors = 0;
    let score = 0;

    for (const anchor of anchors) {
      if (this.matchesToken(filenameTokens, collapsedFilename, anchor.token)) {
        matchedAnchors += 1;
        score += this.queryAnchorWeight(anchor, true);
        continue;
      }

      if (this.matchesToken(profileTokens, collapsedProfile, anchor.token)) {
        matchedAnchors += 1;
        score += this.queryAnchorWeight(anchor, false);
      }
    }

    if (matchedAnchors === 0) {
      return 0;
    }

    if (matchedAnchors >= 2) {
      score += 16;
    }
    if (matchedAnchors >= 3) {
      score += 18;
    }

    return Math.min(score, 120);
  }

  private scoreConcreteSubjectSignals(
    manual: SearchableSemanticManual,
    profile: ManualSemanticProfile | null,
    semanticQuery: DocumentationSemanticQuery,
    queryText: string,
  ): number {
    const signals = this.collectConcreteSubjectSignals(semanticQuery, queryText);
    if (signals.length === 0) {
      return 0;
    }

    const normalizedManualSubject = this.buildManualSubjectText(manual, profile);
    if (!normalizedManualSubject) {
      return 0;
    }

    const manualTokens = new Set(this.tokenize(normalizedManualSubject));
    const collapsedManual = this.collapseText(normalizedManualSubject);
    let score = 0;
    let matches = 0;

    for (const signal of signals) {
      if (
        this.matchesConcreteSubjectSignal(
          signal,
          normalizedManualSubject,
          manualTokens,
          collapsedManual,
        )
      ) {
        matches += 1;
        score += signal.weight;
      }
    }

    if (matches >= 2) {
      score += 8;
    }

    return Math.min(score, 72);
  }

  private extractDistinctiveQueryAnchors(
    queryText: string,
  ): DistinctiveQueryAnchor[] {
    const emphasizedTokens = new Set(
      [
        ...(queryText.match(/\b[A-Z0-9]{2,}(?:[.\-][A-Z0-9]+)*\b/g) ?? []),
        ...(queryText.match(/\b[A-Z][A-Za-z0-9]{4,}\b/g) ?? []),
      ].flatMap((value) => this.tokenize(value)),
    );
    const seen = new Set<string>();
    const anchors: DistinctiveQueryAnchor[] = [];

    for (const token of this.tokenize(queryText)) {
      if (
        token.length <= 2 ||
        QUERY_ANCHOR_STOP_WORDS.has(token) ||
        seen.has(token)
      ) {
        continue;
      }

      const emphasized = emphasizedTokens.has(token);
      if (!emphasized && !/\d/.test(token) && token.length < 7) {
        continue;
      }

      seen.add(token);
      anchors.push({ token, emphasized });
    }

    return anchors;
  }

  private collectConcreteSubjectSignals(
    semanticQuery: DocumentationSemanticQuery,
    queryText: string,
  ): ConcreteSubjectSignal[] {
    const signals: ConcreteSubjectSignal[] = [];
    const seen = new Set<string>();
    const addSignal = (
      value: string | null | undefined,
      weight: number,
      options?: { allowGeneric?: boolean },
    ) => {
      const normalized = this.normalizeText(value ?? '');
      if (!normalized) {
        return;
      }

      const tokens = this.tokenizeStructuredPhrase(normalized);
      if (tokens.size === 0) {
        return;
      }

      const tokenList = [...tokens];
      if (
        !options?.allowGeneric &&
        !this.isConcreteSubjectTokenList(tokenList)
      ) {
        return;
      }

      const key = tokenList.join(' ');
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      signals.push({
        normalized: tokenList.join(' '),
        collapsed: tokenList.join(''),
        tokens: tokenList,
        weight,
      });
    };

    addSignal(semanticQuery.explicitSource, 28, { allowGeneric: true });
    addSignal(semanticQuery.vendor, 22, { allowGeneric: true });
    addSignal(semanticQuery.model, 22, { allowGeneric: true });

    for (const equipment of semanticQuery.equipment) {
      addSignal(equipment, this.tokenizeStructuredPhrase(equipment).size > 1 ? 18 : 14);
    }
    for (const system of semanticQuery.systems) {
      addSignal(system, this.tokenizeStructuredPhrase(system).size > 1 ? 16 : 12);
    }
    for (const anchor of this.extractDistinctiveQueryAnchors(queryText)) {
      addSignal(anchor.token, anchor.emphasized ? 18 : 14);
    }

    return signals;
  }

  private isConcreteSubjectTokenList(tokens: string[]): boolean {
    return (
      tokens.length > 1 ||
      tokens.some((token) => token.length >= 7 || /\d/.test(token))
    );
  }

  private shouldRequireConcreteSubjectEvidence(
    semanticQuery: DocumentationSemanticQuery,
    signals: ConcreteSubjectSignal[],
  ): boolean {
    return (
      Boolean(semanticQuery.explicitSource) ||
      Boolean(semanticQuery.vendor) ||
      Boolean(semanticQuery.model) ||
      semanticQuery.equipment.length > 0 ||
      semanticQuery.systems.length > 0 ||
      signals.some(
        (signal) =>
          signal.tokens.length > 1 ||
          signal.tokens[0].length >= 7 ||
          /\d/.test(signal.tokens[0]),
      )
    );
  }

  private hasConcreteSubjectEvidence(
    candidate: DocumentationSemanticCandidate,
  ): boolean {
    const concreteReasons = new Set([
      'explicit_source',
      'filename_overlap',
      'model',
      'query_anchor',
      'vendor',
    ]);
    return candidate.reasons.some((reason) => concreteReasons.has(reason));
  }

  private scoreSpecificSubjectCandidate(
    candidate: DocumentationSemanticCandidate,
    params: {
      queryVendor: string;
      queryModel: string;
      explicitSource: string;
      sectionHint: string;
      queryIdentifiers: Set<string>;
      subjectPhrases: SpecificSubjectPhrase[];
    },
  ): number {
    const subjectText = this.buildCandidateSubjectText(candidate);
    const normalizedSubject = this.normalizeText(subjectText);
    const collapsedSubject = this.collapseText(subjectText);
    const subjectTokens = new Set(this.tokenize(normalizedSubject));
    const subjectIdentifiers = new Set(
      this.extractIdentifierAnchors([subjectText]),
    );
    const candidateVendor = this.normalizeText(
      candidate.semanticProfile?.vendor ?? '',
    );
    const candidateModel = this.normalizeText(
      candidate.semanticProfile?.model ?? '',
    );

    let score = 0;

    if (params.explicitSource) {
      const sourceTokens = params.explicitSource
        .split(' ')
        .filter(
          (token) =>
            token.length > 2 && !GENERIC_EXPLICIT_SOURCE_TOKENS.has(token),
        );
      if (
        normalizedSubject.includes(params.explicitSource) ||
        (sourceTokens.length > 0 &&
          sourceTokens.every((token) => normalizedSubject.includes(token)))
      ) {
        score += 8;
      }
    }

    if (
      params.queryModel &&
      candidateModel &&
      params.queryModel === candidateModel
    ) {
      score += 6;
    }

    if (params.queryIdentifiers.size > 0) {
      const identifierMatches = [...params.queryIdentifiers].filter((identifier) =>
        subjectIdentifiers.has(identifier),
      ).length;
      score += identifierMatches * 6;
    }

    if (params.sectionHint && candidate.reasons.includes('section_hint')) {
      score += 8;
    }

    if (params.subjectPhrases.length > 0) {
      score += params.subjectPhrases.reduce(
        (total, phrase) =>
          total +
          this.scoreSpecificSubjectPhraseMatch(
            phrase,
            normalizedSubject,
            collapsedSubject,
            subjectTokens,
          ),
        0,
      );
    }

    if (candidate.reasons.includes('manual_tag')) {
      score += 5;
    }
    if (candidate.reasons.includes('manual_tag_text')) {
      score += 3;
    }

    if (
      params.queryVendor &&
      (candidateVendor === params.queryVendor ||
        normalizedSubject.includes(params.queryVendor))
    ) {
      score += 2;
    }

    return score;
  }

  private filterByHardSpecificityAnchors(
    rankedCandidates: SpecificSubjectCandidateRank[],
  ): SpecificSubjectCandidateRank[] {
    let scopedCandidates = rankedCandidates;

    const exactModelOrIdentifierMatches = scopedCandidates.filter(
      (entry) => entry.modelMatched || entry.identifierMatched,
    );
    if (exactModelOrIdentifierMatches.length > 0) {
      scopedCandidates = exactModelOrIdentifierMatches;
    }

    const explicitSourceMatches = scopedCandidates.filter(
      (entry) => entry.explicitSourceMatched,
    );
    if (explicitSourceMatches.length > 0) {
      scopedCandidates = explicitSourceMatches;
    }

    const vendorMatches = scopedCandidates.filter((entry) => entry.vendorMatched);
    if (vendorMatches.length > 0) {
      scopedCandidates = vendorMatches;
    }

    return scopedCandidates;
  }

  private matchesExplicitSourceHint(
    candidate: DocumentationSemanticCandidate,
    explicitSource: string,
  ): boolean {
    if (!explicitSource) {
      return false;
    }

    const normalizedSubject = this.normalizeText(
      this.buildCandidateSubjectText(candidate),
    );
    if (!normalizedSubject) {
      return false;
    }

    if (normalizedSubject.includes(explicitSource)) {
      return true;
    }

    const sourceTokens = explicitSource
      .split(' ')
      .filter(
        (token) => token.length > 2 && !GENERIC_EXPLICIT_SOURCE_TOKENS.has(token),
      );
    return (
      sourceTokens.length > 0 &&
      sourceTokens.every((token) => normalizedSubject.includes(token))
    );
  }

  private matchesVendorHint(
    candidate: DocumentationSemanticCandidate,
    queryVendor: string,
  ): boolean {
    if (!queryVendor) {
      return false;
    }

    const subjectText = this.buildCandidateSubjectText(candidate);
    const normalizedSubject = this.normalizeText(subjectText);
    const candidateVendor = this.normalizeText(
      candidate.semanticProfile?.vendor ?? '',
    );

    return (
      candidateVendor === queryVendor || normalizedSubject.includes(queryVendor)
    );
  }

  private matchesModelHint(
    candidate: DocumentationSemanticCandidate,
    queryModel: string,
  ): boolean {
    if (!queryModel) {
      return false;
    }

    const candidateModel = this.normalizeText(
      candidate.semanticProfile?.model ?? '',
    );
    return candidateModel === queryModel;
  }

  private matchesIdentifierHint(
    candidate: DocumentationSemanticCandidate,
    queryIdentifiers: Set<string>,
  ): boolean {
    if (queryIdentifiers.size === 0) {
      return false;
    }

    const subjectIdentifiers = new Set(
      this.extractIdentifierAnchors([this.buildCandidateSubjectText(candidate)]),
    );
    return [...queryIdentifiers].some((identifier) =>
      subjectIdentifiers.has(identifier),
    );
  }

  private buildCandidateSubjectText(
    candidate: DocumentationSemanticCandidate,
  ): string {
    const profile = candidate.semanticProfile ?? null;
    return [
      candidate.filename,
      profile?.vendor,
      profile?.model,
      ...(profile?.aliases ?? []),
      ...(profile?.equipment ?? []),
      ...(profile?.systems ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ');
  }

  private buildManualSubjectText(
    manual: SearchableSemanticManual,
    profile: ManualSemanticProfile | null,
  ): string {
    const tagText = (manual.tags ?? [])
      .flatMap(({ tag }) => [
        tag.key,
        tag.category,
        tag.subcategory,
        tag.item,
        tag.description,
      ])
      .filter((value): value is string => Boolean(value))
      .join(' ');

    return this.normalizeText(
      [
        manual.filename,
        profile?.vendor,
        profile?.model,
        ...(profile?.aliases ?? []),
        ...(profile?.equipment ?? []),
        ...(profile?.systems ?? []),
        tagText,
      ]
        .filter((value): value is string => Boolean(value))
        .join(' '),
    );
  }

  private collectSpecificSubjectPhrases(
    semanticQuery: DocumentationSemanticQuery,
  ): SpecificSubjectPhrase[] {
    const seen = new Set<string>();
    const phrases: SpecificSubjectPhrase[] = [];
    const addPhrase = (value: string | null | undefined) => {
      const normalized = this.normalizeText(value ?? '');
      if (!normalized) {
        return;
      }

      const tokens = [...this.tokenizeStructuredPhrase(normalized)];
      if (tokens.length < 2) {
        return;
      }

      const joined = tokens.join(' ');
      if (seen.has(joined)) {
        return;
      }

      seen.add(joined);
      phrases.push({
        normalized: joined,
        collapsed: tokens.join(''),
        tokens,
      });
    };

    for (const equipment of semanticQuery.equipment) {
      addPhrase(equipment);
    }
    for (const system of semanticQuery.systems) {
      addPhrase(system);
    }

    return phrases;
  }

  private scoreSpecificSubjectPhraseMatch(
    phrase: SpecificSubjectPhrase,
    normalizedSubject: string,
    collapsedSubject: string,
    subjectTokens: Set<string>,
  ): number {
    if (
      normalizedSubject.includes(phrase.normalized) ||
      collapsedSubject.includes(phrase.collapsed)
    ) {
      return 4;
    }

    const matchedTokens = phrase.tokens.filter((token) =>
      this.matchesToken(subjectTokens, collapsedSubject, token),
    );
    if (matchedTokens.length === 0) {
      return 0;
    }

    const overlapRatio = matchedTokens.length / phrase.tokens.length;
    const distinctiveMatches = matchedTokens.filter(
      (token) => token.length >= 4 || /\d/.test(token),
    ).length;

    if (overlapRatio >= 0.8) {
      return 4;
    }
    if (
      overlapRatio >= 0.6 &&
      distinctiveMatches >= Math.min(2, matchedTokens.length)
    ) {
      return 3;
    }
    if (matchedTokens.length >= 2 && distinctiveMatches >= 1) {
      return 2;
    }

    return 0;
  }

  private matchesConcreteSubjectSignal(
    signal: ConcreteSubjectSignal,
    normalizedManualSubject: string,
    manualTokens: Set<string>,
    collapsedManual: string,
  ): boolean {
    if (
      signal.tokens.length > 1 &&
      (normalizedManualSubject.includes(signal.normalized) ||
        collapsedManual.includes(signal.collapsed))
    ) {
      return true;
    }

    return signal.tokens.every((token) =>
      this.matchesToken(manualTokens, collapsedManual, token),
    );
  }

  private queryAnchorWeight(
    anchor: DistinctiveQueryAnchor,
    matchedFilename: boolean,
  ): number {
    let weight = matchedFilename ? 46 : 12;
    if (anchor.emphasized) {
      weight += matchedFilename ? 34 : 6;
    }
    if (/\d/.test(anchor.token)) {
      weight += matchedFilename ? 8 : 4;
    }
    if (anchor.token.length >= 7) {
      weight += matchedFilename ? 6 : 3;
    }
    if (anchor.token.length <= 4) {
      weight += matchedFilename ? 4 : 2;
    }
    return weight;
  }

  private matchesToken(
    tokens: Set<string>,
    collapsedText: string,
    token: string,
  ): boolean {
    if (tokens.has(token)) {
      return true;
    }

    return (
      (token.length >= 6 || /\d/.test(token)) &&
      collapsedText.includes(this.collapseText(token))
    );
  }

  private collapseText(value: string): string {
    return this.normalizeText(value).replace(/\s+/g, '');
  }

  private buildProfileAnchorText(profile: ManualSemanticProfile): string {
    return [
      profile.vendor,
      profile.model,
      ...profile.aliases,
      ...profile.equipment,
      ...profile.systems,
      profile.summary,
      ...profile.sections.flatMap((section) => [
        section.title,
        section.summary,
      ]),
      ...profile.pageTopics.map((topic) => topic.summary),
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ');
  }

  private scoreArrayOverlap(left: string[], right: string[]): number {
    if (left.length === 0 || right.length === 0) {
      return 0;
    }

    const leftValues = new Set(left.map((value) => this.normalizeText(value)));
    return right
      .map((value) => this.normalizeText(value))
      .filter((value) => leftValues.has(value)).length;
  }

  private extractIdentifierAnchors(
    values: Array<string | null | undefined>,
  ): string[] {
    const anchors = new Set<string>();

    for (const value of values) {
      const tokens = this.tokenize(value ?? '');
      for (let start = 0; start < tokens.length; start += 1) {
        const firstToken = tokens[start];
        if (
          !/\d/.test(firstToken) &&
          !(
            /^[a-z]{1,3}$/.test(firstToken) &&
            /\d/.test(tokens[start + 1] ?? '')
          )
        ) {
          continue;
        }

        let combined = '';
        let digitSeen = false;
        let alphaSeen = false;

        for (
          let length = 0;
          length < 3 && start + length < tokens.length;
          length += 1
        ) {
          const token = tokens[start + length];
          if (!token) {
            break;
          }

          if (
            !/\d/.test(token) &&
            !/^[a-z]{1,3}$/.test(token) &&
            combined.length > 0
          ) {
            break;
          }

          combined += token;
          digitSeen = digitSeen || /\d/.test(token);
          alphaSeen = alphaSeen || /[a-z]/.test(token);

          if (digitSeen && alphaSeen && combined.length >= 4) {
            anchors.add(combined);
          }

          if (
            length > 0 &&
            !/\d/.test(token) &&
            !/^[a-z]{1,3}$/.test(token)
          ) {
            break;
          }
        }
      }
    }

    return [...anchors];
  }

  private scoreStructuredPhraseOverlap(
    profileValues: string[],
    queryValues: string[],
  ): number {
    if (profileValues.length === 0 || queryValues.length === 0) {
      return 0;
    }

    const profileTokenSets = profileValues
      .map((value) => this.tokenizeStructuredPhrase(value))
      .filter((tokens) => tokens.size > 0);
    if (profileTokenSets.length === 0) {
      return 0;
    }

    let score = 0;
    for (const queryValue of queryValues) {
      const queryTokens = this.tokenizeStructuredPhrase(queryValue);
      if (queryTokens.size === 0) {
        continue;
      }

      let bestMatch = 0;
      for (const profileTokens of profileTokenSets) {
        const sharedTokens = [...queryTokens].filter((token) =>
          profileTokens.has(token),
        );
        if (sharedTokens.length === 0) {
          continue;
        }

        if (
          sharedTokens.length === queryTokens.size &&
          sharedTokens.length === profileTokens.size
        ) {
          bestMatch = Math.max(bestMatch, 2);
          continue;
        }

        const overlapRatio = sharedTokens.length / queryTokens.size;
        if (overlapRatio >= 0.5) {
          bestMatch = Math.max(bestMatch, 1);
        }
      }

      score += bestMatch;
    }

    return score;
  }

  private tokenizeStructuredPhrase(value: string): Set<string> {
    const structuredStopWords = new Set([
      ...PROFILE_MATCH_STOP_WORDS,
      'equipment',
      'set',
      'system',
      'systems',
      'unit',
      'units',
    ]);

    return new Set(
      this.tokenize(value).filter(
        (token) => token.length > 2 && !structuredStopWords.has(token),
      ),
    );
  }

  private scoreSourcePreference(
    category: string | null,
    sourcePreferences: SemanticSourceCategory[],
  ): number {
    if (!category) {
      return 0;
    }

    const index = sourcePreferences.indexOf(category as SemanticSourceCategory);
    if (index < 0) {
      return 0;
    }

    return Math.max(4, 14 - index * 3);
  }

  private normalizeCategory(value?: string | null): string | null {
    const normalized = value?.trim().toUpperCase();
    return normalized || null;
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_:./\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(value: string): string[] {
    return this.mergeAcronymLetterTokens(this.normalizeText(value).split(' '))
      .split(' ')
      .map((token) => this.normalizeToken(token))
      .filter(
        (token) => token.length > 1 && !PROFILE_MATCH_STOP_WORDS.has(token),
      );
  }

  private mergeAcronymLetterTokens(tokens: string[]): string {
    const merged: string[] = [];
    let acronymBuffer = '';

    const flushAcronymBuffer = () => {
      if (!acronymBuffer) {
        return;
      }
      merged.push(acronymBuffer);
      acronymBuffer = '';
    };

    for (const token of tokens) {
      if (/^[a-z]$/.test(token)) {
        acronymBuffer += token;
        if (acronymBuffer.length >= 3) {
          flushAcronymBuffer();
        }
        continue;
      }

      flushAcronymBuffer();
      merged.push(token);
    }

    flushAcronymBuffer();
    return merged.join(' ');
  }

  private normalizeToken(token: string): string {
    if (token.length > 4 && token.endsWith('ies')) {
      return `${token.slice(0, -3)}y`;
    }
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
      return token.slice(0, -1);
    }
    return token;
  }

  private matchesSectionHintText(
    value: string,
    normalizedHint: string,
    hintTokens: string[],
  ): boolean {
    const normalizedValue = this.normalizeText(value);
    if (!normalizedValue) {
      return false;
    }

    if (
      normalizedValue.includes(normalizedHint) ||
      this.collapseText(normalizedValue).includes(this.collapseText(normalizedHint))
    ) {
      return true;
    }

    const valueTokens = new Set(this.tokenize(normalizedValue));
    const collapsedValue = this.collapseText(normalizedValue);
    return hintTokens.every((token) =>
      this.matchesToken(valueTokens, collapsedValue, token),
    );
  }

  private isProcedureIntent(
    intent: DocumentationSemanticQuery['intent'],
  ): boolean {
    return (
      intent === 'maintenance_procedure' ||
      intent === 'operational_procedure' ||
      intent === 'troubleshooting'
    );
  }

  private truncate(value: string, maxLength = 140): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }
}
