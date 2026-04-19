import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { LlmService } from '../../integrations/llm/llm.service';
import { parseJsonObject } from '../chat/planning/chat-turn-json.utils';
import { CreateMetricConceptDto } from './dto/create-metric-concept.dto';
import { ResolveMetricConceptDto } from './dto/resolve-metric-concept.dto';
import { UpdateMetricConceptDto } from './dto/update-metric-concept.dto';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricAggregationRule } from './enums/metric-aggregation-rule.enum';
import { buildMetricSemanticBlueprint } from './metrics-semantic-bootstrap.utils';

interface MetricConceptMemberResponseDto {
  id: string;
  role: string | null;
  sortOrder: number;
  metricCatalogId: string;
  metric: {
    id: string;
    shipId: string;
    key: string;
    bucket: string;
    field: string;
    description: string | null;
  };
}

export interface MetricConceptResponseDto {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  category: string | null;
  type: string;
  aggregationRule: MetricAggregationRule;
  unit: string | null;
  isActive: boolean;
  members: MetricConceptMemberResponseDto[];
  createdAt: string;
  updatedAt: string;
}

export interface MetricConceptResolutionCandidateDto {
  concept: MetricConceptResponseDto;
  score: number;
  matchReason: string;
}

export interface MetricConceptResolutionDto {
  query: string;
  normalizedQuery: string;
  resolvedConcept: MetricConceptResponseDto | null;
  candidates: MetricConceptResolutionCandidateDto[];
}

interface MetricConceptScoredMatch {
  concept: MetricConceptEntity;
  score: number;
  matchReason: string;
}

interface MetricConceptSearchProfile {
  searchPhrases: string[];
  requiredKeywords: string[];
  optionalKeywords: string[];
  categoryHints: string[];
  preferredConceptTypes: string[];
  preferredAggregationRules: string[];
}

const GENERIC_SEARCH_TOKENS = new Set([
  'all',
  'boat',
  'current',
  'data',
  'info',
  'information',
  'latest',
  'metric',
  'metrics',
  'now',
  'overall',
  'reading',
  'readings',
  'ship',
  'show',
  'status',
  'tell',
  'total',
  'value',
  'values',
  'vessel',
  'where',
  'yacht',
]);

@Injectable()
export class MetricsSemanticCatalogService {
  constructor(
    @InjectRepository(MetricConceptEntity)
    private readonly metricConceptRepository: Repository<MetricConceptEntity>,
    @InjectRepository(MetricConceptMemberEntity)
    private readonly metricConceptMemberRepository: Repository<MetricConceptMemberEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly shipMetricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    private readonly llmService: LlmService,
  ) {}

  async listConcepts(shipId?: string): Promise<MetricConceptResponseDto[]> {
    const concepts = await this.metricConceptRepository.find({
      relations: {
        members: {
          metricCatalog: true,
        },
      },
      order: {
        slug: 'ASC',
        members: {
          sortOrder: 'ASC',
          createdAt: 'ASC',
        },
      },
    });

    if (!shipId) {
      return concepts.map((concept) => this.serializeConcept(concept));
    }

    return concepts
      .filter((concept) =>
        (concept.members ?? []).some(
          (member) => member.metricCatalog.shipId === shipId,
        ),
      )
      .map((concept) => this.serializeConcept(concept, shipId));
  }

  async createConcept(
    input: CreateMetricConceptDto,
  ): Promise<MetricConceptResponseDto> {
    const slug = this.normalizeSlug(input.slug);
    await this.assertSlugAvailable(slug);

    const concept = this.metricConceptRepository.create({
      slug,
      displayName: input.displayName.trim(),
      description: this.normalizeOptionalText(input.description),
      category: this.normalizeOptionalText(input.category),
      type: input.type,
      aggregationRule: input.aggregationRule ?? MetricAggregationRule.NONE,
      unit: this.normalizeOptionalText(input.unit),
      isActive: input.isActive ?? true,
    });

    const savedConcept = await this.metricConceptRepository.save(concept);
    await this.replaceMembers(savedConcept.id, input.members ?? []);
    return this.getRequiredConcept(savedConcept.id);
  }

  async updateConcept(
    conceptId: string,
    input: UpdateMetricConceptDto,
  ): Promise<MetricConceptResponseDto> {
    const concept = await this.metricConceptRepository.findOne({
      where: { id: conceptId },
    });

    if (!concept) {
      throw new NotFoundException('Metric concept not found');
    }

    if (input.slug) {
      const normalizedSlug = this.normalizeSlug(input.slug);

      if (normalizedSlug !== concept.slug) {
        await this.assertSlugAvailable(normalizedSlug, concept.id);
        concept.slug = normalizedSlug;
      }
    }

    if (typeof input.displayName === 'string') {
      concept.displayName = input.displayName.trim();
    }

    if (input.description !== undefined) {
      concept.description = this.normalizeOptionalText(input.description);
    }

    if (input.category !== undefined) {
      concept.category = this.normalizeOptionalText(input.category);
    }

    if (input.type !== undefined) {
      concept.type = input.type;
    }

    if (input.aggregationRule !== undefined) {
      concept.aggregationRule = input.aggregationRule;
    }

    if (input.unit !== undefined) {
      concept.unit = this.normalizeOptionalText(input.unit);
    }

    if (input.isActive !== undefined) {
      concept.isActive = input.isActive;
    }

    await this.metricConceptRepository.save(concept);

    if (input.members !== undefined) {
      await this.replaceMembers(concept.id, input.members);
    }

    return this.getRequiredConcept(concept.id);
  }

  async resolveConcept(
    input: ResolveMetricConceptDto,
  ): Promise<MetricConceptResolutionDto> {
    const normalizedQuery = this.normalizeSearchValue(input.query);

    if (!normalizedQuery) {
      throw new BadRequestException('query must not be empty');
    }

    const concepts = await this.metricConceptRepository.find({
      where: { isActive: true },
      relations: {
        members: {
          metricCatalog: true,
        },
      },
      order: {
        slug: 'ASC',
      },
    });
    const scopedConcepts = concepts
      .map((concept) => this.scopeConceptForShip(concept, input.shipId))
      .filter((concept): concept is MetricConceptEntity => concept !== null);

    const deterministicCandidates = scopedConcepts
      .map((concept) => this.scoreConceptMatch(concept, normalizedQuery))
      .filter(
        (candidate): candidate is MetricConceptScoredMatch => candidate !== null,
      )
      .sort((left, right) => right.score - left.score || left.concept.slug.localeCompare(right.concept.slug))
      .slice(0, 10);
    const resolvedCandidate = this.selectResolvedCandidate(
      deterministicCandidates,
      normalizedQuery,
    );
    const semanticResolution = resolvedCandidate
      ? null
      : await this.resolveConceptSemantically(
          scopedConcepts,
          input.query.trim(),
          normalizedQuery,
        );
    const candidates = semanticResolution?.candidates.length
      ? semanticResolution.candidates
      : deterministicCandidates;
    const finalResolvedCandidate =
      resolvedCandidate ?? semanticResolution?.resolvedCandidate ?? null;

    return {
      query: input.query.trim(),
      normalizedQuery,
      resolvedConcept: finalResolvedCandidate
        ? this.serializeConcept(finalResolvedCandidate.concept)
        : null,
      candidates: candidates.map((candidate) => ({
        concept: this.serializeConcept(candidate.concept),
        score: candidate.score,
        matchReason: candidate.matchReason,
      })),
    };
  }

  private scoreConceptMatch(
    concept: MetricConceptEntity,
    normalizedQuery: string,
  ): MetricConceptScoredMatch | null {
    const candidateValues = [
      {
        value: this.normalizeSearchValue(concept.slug),
        score: 120,
        reason: 'exact_slug',
      },
      {
        value: this.normalizeSearchValue(concept.displayName),
        score: 110,
        reason: 'exact_display_name',
      },
      {
        value: this.normalizeSearchValue(concept.description),
        score: 80,
        reason: 'description',
      },
    ];

    let bestMatch:
      | {
          score: number;
          reason: string;
        }
      | null = null;
    const queryTokens = this.tokenizeSearchValue(normalizedQuery);

    for (const candidate of candidateValues) {
      if (!candidate.value) {
        continue;
      }

      if (candidate.value === normalizedQuery) {
        bestMatch = {
          score: candidate.score,
          reason: candidate.reason,
        };
        break;
      }

      if (
        this.hasPhraseMatch(candidate.value, normalizedQuery) &&
        this.passesPhraseCoverage(candidate.value, queryTokens)
      ) {
        bestMatch = {
          score: this.scorePhraseMatch(candidate.reason),
          reason: `partial_${candidate.reason}`,
        };
      }
    }

    if (!bestMatch) {
      const semanticScore = this.scoreSemanticOverlap(concept, normalizedQuery);

      if (semanticScore === null) {
        return null;
      }

      bestMatch = semanticScore;
    }

    if (
      (bestMatch.reason.startsWith('partial_') ||
        bestMatch.reason === 'semantic_overlap') &&
      !this.passesConceptSpecificityGuard(concept, normalizedQuery)
    ) {
      return null;
    }

    return {
      concept,
      score: bestMatch.score,
      matchReason: bestMatch.reason,
    };
  }

  private selectResolvedCandidate(
    candidates: MetricConceptScoredMatch[],
    normalizedQuery: string,
  ): MetricConceptScoredMatch | null {
    const topCandidate = candidates[0];

    if (!topCandidate) {
      return null;
    }

    if (this.isTrustedResolutionReason(topCandidate.matchReason)) {
      return topCandidate;
    }

    return this.passesResolutionConfidenceGate(candidates, normalizedQuery)
      ? topCandidate
      : null;
  }

  private async getRequiredConcept(
    conceptId: string,
  ): Promise<MetricConceptResponseDto> {
    const concept = await this.metricConceptRepository.findOne({
      where: { id: conceptId },
      relations: {
        members: {
          metricCatalog: true,
        },
      },
      order: {
        members: {
          sortOrder: 'ASC',
          createdAt: 'ASC',
        },
      },
    });

    if (!concept) {
      throw new NotFoundException('Metric concept not found');
    }

    return this.serializeConcept(concept);
  }
  private async replaceMembers(
    conceptId: string,
    members: CreateMetricConceptDto['members'],
  ): Promise<void> {
    await this.metricConceptMemberRepository.delete({ conceptId });

    if (!members?.length) {
      return;
    }

    const metricCatalogIds = members
      .map((member) => member.metricCatalogId)
      .filter((value): value is string => Boolean(value));

    if (metricCatalogIds.length > 0) {
      const metrics = await this.shipMetricCatalogRepository.find({
        where: { id: In(metricCatalogIds) },
        select: { id: true },
      });

      if (metrics.length !== new Set(metricCatalogIds).size) {
        throw new BadRequestException(
          'One or more metricCatalogId values do not exist',
        );
      }
    }

    const preparedMembers = members.map((member, index) => {
      const metricCatalogId = member.metricCatalogId?.trim();

      if (!metricCatalogId) {
        throw new BadRequestException(
          'Each metric concept member must reference metricCatalogId',
        );
      }

      return this.metricConceptMemberRepository.create({
        conceptId,
        metricCatalogId,
        role: this.normalizeOptionalText(member.role),
        sortOrder: member.sortOrder ?? index,
      });
    });

    await this.metricConceptMemberRepository.save(preparedMembers);
  }

  private serializeConcept(
    concept: MetricConceptEntity,
    shipId?: string,
  ): MetricConceptResponseDto {
    const scopedMembers = shipId
      ? [...(concept.members ?? [])].filter(
          (member) => member.metricCatalog.shipId === shipId,
        )
      : [...(concept.members ?? [])];

    return {
      id: concept.id,
      slug: concept.slug,
      displayName: concept.displayName,
      description: concept.description,
      category: concept.category,
      type: concept.type,
      aggregationRule: concept.aggregationRule,
      unit: concept.unit,
      isActive: concept.isActive,
      members: scopedMembers
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((member) => ({
          id: member.id,
          role: member.role,
          sortOrder: member.sortOrder,
          metricCatalogId: member.metricCatalogId,
          metric: {
            id: member.metricCatalog.id,
            shipId: member.metricCatalog.shipId,
            key: member.metricCatalog.key,
            bucket: member.metricCatalog.bucket,
            field: member.metricCatalog.field,
            description: member.metricCatalog.description,
          },
        })),
      createdAt: concept.createdAt.toISOString(),
      updatedAt: concept.updatedAt.toISOString(),
    };
  }

  private async assertSlugAvailable(
    slug: string,
    ignoreConceptId?: string,
  ): Promise<void> {
    const existing = await this.metricConceptRepository.findOne({
      where: { slug },
      select: { id: true },
    });

    if (existing && existing.id !== ignoreConceptId) {
      throw new BadRequestException(
        `Metric concept slug "${slug}" already exists`,
      );
    }
  }

  private normalizeSlug(value: string): string {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!normalized) {
      throw new BadRequestException('slug must not be empty');
    }

    return normalized;
  }

  private normalizeOptionalText(value?: string | null): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeSearchValue(value?: string | null): string {
    return (
      value
        ?.trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\b(boat|ship|yacht)\b/gu, 'vessel')
        .replace(/\s+/g, ' ') ?? ''
    ).trim();
  }

  private scoreSemanticOverlap(
    concept: MetricConceptEntity,
    normalizedQuery: string,
  ): {
    score: number;
    reason: string;
  } | null {
    const queryTokens = this.tokenizeSearchValue(normalizedQuery);

    if (queryTokens.length === 0) {
      return null;
    }

    const conceptText = this.normalizeSearchValue(
      [
        concept.displayName,
        concept.description,
      ]
        .filter(Boolean)
        .join(' '),
    );
    const conceptTokens = new Set(this.tokenizeSearchValue(conceptText));
    let overlap = 0;
    let specificOverlap = 0;
    const specificQueryTokens = queryTokens.filter(
      (token) => !GENERIC_SEARCH_TOKENS.has(token),
    );

    for (const token of queryTokens) {
      if (conceptTokens.has(token)) {
        overlap += 1;

        if (specificQueryTokens.includes(token)) {
          specificOverlap += 1;
        }
      }
    }

    if (overlap === 0) {
      return null;
    }

    if (
      !this.passesTokenCoverage(
        queryTokens,
        specificQueryTokens,
        specificOverlap,
        overlap,
      )
    ) {
      return null;
    }

    return {
      score: 45 + overlap * 12,
      reason: 'semantic_overlap',
    };
  }

  private passesConceptSpecificityGuard(
    concept: MetricConceptEntity,
    normalizedQuery: string,
  ): boolean {
    const queryTokens = this.tokenizeSearchValue(normalizedQuery);
    const specificQueryTokens = queryTokens.filter(
      (token) => !GENERIC_SEARCH_TOKENS.has(token),
    );

    if (specificQueryTokens.length === 0) {
      return false;
    }

    const identityVariants = [
      concept.displayName,
      concept.slug,
    ]
      .map((value) => this.normalizeSearchValue(value))
      .filter(Boolean);

    return identityVariants.some((variant) =>
      this.variantPassesSpecificityGuard(
        variant,
        queryTokens,
        specificQueryTokens,
        normalizedQuery,
      ),
    );
  }

  private tokenizeSearchValue(value: string): string[] {
    const stopWords = new Set([
      'a',
      'an',
      'and',
      'at',
      'current',
      'for',
      'how',
      'in',
      'is',
      'me',
      'of',
      'on',
      'show',
      'tell',
      'the',
      'this',
      'to',
      'what',
      'was',
    ]);

    return value
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !stopWords.has(token));
  }

  private hasPhraseMatch(candidateValue: string, normalizedQuery: string): boolean {
    if (!candidateValue || !normalizedQuery) {
      return false;
    }

    if (candidateValue.length < 4) {
      return false;
    }

    const paddedCandidate = ` ${candidateValue} `;
    const paddedQuery = ` ${normalizedQuery} `;

    return (
      paddedCandidate.includes(paddedQuery) || paddedQuery.includes(paddedCandidate)
    );
  }

  private scorePhraseMatch(reason: string): number {
    switch (reason) {
      case 'exact_slug':
        return 108;
      case 'exact_display_name':
        return 100;
      case 'description':
        return 72;
      default:
        return 70;
    }
  }

  private passesPhraseCoverage(
    candidateValue: string,
    queryTokens: string[],
  ): boolean {
    const candidateTokens = new Set(this.tokenizeSearchValue(candidateValue));
    const specificQueryTokens = queryTokens.filter(
      (token) => !GENERIC_SEARCH_TOKENS.has(token),
    );
    const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
    const specificOverlap = specificQueryTokens.filter((token) =>
      candidateTokens.has(token),
    ).length;

    return this.passesTokenCoverage(
      queryTokens,
      specificQueryTokens,
      specificOverlap,
      overlap,
    );
  }

  private passesTokenCoverage(
    queryTokens: string[],
    specificQueryTokens: string[],
    specificOverlap: number,
    overlap: number,
  ): boolean {
    if (queryTokens.length <= 1) {
      return overlap > 0;
    }

    if (specificQueryTokens.length > 0) {
      const requiredSpecificOverlap =
        specificQueryTokens.length >= 2 ? 2 : specificQueryTokens.length;

      return specificOverlap >= requiredSpecificOverlap;
    }

    return overlap >= 2;
  }

  private isTrustedResolutionReason(reason: string): boolean {
    return (
      reason === 'exact_slug' ||
      reason === 'exact_display_name'
    );
  }

  private passesResolutionConfidenceGate(
    candidates: MetricConceptScoredMatch[],
    normalizedQuery: string,
  ): boolean {
    const topCandidate = candidates[0];

    if (!topCandidate) {
      return false;
    }

    if (
      topCandidate.matchReason === 'description' ||
      topCandidate.matchReason === 'partial_description'
    ) {
      return false;
    }

    const queryTokens = this.tokenizeSearchValue(normalizedQuery);
    const specificQueryTokens = queryTokens.filter(
      (token) => !GENERIC_SEARCH_TOKENS.has(token),
    );

    if (specificQueryTokens.length === 0) {
      return false;
    }

    if (specificQueryTokens.length === 1) {
      return false;
    }

    if (topCandidate.score < 90) {
      return false;
    }

    const secondCandidate = candidates[1];

    if (!secondCandidate) {
      return true;
    }

    const scoreLead = topCandidate.score - secondCandidate.score;
    return scoreLead >= 8;
  }

  private variantPassesSpecificityGuard(
    variant: string,
    queryTokens: string[],
    specificQueryTokens: string[],
    normalizedQuery: string,
  ): boolean {
    if (!variant) {
      return false;
    }

    if (variant === normalizedQuery) {
      return true;
    }

    const variantTokens = this.tokenizeSearchValue(variant);
    const specificVariantTokens = variantTokens.filter(
      (token) => !GENERIC_SEARCH_TOKENS.has(token),
    );
    const unmatchedSpecificVariantTokens = specificVariantTokens.filter(
      (token) => !queryTokens.includes(token),
    );
    const specificOverlap = specificQueryTokens.filter((token) =>
      specificVariantTokens.includes(token),
    ).length;

    if (specificQueryTokens.length === 1) {
      return unmatchedSpecificVariantTokens.length === 0 && specificOverlap === 1;
    }

    const allowedExtraSpecificTokens =
      specificQueryTokens.length >= 3 ? 1 : 0;

    return (
      specificOverlap === specificQueryTokens.length &&
      unmatchedSpecificVariantTokens.length <= allowedExtraSpecificTokens
    );
  }

  private scopeConceptForShip(
    concept: MetricConceptEntity,
    shipId?: string,
  ): MetricConceptEntity | null {
    if (!shipId) {
      return concept;
    }

    const scopedMembers = [...(concept.members ?? [])].filter((member) => {
      if (!member.metricCatalog) {
        return true;
      }

      return member.metricCatalog.shipId === shipId;
    });

    if ((concept.members?.length ?? 0) > 0 && scopedMembers.length === 0) {
      return null;
    }

    return {
      ...concept,
      members: scopedMembers,
    };
  }

  private async resolveConceptSemantically(
    concepts: MetricConceptEntity[],
    rawQuery: string,
    normalizedQuery: string,
  ): Promise<{
    resolvedCandidate: MetricConceptScoredMatch | null;
    candidates: MetricConceptScoredMatch[];
  }> {
    if (!this.llmService.isConfigured() || concepts.length === 0) {
      return {
        resolvedCandidate: null,
        candidates: [],
      };
    }

    const searchProfile = await this.buildSemanticSearchProfile(rawQuery);

    if (!searchProfile) {
      return {
        resolvedCandidate: null,
        candidates: [],
      };
    }

    const recalledCandidates = concepts
      .map((concept) => this.scoreConceptAgainstSemanticProfile(concept, searchProfile))
      .filter((candidate): candidate is MetricConceptScoredMatch => candidate !== null)
      .sort(
        (left, right) =>
          right.score - left.score || left.concept.slug.localeCompare(right.concept.slug),
      )
      .slice(0, 40);

    if (recalledCandidates.length === 0) {
      return {
        resolvedCandidate: null,
        candidates: [],
      };
    }

    const resolvedConceptId = await this.selectSemanticConceptWithLlm(
      rawQuery,
      normalizedQuery,
      recalledCandidates,
    );
    const resolvedCandidate = resolvedConceptId
      ? recalledCandidates.find((candidate) => candidate.concept.id === resolvedConceptId) ?? null
      : null;

    return {
      resolvedCandidate: resolvedCandidate
        ? {
            ...resolvedCandidate,
            score: Math.max(resolvedCandidate.score, 140),
            matchReason: 'llm_semantic_match',
          }
        : null,
      candidates: recalledCandidates.slice(0, 10).map((candidate) =>
        resolvedCandidate && candidate.concept.id === resolvedCandidate.concept.id
          ? {
              ...candidate,
              score: Math.max(candidate.score, 140),
              matchReason: 'llm_semantic_match',
            }
          : candidate,
      ),
    };
  }

  private async buildSemanticSearchProfile(
    rawQuery: string,
  ): Promise<MetricConceptSearchProfile | null> {
    const response = await this.llmService.createChatCompletion({
      systemPrompt: [
        'You normalize vessel telemetry questions into concept-search hints.',
        'The user may write in any language.',
        'Infer the underlying telemetry concept in English using semantic meaning, not aliases.',
        'If the user asks for the total amount or current level of a resource on the vessel, prefer derived composite concepts over component sensors or consumption counters.',
        'If the user asks where the vessel is, prefer location/coordinate concepts.',
        'If the user asks for generic vessel speed, prefer navigation speed over ground unless the wording explicitly says speed through water.',
        'Return JSON only with this exact shape:',
        '{"searchPhrases":["..."],"requiredKeywords":["..."],"optionalKeywords":["..."],"categoryHints":["..."],"preferredConceptTypes":["single|group|composite|paired|comparison|trajectory"],"preferredAggregationRules":["none|sum|avg|min|max|last|coordinate_pair|compare|trajectory"]}',
        'Keep arrays short and useful.',
        'searchPhrases should be English canonical concept phrases.',
        'requiredKeywords should be the must-have semantic words.',
        'optionalKeywords should be helpful related words.',
        'If the user asks for a grouped or derived metric, include that intent.',
        'Do not include aliases from the user language.',
        'Do not wrap JSON in markdown.',
      ].join('\n'),
      userPrompt: `User metric question:\n${rawQuery.trim()}`,
      temperature: 0,
      maxTokens: 220,
    });
    const parsed = parseJsonObject(response);

    if (!parsed) {
      return null;
    }

    return {
      searchPhrases: this.parseStringArray(parsed.searchPhrases),
      requiredKeywords: this.parseStringArray(parsed.requiredKeywords),
      optionalKeywords: this.parseStringArray(parsed.optionalKeywords),
      categoryHints: this.parseStringArray(parsed.categoryHints),
      preferredConceptTypes: this.parseStringArray(parsed.preferredConceptTypes),
      preferredAggregationRules: this.parseStringArray(parsed.preferredAggregationRules),
    };
  }

  private scoreConceptAgainstSemanticProfile(
    concept: MetricConceptEntity,
    profile: MetricConceptSearchProfile,
  ): MetricConceptScoredMatch | null {
    const searchPhrases = profile.searchPhrases
      .map((phrase) => this.normalizeSearchValue(phrase))
      .filter(Boolean);
    const requiredKeywords = profile.requiredKeywords
      .map((keyword) => this.normalizeSearchValue(keyword))
      .filter(Boolean);
    const optionalKeywords = profile.optionalKeywords
      .map((keyword) => this.normalizeSearchValue(keyword))
      .filter(Boolean);
    const categoryHints = new Set(
      profile.categoryHints
        .map((hint) => this.normalizeSearchValue(hint))
        .filter(Boolean),
    );
    const preferredConceptTypes = new Set(
      profile.preferredConceptTypes.map((value) => value.trim().toLowerCase()),
    );
    const preferredAggregationRules = new Set(
      profile.preferredAggregationRules.map((value) => value.trim().toLowerCase()),
    );
    const document = this.buildConceptSemanticDocument(concept);
    let score = 0;

    for (const phrase of searchPhrases) {
      if (this.hasPhraseMatch(document, phrase)) {
        score += 28;
      }
    }

    const requiredMatches = requiredKeywords.filter((keyword) =>
      document.includes(keyword),
    ).length;
    const optionalMatches = optionalKeywords.filter((keyword) =>
      document.includes(keyword),
    ).length;

    score += requiredMatches * 20;
    score += optionalMatches * 6;

    if (
      concept.category &&
      categoryHints.has(this.normalizeSearchValue(concept.category))
    ) {
      score += 20;
    }

    if (preferredConceptTypes.has(concept.type)) {
      score += 18;
    }

    if (preferredAggregationRules.has(concept.aggregationRule)) {
      score += 18;
    }

    if (score === 0) {
      return null;
    }

    return {
      concept,
      score,
      matchReason: 'semantic_profile_recall',
    };
  }

  private async selectSemanticConceptWithLlm(
    rawQuery: string,
    normalizedQuery: string,
    candidates: MetricConceptScoredMatch[],
  ): Promise<string | null> {
    const response = await this.llmService.createChatCompletion({
      systemPrompt: [
        'You choose the best telemetry concept for a user query.',
        'Use concept meaning from display name, description, category, type, aggregation rule, and member summary.',
        'Do not rely on aliases.',
        'If no candidate clearly matches, return null.',
        'Prefer precision over guessing.',
        'If the user asks for the total amount or current level of a resource onboard, prefer composite totals over transfer pumps, used counters, voltages, or unrelated tank readings.',
        'If the user asks for vessel speed in a generic way, prefer speed over ground over speed through water unless the query explicitly says otherwise.',
        'Return JSON only with this exact shape:',
        '{"matchedConceptId":"uuid or null","confidence":"high|medium|low","reasoning":"short string"}',
        'Do not wrap JSON in markdown.',
      ].join('\n'),
      userPrompt: [
        `User query: ${rawQuery}`,
        `Normalized query: ${normalizedQuery}`,
        '',
        'Candidate concepts:',
        JSON.stringify(
          candidates.map((candidate) => ({
            id: candidate.concept.id,
            recallScore: candidate.score,
            displayName: candidate.concept.displayName,
            slug: candidate.concept.slug,
            description: candidate.concept.description,
            category: candidate.concept.category,
            type: candidate.concept.type,
            aggregationRule: candidate.concept.aggregationRule,
            members: candidate.concept.members
              .slice(0, 8)
              .map((member) =>
                member.role ?? member.metricCatalog?.key ?? null,
              )
              .filter(Boolean),
          })),
          null,
          2,
        ),
      ].join('\n'),
      temperature: 0,
      maxTokens: 260,
    });
    const parsed = parseJsonObject(response);

    if (!parsed) {
      return null;
    }

    const matchedConceptId =
      typeof parsed.matchedConceptId === 'string' &&
      parsed.matchedConceptId.trim().length > 0
        ? parsed.matchedConceptId.trim()
        : null;
    const confidence =
      typeof parsed.confidence === 'string'
        ? parsed.confidence.trim().toLowerCase()
        : 'low';

    if (!matchedConceptId || confidence === 'low') {
      return null;
    }

    return candidates.some((candidate) => candidate.concept.id === matchedConceptId)
      ? matchedConceptId
      : null;
  }

  private buildConceptSemanticDocument(concept: MetricConceptEntity): string {
    return this.normalizeSearchValue(
      [
        concept.displayName,
        concept.description,
        concept.category,
        concept.type,
        concept.aggregationRule,
        ...concept.members.flatMap((member) => [
          member.role,
          this.buildMetricSearchDocument(member.metricCatalog),
        ]),
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  private buildMetricSearchDocument(metric: ShipMetricCatalogEntity): string {
    const blueprint = buildMetricSemanticBlueprint(metric);

    return [
      blueprint.displayName,
      blueprint.description,
      blueprint.category,
      metric.key,
      metric.bucket,
      metric.field,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private parseStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return [...new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    )];
  }
}
