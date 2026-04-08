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
  'catalog',
  'catalogue',
  'check',
  'connect',
  'connecting',
  'connection',
  'control',
  'converter',
  'display',
  'equipment',
  'information',
  'instruction',
  'kit',
  'limit',
  'limitation',
  'mode',
  'operate',
  'operating',
  'operation',
  'overview',
  'page',
  'part',
  'procedure',
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
  'control',
  'information',
  'quick',
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

    const candidates = manuals
      .map((manual) => this.scoreManual(manual, params))
      .filter((candidate) => candidate.score > 0)
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

    const fieldTokens = new Set(this.tokenize(value));
    if (fieldTokens.size === 0) {
      return 0;
    }

    const matches = queryTokens.filter((token) => fieldTokens.has(token));
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
    const leftTokens = new Set(
      this.tokenize(left).filter((token) => token.length > 2),
    );
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
      if (leftTokens.has(token)) {
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

    const filenameTokens = new Set(this.tokenize(manual.filename));
    const profileTokens = profile
      ? new Set(this.tokenize(this.buildProfileAnchorText(profile)))
      : new Set<string>();
    let matchedAnchors = 0;
    let score = 0;

    for (const anchor of anchors) {
      if (filenameTokens.has(anchor.token)) {
        matchedAnchors += 1;
        score += this.queryAnchorWeight(anchor, true);
        continue;
      }

      if (profileTokens.has(anchor.token)) {
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

  private truncate(value: string, maxLength = 140): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }
}
