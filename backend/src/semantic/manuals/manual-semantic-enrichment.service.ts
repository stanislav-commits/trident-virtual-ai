import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RagflowService } from '../../ragflow/ragflow.service';
import {
  MANUAL_SEMANTIC_ENRICHMENT_MAX_CHARS,
  MANUAL_SEMANTIC_ENRICHMENT_MAX_CHUNKS,
  MANUAL_SEMANTIC_ENRICHMENT_CONCEPT_MIN_SCORE,
  MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS,
  MANUAL_SEMANTIC_PROFILE_MAX_PAGE_TOPICS,
  MANUAL_SEMANTIC_PROFILE_MAX_SECTIONS,
  SEMANTIC_PROFILE_SCHEMA_VERSION,
  SEMANTIC_SOURCE_CATEGORIES,
} from '../contracts/semantic.constants';
import { MANUAL_SEMANTIC_PROFILE_SCHEMA } from '../contracts/semantic.schemas';
import type {
  ConceptCandidate,
  ConceptDefinition,
  ManualSemanticProfile,
  SemanticIntent,
  SemanticSourceCategory,
} from '../contracts/semantic.types';
import {
  parseManualSemanticProfile,
  serializeConceptCatalogEntry,
} from '../contracts/semantic.validators';
import { ConceptCatalogService } from '../catalog/concept-catalog.service';
import { SemanticLlmService } from '../llm/semantic-llm.service';

type RagflowChunk = Awaited<
  ReturnType<RagflowService['listDocumentChunks']>
>[number];

export interface ManualSemanticEnrichmentResult {
  status: 'ready' | 'failed' | 'skipped';
  profile?: ManualSemanticProfile;
  error?: string;
}

@Injectable()
export class ManualSemanticEnrichmentService {
  private readonly logger = new Logger(ManualSemanticEnrichmentService.name);
  private readonly retryCooldownMs = Number.parseInt(
    process.env.RAGFLOW_SEMANTIC_ENRICHMENT_RETRY_COOLDOWN_MS || '3600000',
    10,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    private readonly conceptCatalog: ConceptCatalogService,
    private readonly semanticLlm: SemanticLlmService,
  ) {}

  shouldRefreshProfile(manual: {
    semanticProfileStatus?: string | null;
    semanticProfileVersion?: string | null;
    semanticProfile?: unknown;
    semanticProfileUpdatedAt?: Date | null;
  }): boolean {
    if (manual.semanticProfileVersion !== SEMANTIC_PROFILE_SCHEMA_VERSION) {
      return true;
    }
    if (manual.semanticProfileStatus === 'ready' && manual.semanticProfile) {
      return false;
    }
    if (
      !manual.semanticProfileStatus ||
      manual.semanticProfileStatus === 'pending'
    ) {
      return true;
    }

    const updatedAt = manual.semanticProfileUpdatedAt?.getTime() ?? 0;
    const retryCooldown = Number.isFinite(this.retryCooldownMs)
      ? this.retryCooldownMs
      : 3_600_000;
    return updatedAt === 0 || Date.now() - updatedAt >= retryCooldown;
  }

  async refreshManualProfile(params: {
    shipId: string;
    datasetId: string;
    manual: {
      id: string;
      ragflowDocumentId: string;
      filename: string;
      category: string | null;
    };
  }): Promise<ManualSemanticEnrichmentResult> {
    const { shipId, datasetId, manual } = params;
    await this.prisma.shipManual.update({
      where: { id: manual.id },
      data: {
        semanticProfileStatus: 'processing',
        semanticProfileError: null,
      },
    });

    try {
      const chunks = await this.ragflow.listDocumentChunks(
        datasetId,
        manual.ragflowDocumentId,
        300,
      );
      if (chunks.length === 0) {
        throw new Error('No parsed chunks available for semantic enrichment');
      }

      const evidence = this.buildEvidenceText(chunks);
      const conceptCandidates = await this.conceptCatalog.shortlistConcepts(
        [manual.filename, manual.category ?? '', evidence].join('\n'),
        {
          limit: 18,
          minScore: MANUAL_SEMANTIC_ENRICHMENT_CONCEPT_MIN_SCORE,
        },
      );
      const conceptDefinitions =
        await this.resolveConceptDefinitions(conceptCandidates);
      const profile = await this.buildProfile({
        manual,
        chunks,
        evidence,
        conceptCandidates,
        conceptDefinitions,
      });

      await this.prisma.shipManual.update({
        where: { id: manual.id },
        data: {
          semanticProfile: JSON.parse(JSON.stringify(profile)),
          semanticProfileStatus: 'ready',
          semanticProfileVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
          semanticProfileUpdatedAt: new Date(),
          semanticProfileError: null,
        },
      });

      this.logger.debug(
        `Manual semantic enrichment ready ship=${shipId} manual=${manual.id} file="${this.truncate(manual.filename)}" chunks=${chunks.length} primary=${profile.primaryConceptIds.join(',') || 'none'} secondary=${profile.secondaryConceptIds.join(',') || 'none'} sections=${profile.sections.length} pages=${profile.pageTopics.length}`,
      );

      return { status: 'ready', profile };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.shipManual.update({
        where: { id: manual.id },
        data: {
          semanticProfileStatus: 'failed',
          semanticProfileVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
          semanticProfileUpdatedAt: new Date(),
          semanticProfileError: message.slice(0, 2000),
        },
      });
      this.logger.warn(
        `Manual semantic enrichment failed ship=${shipId} manual=${manual.id} file="${this.truncate(manual.filename)}": ${message}`,
      );
      return { status: 'failed', error: message };
    }
  }

  private async buildProfile(params: {
    manual: {
      id: string;
      ragflowDocumentId: string;
      filename: string;
      category: string | null;
    };
    chunks: RagflowChunk[];
    evidence: string;
    conceptCandidates: ConceptCandidate[];
    conceptDefinitions: ConceptDefinition[];
  }): Promise<ManualSemanticProfile> {
    const fallback = this.buildFallbackProfile(params);

    if (!this.semanticLlm.isConfigured()) {
      this.logger.debug(
        `Manual semantic enrichment using deterministic fallback manual=${params.manual.id} concepts=${fallback.primaryConceptIds.join(',') || 'none'}`,
      );
      return fallback;
    }

    const raw = await this.semanticLlm.generateStructuredObject<unknown>({
      name: 'manual_semantic_profile',
      description:
        'Semantic enrichment profile for one parsed vessel knowledge-base document.',
      schema: MANUAL_SEMANTIC_PROFILE_SCHEMA as Record<string, unknown>,
      instructions: this.buildInstructions(),
      input: this.buildPromptInput(params),
    });
    const parsed = parseManualSemanticProfile(raw);
    if (!parsed) {
      throw new Error(
        'Manual semantic profile payload did not match validator',
      );
    }

    return this.postProcessProfile(parsed, fallback, params.conceptCandidates);
  }

  private buildInstructions(): string {
    return [
      'You enrich one vessel knowledge-base document into strict JSON metadata.',
      'Do not summarize beyond the evidence provided.',
      'Use canonical concept IDs only from the candidate concept shortlist.',
      'If a concept is not in the shortlist, capture it in systems/equipment/aliases rather than inventing an ID.',
      'If candidate concept evidence is weak or merely generic, leave concept arrays empty rather than guessing.',
      `Keep JSON compact: max ${MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS} systems/equipment/aliases each, max ${MANUAL_SEMANTIC_PROFILE_MAX_SECTIONS} sections, max ${MANUAL_SEMANTIC_PROFILE_MAX_PAGE_TOPICS} pageTopics, summaries under 180 characters.`,
      'Preserve page-aware structure when page markers are available.',
      'Prefer concrete procedure/checklist/warning/specification sections over broad generic sections.',
    ].join('\n');
  }

  private buildPromptInput(params: {
    manual: {
      filename: string;
      category: string | null;
    };
    evidence: string;
    conceptDefinitions: ConceptDefinition[];
  }): string {
    const concepts =
      params.conceptDefinitions.length > 0
        ? params.conceptDefinitions
            .map((concept) => `- ${serializeConceptCatalogEntry(concept)}`)
            .join('\n')
        : '- none';

    return [
      `Filename: ${params.manual.filename}`,
      `Source category: ${params.manual.category ?? 'unknown'}`,
      'Candidate concepts:',
      concepts,
      'Parsed evidence excerpts:',
      params.evidence,
    ].join('\n\n');
  }

  private buildFallbackProfile(params: {
    manual: {
      filename: string;
      category: string | null;
    };
    chunks: RagflowChunk[];
    conceptCandidates: ConceptCandidate[];
  }): ManualSemanticProfile {
    const sourceCategory = this.normalizeSourceCategory(params.manual.category);
    const primaryConceptIds = this.selectPrimaryConceptIds(
      params.conceptCandidates,
    );
    const secondaryConceptIds = params.conceptCandidates
      .map((candidate) => candidate.conceptId)
      .filter((conceptId) => !primaryConceptIds.includes(conceptId))
      .slice(0, 8);
    const pageTopics = this.buildFallbackPageTopics(
      params.chunks,
      primaryConceptIds,
    );

    return {
      schemaVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
      documentType: this.mapCategoryToDocumentType(sourceCategory),
      sourceCategory,
      primaryConceptIds,
      secondaryConceptIds,
      systems: [],
      equipment: [],
      vendor: null,
      model: null,
      aliases: [params.manual.filename.replace(/\.[a-z0-9]+$/i, '')],
      summary: `Semantic profile generated from parsed evidence for ${params.manual.filename}.`,
      sections: [],
      pageTopics,
    };
  }

  private postProcessProfile(
    profile: ManualSemanticProfile,
    fallback: ManualSemanticProfile,
    candidates: ConceptCandidate[],
  ): ManualSemanticProfile {
    const candidateIds = candidates.map((candidate) => candidate.conceptId);
    const filterConcepts = (conceptIds: string[]) =>
      conceptIds.filter((conceptId) => candidateIds.includes(conceptId));
    const primaryConceptIds = filterConcepts(profile.primaryConceptIds).slice(
      0,
      MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS,
    );
    const secondaryConceptIds = filterConcepts(profile.secondaryConceptIds)
      .filter((conceptId) => !primaryConceptIds.includes(conceptId))
      .slice(0, MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS);
    const pageTopics =
      profile.pageTopics.length > 0 ? profile.pageTopics : fallback.pageTopics;

    return {
      ...profile,
      schemaVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
      sourceCategory: profile.sourceCategory ?? fallback.sourceCategory,
      documentType: profile.documentType ?? fallback.documentType,
      primaryConceptIds:
        primaryConceptIds.length > 0
          ? primaryConceptIds
          : fallback.primaryConceptIds,
      secondaryConceptIds,
      systems: this.cleanStringList(profile.systems),
      equipment: this.cleanStringList(profile.equipment),
      aliases: this.cleanStringList(profile.aliases),
      summary: this.limitText(profile.summary || fallback.summary, 500),
      sections: this.cleanSections(profile.sections, candidateIds),
      pageTopics: this.cleanPageTopics(pageTopics, candidateIds),
    };
  }

  private cleanSections(
    sections: ManualSemanticProfile['sections'],
    allowedConceptIds: string[],
  ): ManualSemanticProfile['sections'] {
    const allowed = new Set(allowedConceptIds);
    return sections
      .filter((section) => section.title.trim() || section.summary.trim())
      .slice(0, MANUAL_SEMANTIC_PROFILE_MAX_SECTIONS)
      .map((section) => ({
        ...section,
        title: this.limitText(section.title, 120),
        summary: this.limitText(section.summary, 180),
        conceptIds: this.cleanConceptIds(section.conceptIds, allowed),
      }));
  }

  private cleanPageTopics(
    pageTopics: ManualSemanticProfile['pageTopics'],
    allowedConceptIds: string[],
  ): ManualSemanticProfile['pageTopics'] {
    const allowed = new Set(allowedConceptIds);
    return pageTopics
      .filter((topic) => Number.isFinite(topic.page) && topic.summary.trim())
      .slice(0, MANUAL_SEMANTIC_PROFILE_MAX_PAGE_TOPICS)
      .map((topic) => ({
        ...topic,
        summary: this.limitText(topic.summary, 180),
        conceptIds: this.cleanConceptIds(topic.conceptIds, allowed),
      }));
  }

  private cleanConceptIds(
    conceptIds: string[],
    allowedConceptIds: Set<string>,
  ): string[] {
    return [...new Set(conceptIds)]
      .filter((conceptId) => allowedConceptIds.has(conceptId))
      .slice(0, MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS);
  }

  private cleanStringList(values: string[]): string[] {
    return [...new Set(values.map((value) => this.limitText(value, 120)))]
      .filter(Boolean)
      .slice(0, MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS);
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }

  private buildEvidenceText(chunks: RagflowChunk[]): string {
    const sortedChunks = [...chunks].sort((left, right) => {
      const leftPage = this.extractChunkPageNumber(left);
      const rightPage = this.extractChunkPageNumber(right);
      if (leftPage !== undefined && rightPage !== undefined) {
        if (leftPage !== rightPage) return leftPage - rightPage;
      }
      return left.id.localeCompare(right.id);
    });

    const lines: string[] = [];
    let charCount = 0;

    for (const chunk of sortedChunks.slice(
      0,
      MANUAL_SEMANTIC_ENRICHMENT_MAX_CHUNKS,
    )) {
      const content = (chunk.content ?? '').replace(/\s+/g, ' ').trim();
      if (!content) {
        continue;
      }
      const excerpt = content.slice(0, 1200);
      const line = `[Page ${this.extractChunkPageNumber(chunk) ?? 'unknown'}] ${excerpt}`;
      if (charCount + line.length > MANUAL_SEMANTIC_ENRICHMENT_MAX_CHARS) {
        break;
      }
      lines.push(line);
      charCount += line.length;
    }

    return lines.join('\n');
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

  private selectPrimaryConceptIds(candidates: ConceptCandidate[]): string[] {
    if (candidates.length === 0) {
      return [];
    }

    const bestScore = candidates[0].score;
    return candidates
      .filter((candidate) => candidate.score >= Math.max(8, bestScore * 0.66))
      .slice(0, 4)
      .map((candidate) => candidate.conceptId);
  }

  private buildFallbackPageTopics(
    chunks: RagflowChunk[],
    conceptIds: string[],
  ): ManualSemanticProfile['pageTopics'] {
    const byPage = new Map<number, string>();
    for (const chunk of chunks) {
      const page = this.extractChunkPageNumber(chunk);
      if (page === undefined || byPage.has(page)) {
        continue;
      }

      const summary = (chunk.content ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
      if (summary) {
        byPage.set(page, summary);
      }
      if (byPage.size >= 12) {
        break;
      }
    }

    return [...byPage.entries()].map(([page, summary]) => ({
      page,
      conceptIds,
      summary,
    }));
  }

  private normalizeSourceCategory(
    value?: string | null,
  ): SemanticSourceCategory | null {
    const normalized = value?.trim().toUpperCase();
    return (
      SEMANTIC_SOURCE_CATEGORIES.find((category) => category === normalized) ??
      null
    );
  }

  private mapCategoryToDocumentType(
    category: SemanticSourceCategory | null,
  ): SemanticIntent {
    switch (category) {
      case 'HISTORY_PROCEDURES':
        return 'operational_procedure';
      case 'REGULATION':
        return 'regulation_compliance';
      case 'CERTIFICATES':
        return 'certificate_lookup';
      case 'MANUALS':
      default:
        return 'manual_lookup';
    }
  }

  private extractChunkPageNumber(chunk: RagflowChunk): number | undefined {
    const value = chunk.meta?.page_num;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private truncate(value: string, maxLength = 140): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }
}
