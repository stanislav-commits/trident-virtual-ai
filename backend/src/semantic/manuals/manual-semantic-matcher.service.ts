import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  DocumentationSemanticCandidate,
  DocumentationSemanticQuery,
  ManualSemanticProfile,
} from '../contracts/semantic.types';
import { parseManualSemanticProfile } from '../contracts/semantic.validators';
import {
  CONCEPT_TEXT_STOP_WORDS,
  GENERIC_EXPLICIT_SOURCE_TOKENS,
  PROFILE_TEXT_QUERY_STOP_WORDS,
  QUERY_ANCHOR_STOP_WORDS,
  QUERY_SUBJECT_BOUNDARY_STOP_WORDS,
} from './matching/manual-semantic-stop-words.constants';
import type {
  ConcreteSubjectSignal,
  DistinctiveQueryAnchor,
  SearchableSemanticManual,
  SpecificSubjectCandidateRank,
  SpecificSubjectPhrase,
} from './matching/manual-semantic-matching.types';
import {
  buildManualProfileAnchorText,
  collapseManualMatchText,
  containsWholeNormalizedPhrase,
  normalizeManualCategory,
  normalizeManualMatchText,
  normalizeManualMatchToken,
  tokenizeManualMatchText,
  truncateManualSemanticLogValue,
} from './matching/manual-semantic-text.utils';
import {
  extractManualIdentifierAnchors,
  scoreManualArrayOverlap,
  scoreManualSourcePreference,
  scoreManualStructuredPhraseOverlap,
  tokenizeManualStructuredPhrase,
} from './matching/manual-semantic-scoring.utils';

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
        `Semantic manual shortlist query="${truncateManualSemanticLogValue(params.queryText)}" intent=${params.semanticQuery.intent} concepts=${params.semanticQuery.selectedConceptIds.join(',') || 'none'} candidates=${candidates.map((candidate) => `${candidate.manualId}:${candidate.score.toFixed(1)}`).join(',')}`,
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
    const category = normalizeManualCategory(manual.category);
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

    const sourcePreferenceScore = scoreManualSourcePreference(
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

    score += scoreManualArrayOverlap(profile.systems, query.systems) * 8;
    score += scoreManualArrayOverlap(profile.equipment, query.equipment) * 8;
    const systemOverlapScore = scoreManualStructuredPhraseOverlap(
      profile.systems,
      query.systems,
    );
    if (systemOverlapScore > 0) {
      score += systemOverlapScore * 6;
      reasons.push('system_overlap');
    }
    const equipmentOverlapScore = scoreManualStructuredPhraseOverlap(
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
      normalizeManualMatchText(query.vendor) === normalizeManualMatchText(profile.vendor)
    ) {
      score += 16;
      reasons.push('vendor');
    }

    if (
      query.model &&
      profile.model &&
      normalizeManualMatchText(query.model) === normalizeManualMatchText(profile.model)
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

    const queryTokens = tokenizeManualMatchText(queryText).filter(
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

    const queryVendor = normalizeManualMatchText(params.semanticQuery.vendor ?? '');
    const queryModel = normalizeManualMatchText(params.semanticQuery.model ?? '');
    const explicitSource = normalizeManualMatchText(
      params.semanticQuery.explicitSource ?? '',
    );
    const sectionHint = normalizeManualMatchText(params.semanticQuery.sectionHint ?? '');
    const queryIdentifiers = new Set(
      extractManualIdentifierAnchors([
        params.queryText,
        params.semanticQuery.model,
        ...params.semanticQuery.equipment,
        ...params.semanticQuery.systems,
      ]),
    );
    const subjectPhrases = this.collectSpecificSubjectPhrases(
      params.semanticQuery,
      params.queryText,
    );
    const hasHardSpecificityAnchors =
      Boolean(queryVendor || queryModel || explicitSource) ||
      queryIdentifiers.size > 0;

    if (
      !queryVendor &&
      !queryModel &&
      !explicitSource &&
      queryIdentifiers.size === 0 &&
      !sectionHint &&
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
    if (!hasHardSpecificityAnchors) {
      const dominantTopCandidate =
        this.selectDominantTopSpecificCandidate(rankedCandidates);
      if (dominantTopCandidate) {
        return [dominantTopCandidate.candidate];
      }

      return [...rankedCandidates]
        .sort((left, right) => right.candidate.score - left.candidate.score)
        .map((entry) => entry.candidate);
    }

    const anchoredCandidates =
      this.filterByHardSpecificityAnchors(rankedCandidates);
    const bestScore = Math.max(
      ...anchoredCandidates.map((entry) => entry.specificityScore),
    );

    const bestSpecificityCandidates =
      bestScore <= 0
        ? anchoredCandidates
        : anchoredCandidates.filter(
            (entry) => entry.specificityScore === bestScore,
          );
    const dominantTopCandidate = this.selectDominantTopSpecificCandidate(
      bestSpecificityCandidates,
    );
    if (dominantTopCandidate) {
      return [dominantTopCandidate.candidate];
    }

    return bestSpecificityCandidates.map((entry) => entry.candidate);
  }

  private scoreProfileText(
    profile: ManualSemanticProfile,
    queryText: string,
  ): number {
    const queryTokens = tokenizeManualMatchText(queryText).filter(
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
    const normalizedHint = normalizeManualMatchText(query.sectionHint ?? '');
    if (!normalizedHint) {
      return 0;
    }

    const hintTokens = [...tokenizeManualStructuredPhrase(normalizedHint)].filter(
      (token) =>
        (token.length > 3 || /\d/.test(token)) &&
        !PROFILE_TEXT_QUERY_STOP_WORDS.has(token),
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
    const normalizedSearchableText = normalizeManualMatchText(searchableText);
    if (!normalizedSearchableText) {
      return 0;
    }

    const collapsedSearchableText = collapseManualMatchText(searchableText);
    const searchableTokens = new Set(tokenizeManualMatchText(normalizedSearchableText));
    const matchedTokens = hintTokens.filter((token) =>
      this.matchesToken(searchableTokens, collapsedSearchableText, token),
    );
    if (matchedTokens.length === 0) {
      return 0;
    }

    let score = 0;
    if (
      normalizedSearchableText.includes(normalizedHint) ||
      collapsedSearchableText.includes(collapseManualMatchText(normalizedHint))
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

    const normalizedValue = normalizeManualMatchText(value);
    const fieldTokens = new Set(tokenizeManualMatchText(normalizedValue));
    const collapsedValue = collapseManualMatchText(normalizedValue);
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
      tokenizeManualMatchText(buildManualProfileAnchorText(profile)),
    );
    if (profileTokens.size === 0) {
      return 0;
    }

    const conceptTokens = [
      ...new Set(
        selectedConceptIds
          .flatMap((conceptId) => tokenizeManualMatchText(conceptId))
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
        ?.map((category) => normalizeManualCategory(category))
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

    const normalizedFilename = normalizeManualMatchText(filename);
    const normalizedSource = normalizeManualMatchText(explicitSource);
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
    const normalizedLeft = normalizeManualMatchText(left);
    const leftTokens = new Set(
      tokenizeManualMatchText(normalizedLeft).filter((token) => token.length > 2),
    );
    const collapsedLeft = collapseManualMatchText(normalizedLeft);
    const rightTokens = [
      ...new Set(
        tokenizeManualMatchText(right).filter(
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

    const normalizedFilename = normalizeManualMatchText(manual.filename);
    const filenameTokens = new Set(tokenizeManualMatchText(normalizedFilename));
    const collapsedFilename = collapseManualMatchText(normalizedFilename);
    const profileTokens = profile
      ? new Set(tokenizeManualMatchText(buildManualProfileAnchorText(profile)))
      : new Set<string>();
    const collapsedProfile = profile
      ? collapseManualMatchText(buildManualProfileAnchorText(profile))
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

    const manualTokens = new Set(tokenizeManualMatchText(normalizedManualSubject));
    const collapsedManual = collapseManualMatchText(normalizedManualSubject);
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
      ].flatMap((value) => tokenizeManualMatchText(value)),
    );
    const seen = new Set<string>();
    const anchors: DistinctiveQueryAnchor[] = [];

    for (const token of tokenizeManualMatchText(queryText)) {
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
      const normalized = normalizeManualMatchText(value ?? '');
      if (!normalized) {
        return;
      }

      const tokens = tokenizeManualStructuredPhrase(normalized);
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
      addSignal(equipment, tokenizeManualStructuredPhrase(equipment).size > 1 ? 18 : 14);
    }
    for (const system of semanticQuery.systems) {
      addSignal(system, tokenizeManualStructuredPhrase(system).size > 1 ? 16 : 12);
    }
    for (const phrase of this.extractQueryDerivedSubjectPhrases(queryText)) {
      const phraseTokenCount = tokenizeManualStructuredPhrase(phrase).size;
      addSignal(phrase, phraseTokenCount >= 3 ? 20 : 18);
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
    const normalizedSubject = normalizeManualMatchText(subjectText);
    const collapsedSubject = collapseManualMatchText(subjectText);
    const subjectTokens = new Set(tokenizeManualMatchText(normalizedSubject));
    const subjectIdentifiers = new Set(
      extractManualIdentifierAnchors([subjectText]),
    );
    const candidateVendor = normalizeManualMatchText(
      candidate.semanticProfile?.vendor ?? '',
    );
    const candidateModel = normalizeManualMatchText(
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
        containsWholeNormalizedPhrase(
          normalizedSubject,
          params.queryVendor,
        ))
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

  private selectDominantTopSpecificCandidate(
    rankedCandidates: SpecificSubjectCandidateRank[],
  ): SpecificSubjectCandidateRank | null {
    if (rankedCandidates.length === 0) {
      return null;
    }

    const sortedCandidates = [...rankedCandidates].sort(
      (left, right) => right.candidate.score - left.candidate.score,
    );
    const [topCandidate, secondCandidate] = sortedCandidates;
    if (!topCandidate) {
      return null;
    }

    if (!secondCandidate) {
      return this.hasDominantSubjectEvidence(topCandidate) ? topCandidate : null;
    }

    const lead = topCandidate.candidate.score - secondCandidate.candidate.score;
    return lead >= 18 &&
      this.hasDominantSubjectEvidence(topCandidate)
      ? topCandidate
      : null;
  }

  private hasDominantSubjectEvidence(
    rankedCandidate: SpecificSubjectCandidateRank,
  ): boolean {
    const strongReasons = new Set([
      'concrete_subject',
      'equipment_overlap',
      'explicit_source',
      'query_anchor',
      'vendor',
      'model',
    ]);
    return (
      rankedCandidate.explicitSourceMatched ||
      rankedCandidate.modelMatched ||
      rankedCandidate.identifierMatched ||
      rankedCandidate.vendorMatched ||
      rankedCandidate.candidate.reasons.some((reason) => strongReasons.has(reason))
    );
  }

  private matchesExplicitSourceHint(
    candidate: DocumentationSemanticCandidate,
    explicitSource: string,
  ): boolean {
    if (!explicitSource) {
      return false;
    }

    const normalizedSubject = normalizeManualMatchText(
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
    const normalizedSubject = normalizeManualMatchText(subjectText);
    const candidateVendor = normalizeManualMatchText(
      candidate.semanticProfile?.vendor ?? '',
    );

    return (
      candidateVendor === queryVendor ||
      containsWholeNormalizedPhrase(normalizedSubject, queryVendor)
    );
  }

  private matchesModelHint(
    candidate: DocumentationSemanticCandidate,
    queryModel: string,
  ): boolean {
    if (!queryModel) {
      return false;
    }

    const candidateModel = normalizeManualMatchText(
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
      extractManualIdentifierAnchors([this.buildCandidateSubjectText(candidate)]),
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
      profile ? buildManualProfileAnchorText(profile) : null,
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

    return normalizeManualMatchText(
      [
        manual.filename,
        profile ? buildManualProfileAnchorText(profile) : null,
        tagText,
      ]
        .filter((value): value is string => Boolean(value))
        .join(' '),
    );
  }

  private collectSpecificSubjectPhrases(
    semanticQuery: DocumentationSemanticQuery,
    queryText: string,
  ): SpecificSubjectPhrase[] {
    const seen = new Set<string>();
    const phrases: SpecificSubjectPhrase[] = [];
    const addPhrase = (value: string | null | undefined) => {
      const normalized = normalizeManualMatchText(value ?? '');
      if (!normalized) {
        return;
      }

      const tokens = [...tokenizeManualStructuredPhrase(normalized)];
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
    for (const phrase of this.extractQueryDerivedSubjectPhrases(queryText)) {
      addPhrase(phrase);
    }

    return phrases;
  }

  private extractQueryDerivedSubjectPhrases(queryText: string): string[] {
    const normalizedQuery = normalizeManualMatchText(queryText);
    if (!normalizedQuery) {
      return [];
    }

    const rawTokens = normalizedQuery
      .split(' ')
      .map((token) => normalizeManualMatchToken(token))
      .filter(Boolean);
    if (rawTokens.length < 2) {
      return [];
    }

    const phrases: string[] = [];
    const seen = new Set<string>();
    const flushSpan = (spanTokens: string[]) => {
      if (spanTokens.length < 2) {
        return;
      }

      const maxWindowLength = Math.min(4, spanTokens.length);
      for (let windowLength = maxWindowLength; windowLength >= 2; windowLength -= 1) {
        for (
          let start = 0;
          start + windowLength <= spanTokens.length;
          start += 1
        ) {
          const windowTokens = spanTokens.slice(start, start + windowLength);
          if (!this.isMeaningfulQuerySubjectPhrase(windowTokens)) {
            continue;
          }

          const phrase = windowTokens.join(' ');
          if (seen.has(phrase)) {
            continue;
          }

          seen.add(phrase);
          phrases.push(phrase);
        }
      }
    };

    let currentSpan: string[] = [];
    for (const token of rawTokens) {
      if (token.length <= 2 || QUERY_SUBJECT_BOUNDARY_STOP_WORDS.has(token)) {
        flushSpan(currentSpan);
        currentSpan = [];
        continue;
      }

      currentSpan.push(token);
    }

    flushSpan(currentSpan);
    return phrases;
  }

  private isMeaningfulQuerySubjectPhrase(tokens: string[]): boolean {
    const meaningfulTokens = tokens.filter(
      (token) => token.length > 2 && !CONCEPT_TEXT_STOP_WORDS.has(token),
    );
    if (meaningfulTokens.length < 2) {
      return false;
    }

    return meaningfulTokens.some(
      (token) => token.length >= 4 || /\d/.test(token),
    );
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
      collapsedText.includes(collapseManualMatchText(token))
    );
  }

  private matchesSectionHintText(
    value: string,
    normalizedHint: string,
    hintTokens: string[],
  ): boolean {
    const normalizedValue = normalizeManualMatchText(value);
    if (!normalizedValue) {
      return false;
    }

    if (
      normalizedValue.includes(normalizedHint) ||
      collapseManualMatchText(normalizedValue).includes(collapseManualMatchText(normalizedHint))
    ) {
      return true;
    }

    const valueTokens = new Set(tokenizeManualMatchText(normalizedValue));
    const collapsedValue = collapseManualMatchText(normalizedValue);
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

}
