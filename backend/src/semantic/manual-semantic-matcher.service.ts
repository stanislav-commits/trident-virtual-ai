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

    if (
      category &&
      semanticQuery.sourcePreferences.includes(
        category as SemanticSourceCategory,
      )
    ) {
      score += 12;
      reasons.push('source_preference');
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

    const profileTextScore = this.scoreProfileText(profile, queryText);
    if (profileTextScore > 0) {
      score += profileTextScore;
      reasons.push('profile_text');
    }

    return { score, reasons };
  }

  private scoreProfileText(
    profile: ManualSemanticProfile,
    queryText: string,
  ): number {
    const queryTokens = this.tokenize(queryText);
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
    return procedureIntents.has(documentType) && procedureIntents.has(queryIntent);
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
    const rightTokens = this.tokenize(right).filter(
      (token) => token.length > 2,
    );

    let overlap = 0;
    for (const token of rightTokens) {
      if (leftTokens.has(token)) {
        overlap += 1;
      }
    }

    return Math.min(overlap * 2, 14);
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
    return this.normalizeText(value)
      .split(' ')
      .map((token) => this.normalizeToken(token))
      .filter(
        (token) => token.length > 1 && !PROFILE_MATCH_STOP_WORDS.has(token),
      );
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
