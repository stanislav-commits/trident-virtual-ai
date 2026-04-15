import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ConceptCandidate,
  ConceptDefinition,
  SemanticConceptFamily,
} from './semantic.types';

const STATIC_CONCEPTS: ConceptDefinition[] = [
  {
    id: 'bunkering_operation',
    family: 'operational_topic',
    label: 'Bunkering operation',
    description:
      'Receiving fuel onboard, including preparation, transfer monitoring, completion, and spill prevention.',
    aliases: [
      'bunkering',
      'bunker operation',
      'bunker transfer',
      'bunker checklist',
      'fuel transfer',
      'taking fuel onboard',
      'fuel receiving',
      'receiving fuel onboard',
    ],
    sourcePreferences: ['HISTORY_PROCEDURES', 'REGULATION'],
    relatedSystems: ['fuel_system'],
  },
  {
    id: 'sewage_treatment_system',
    family: 'asset_system',
    label: 'Sewage treatment system',
    description:
      'Sewage treatment plant systems, STP equipment, treatment cycles, maintenance, and operating guidance.',
    aliases: [
      'sewage treatment plant',
      'stp',
      'blue sea plus',
      'blue sea 4000 plus',
    ],
    sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES'],
    relatedSystems: ['sewage_system'],
  },
  {
    id: 'helm_station_control',
    family: 'asset_system',
    label: 'Helm station control',
    description:
      'Helm station, control station, active station selection, and transfer of vessel control between stations.',
    aliases: [
      'helm station',
      'control station',
      'active station',
      'station transfer',
      'transfer control',
      'helm station transfer',
      'station activation',
      'helm station change',
    ],
    sourcePreferences: ['MANUALS'],
    relatedSystems: ['control_system', 'helm_station', 'steering_control'],
    relatedEquipment: ['helm_station', 'control_levers'],
  },
  {
    id: 'maintenance_checklist',
    family: 'maintenance_topic',
    label: 'Maintenance checklist',
    description:
      'Planned maintenance tasks, service intervals, checks, replacements, and inspection steps.',
    aliases: [
      'maintenance checklist',
      'service checklist',
      'maintenance tasks',
    ],
    sourcePreferences: ['MANUALS', 'HISTORY_PROCEDURES'],
  },
  {
    id: 'troubleshooting_guide',
    family: 'maintenance_topic',
    label: 'Troubleshooting guide',
    description:
      'Fault diagnosis, causes, corrective actions, alarms, and troubleshooting steps.',
    aliases: ['troubleshooting', 'fault finding', 'diagnostics'],
    sourcePreferences: ['MANUALS'],
  },
  {
    id: 'spare_parts_catalog',
    family: 'maintenance_topic',
    label: 'Spare parts catalogue',
    description:
      'Spare parts catalogues, part numbers, kit contents, assemblies, seal kits, anode kits, and replacement item lists.',
    aliases: [
      'spare parts',
      'spare part catalogue',
      'parts catalogue',
      'part numbers',
      'seal kit',
      'anode kit',
      'kit contents',
      'assembly parts',
    ],
    sourcePreferences: ['MANUALS'],
  },
  {
    id: 'certificate_expiry_status',
    family: 'certificate_topic',
    label: 'Certificate expiry',
    description:
      'Certificate validity, expiry date, renewal status, and upcoming due dates.',
    aliases: [
      'certificate expiry',
      'valid until',
      'certificate due',
      'renewal',
    ],
    sourcePreferences: ['CERTIFICATES', 'REGULATION'],
  },
  {
    id: 'regulatory_compliance',
    family: 'regulation_topic',
    label: 'Regulatory compliance',
    description:
      'Compliance obligations, statutory restrictions, conventions, annexes, and vessel requirements.',
    aliases: ['compliance', 'requirement', 'obligation', 'regulation'],
    sourcePreferences: ['REGULATION'],
  },
];

const CONCEPT_MATCH_STOP_WORDS = new Set([
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
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'concept',
  'document',
  'equipment',
  'general',
  'guide',
  'handbook',
  'information',
  'instruction',
  'instructions',
  'installation',
  'manual',
  'marine',
  'operation',
  'related',
  'system',
  'systems',
  'technical',
  'user',
  'vessel',
]);

const CONCEPT_MATCH_LOW_SIGNAL_TOKENS = new Set([
  'check',
  'checklist',
  'guide',
  'list',
  'operation',
  'procedure',
  'task',
]);

interface CachedConceptCatalog {
  concepts: ConceptDefinition[];
  loadedAt: number;
}

@Injectable()
export class ConceptCatalogService {
  private readonly logger = new Logger(ConceptCatalogService.name);
  private cachedCatalog: CachedConceptCatalog | null = null;
  private readonly cacheTtlMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async listConcepts(): Promise<ConceptDefinition[]> {
    const cached = this.cachedCatalog;
    const now = Date.now();
    if (cached && now - cached.loadedAt < this.cacheTtlMs) {
      return cached.concepts;
    }

    const tagConcepts = await this.loadTagConcepts();
    const concepts = this.dedupeConcepts([...STATIC_CONCEPTS, ...tagConcepts]);
    this.cachedCatalog = {
      concepts,
      loadedAt: now,
    };

    return concepts;
  }

  async getConceptById(id: string): Promise<ConceptDefinition | null> {
    const concepts = await this.listConcepts();
    return concepts.find((concept) => concept.id === id) ?? null;
  }

  async shortlistConcepts(
    text: string,
    options?: {
      families?: SemanticConceptFamily[];
      limit?: number;
      minScore?: number;
    },
  ): Promise<ConceptCandidate[]> {
    const normalized = this.normalizeText(text);
    if (!normalized) {
      return [];
    }

    const queryTokens = new Set(this.tokenize(normalized));
    const concepts = await this.listConcepts();
    const allowedFamilies = options?.families
      ? new Set(options.families)
      : null;

    const minScore = options?.minScore ?? 0;

    return concepts
      .filter((concept) =>
        allowedFamilies ? allowedFamilies.has(concept.family) : true,
      )
      .map((concept) => ({
        conceptId: concept.id,
        label: concept.label,
        family: concept.family,
        score: this.scoreConceptMatch(concept, normalized, queryTokens),
      }))
      .filter((candidate) => candidate.score > minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, options?.limit ?? 12);
  }

  async shortlistFamilies(
    text: string,
    limit = 4,
  ): Promise<SemanticConceptFamily[]> {
    const candidates = await this.shortlistConcepts(text, {
      limit: 24,
      minScore: 1,
    });
    const scores = new Map<SemanticConceptFamily, number>();

    for (const candidate of candidates) {
      scores.set(
        candidate.family,
        (scores.get(candidate.family) ?? 0) + candidate.score,
      );
    }

    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([family]) => family);
  }

  private async loadTagConcepts(): Promise<ConceptDefinition[]> {
    try {
      const tags = await this.prisma.tag.findMany({
        orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { item: 'asc' }],
        select: {
          key: true,
          category: true,
          subcategory: true,
          item: true,
          description: true,
        },
      });

      return tags.map((tag) => {
        const label = this.humanizeTagItem(tag.item);
        const aliases = [
          label,
          tag.item.replace(/_/g, ' '),
          `${tag.subcategory} ${label}`.trim(),
        ]
          .map((alias) => alias.trim())
          .filter(Boolean);

        return {
          id: `tag:${tag.key}`,
          family: 'asset_system' as const,
          label,
          description:
            tag.description?.trim() ||
            `${tag.subcategory} related equipment or system concept.`,
          aliases: [...new Set(aliases)],
          sourcePreferences: ['MANUALS'],
          relatedTags: [tag.key],
          relatedSystems: [tag.subcategory],
          relatedEquipment: [tag.item],
        };
      });
    } catch (error) {
      this.logger.warn(
        `Failed to load dynamic tag concepts, falling back to static catalog only: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private dedupeConcepts(concepts: ConceptDefinition[]): ConceptDefinition[] {
    const byId = new Map<string, ConceptDefinition>();

    for (const concept of concepts) {
      if (!byId.has(concept.id)) {
        byId.set(concept.id, {
          ...concept,
          aliases: [...new Set(concept.aliases)],
          sourcePreferences: [...new Set(concept.sourcePreferences)],
          relatedSystems: [...new Set(concept.relatedSystems ?? [])],
          relatedEquipment: [...new Set(concept.relatedEquipment ?? [])],
          relatedTags: [...new Set(concept.relatedTags ?? [])],
        });
      }
    }

    return [...byId.values()];
  }

  private scoreConceptMatch(
    concept: ConceptDefinition,
    normalizedText: string,
    queryTokens: Set<string>,
  ): number {
    let score = 0;
    const exactHaystacks = [
      concept.label,
      concept.id,
      ...(concept.aliases ?? []),
    ].map((entry) => this.normalizeText(entry));

    for (const haystack of exactHaystacks) {
      if (!haystack) {
        continue;
      }

      if (normalizedText.includes(haystack)) {
        score = Math.max(score, 12 + haystack.split(' ').length);
      }
    }

    const tokenSources = [
      concept.label,
      concept.id,
      ...(concept.aliases ?? []),
      ...(concept.relatedSystems ?? []),
      ...(concept.relatedEquipment ?? []),
    ];
    if (!concept.id.startsWith('tag:')) {
      tokenSources.push(concept.description);
    }
    const conceptTokens = new Set(this.tokenize(tokenSources.join(' ')));

    let overlap = 0;
    for (const token of queryTokens) {
      if (conceptTokens.has(token)) {
        overlap += CONCEPT_MATCH_LOW_SIGNAL_TOKENS.has(token) ? 1 : 2;
      }
    }

    return score + overlap * 2;
  }

  private humanizeTagItem(item: string): string {
    return item
      .replace(/_/g, ' ')
      .replace(/\bps\b/gi, 'port side')
      .replace(/\bsb\b/gi, 'starboard side')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_:./\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(value: string): string[] {
    return this.normalizeText(value)
      .split(' ')
      .map((token) => this.canonicalizeToken(token))
      .filter(
        (token) => token.length > 1 && !CONCEPT_MATCH_STOP_WORDS.has(token),
      );
  }

  private canonicalizeToken(value: string): string {
    if (value.endsWith('ies') && value.length > 4) {
      return `${value.slice(0, -3)}y`;
    }
    if (value.endsWith('ing') && value.length > 5) {
      return value.slice(0, -3);
    }
    if (value.endsWith('ed') && value.length > 4) {
      return value.slice(0, -2);
    }
    if (value.endsWith('s') && value.length > 3 && !value.endsWith('ss')) {
      return value.slice(0, -1);
    }
    return value;
  }
}
