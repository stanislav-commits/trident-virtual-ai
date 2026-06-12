import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GrafanaLlmService } from '../../integrations/grafana-llm/grafana-llm.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricAggregationRule } from './enums/metric-aggregation-rule.enum';
import { MetricConceptType } from './enums/metric-concept-type.enum';

/**
 * Builds COMPOSITE metric concepts that bundle multiple single concepts into
 * semantic groups for the chat resolver. Two complementary strategies:
 *
 * 1. `measurement` (default, deterministic, $0)
 *    Groups single concepts by (bucket, measurement, field_pattern) directly
 *    from catalog rows. Field-pattern detection (active_power / rms_current /
 *    rms_voltage / energy_counter / temperature / level / pressure / flow)
 *    picks the right aggregation rule. Covers ~95% of trending-style ship
 *    telemetry where measurement names ARE the semantic boundary
 *    (`AFT-GARAGE-HYDRAULIC`, `WATER-MAKER-1`, `UTA-1` …).
 *
 * 2. `higher_order` (LLM, ~$0.05-0.15)
 *    Asks gpt-4o to propose cross-measurement vessel-wide groupings
 *    ("Vessel navigation", "Total electrical load on board", "All HVAC")
 *    out of a small input (the measurement-level composites + the
 *    standalone single concepts that strategy 1 left out). Smaller input
 *    list makes the LLM far more reliable than feeding it all 2179
 *    raw metrics.
 *
 * 3. `both` runs strategy 1 first, then feeds its output into strategy 2.
 *
 * Existing SINGLE concepts are never modified or deleted — composites
 * coexist with them and share leaf catalog rows as members. The
 * MetricsConceptExecutionService.computeCompositeAggregate already handles
 * sum/mean/min/max/last across members, so the only thing missing in the
 * stack was the composite rows themselves.
 *
 * Endpoint: POST /api/metrics/ships/:shipId/cluster-semantic-groups?strategy=measurement|higher_order|both[&dryRun=1]
 */

interface ProposedGroup {
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  aggregation: 'sum' | 'mean' | 'last' | 'max' | 'min';
  unit: string | null;
  member_slugs: string[];
}

interface LlmClusteringResponse {
  groups: ProposedGroup[];
}

interface SingleConceptRecord {
  conceptId: string;
  slug: string;
  displayName: string;
  description: string | null;
  metricCatalogId: string;
  bucket: string;
  measurement: string;
  field: string;
}

/**
 * What the dispatcher records for caller (UI / curl). Each group entry is
 * one composite concept that exists (or would exist, if dryRun=true) in
 * `metric_concepts`. `strategy` lets the caller see which path produced it.
 */
export interface SemanticClusteringResult {
  shipId: string;
  shipName: string;
  strategy: 'measurement' | 'higher_order' | 'both';
  totalSingleConcepts: number;
  proposedGroups: number;
  createdGroups: number;
  reusedGroups: number;
  skippedSmallGroups: number;
  totalMembersLinked: number;
  groups: Array<{
    strategy: 'measurement' | 'higher_order';
    slug: string;
    displayName: string;
    aggregation: string;
    memberCount: number;
    action: 'created' | 'reused';
  }>;
  dryRun: boolean;
}

export type ClusterStrategy = 'measurement' | 'higher_order' | 'both';

interface ClusterOptions {
  strategy?: ClusterStrategy;
  dryRun?: boolean;
}

const MIN_GROUP_MEMBERS = 2;
// Drop telegraf system telemetry from composite clustering — the SINGLE
// concepts still exist for these so "what's disk usage" can still resolve;
// they just don't pollute the operational composite taxonomy.
const SKIP_MEASUREMENTS = new Set([
  'cpu',
  'disk',
  'diskio',
  'mem',
  'kernel',
  'processes',
  'swap',
  'system',
]);

const AGGREGATION_TO_RULE: Record<
  ProposedGroup['aggregation'],
  MetricAggregationRule
> = {
  sum: MetricAggregationRule.SUM,
  mean: MetricAggregationRule.AVG,
  last: MetricAggregationRule.LAST,
  max: MetricAggregationRule.MAX,
  min: MetricAggregationRule.MIN,
};

const AGGREGATION_LABEL: Record<MetricAggregationRule, string> = {
  [MetricAggregationRule.SUM]: 'sum',
  [MetricAggregationRule.AVG]: 'mean',
  [MetricAggregationRule.MIN]: 'min',
  [MetricAggregationRule.MAX]: 'max',
  [MetricAggregationRule.LAST]: 'last',
  [MetricAggregationRule.NONE]: 'none',
  [MetricAggregationRule.COORDINATE_PAIR]: 'coordinate_pair',
  [MetricAggregationRule.COMPARE]: 'compare',
  [MetricAggregationRule.TRAJECTORY]: 'trajectory',
};

interface MeasurementFieldPattern {
  pattern: string;
  label: string;
  aggregation: MetricAggregationRule;
  defaultUnit: string | null;
}

@Injectable()
export class MetricsSemanticClusterService {
  private readonly logger = new Logger(MetricsSemanticClusterService.name);
  private readonly clusteringModel = 'gpt-4o';
  private readonly maxOutputTokens = 16000;

  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    @InjectRepository(MetricConceptEntity)
    private readonly metricConceptRepository: Repository<MetricConceptEntity>,
    @InjectRepository(MetricConceptMemberEntity)
    private readonly metricConceptMemberRepository: Repository<MetricConceptMemberEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly shipMetricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    private readonly grafanaLlmService: GrafanaLlmService,
  ) {}

  // =================================================================
  // Public dispatcher
  // =================================================================

  async clusterShipConcepts(
    shipId: string,
    options: ClusterOptions = {},
  ): Promise<SemanticClusteringResult> {
    const strategy: ClusterStrategy = options.strategy ?? 'measurement';
    const dryRun = Boolean(options.dryRun);

    const ship = await this.shipsRepository.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');

    const singles = await this.loadShipSingleConcepts(shipId);
    if (singles.length < MIN_GROUP_MEMBERS) {
      throw new BadRequestException(
        `Ship has too few single concepts (${singles.length}) to cluster`,
      );
    }

    const baseResult: SemanticClusteringResult = {
      shipId,
      shipName: ship.name,
      strategy,
      totalSingleConcepts: singles.length,
      proposedGroups: 0,
      createdGroups: 0,
      reusedGroups: 0,
      skippedSmallGroups: 0,
      totalMembersLinked: 0,
      groups: [],
      dryRun,
    };

    if (strategy === 'measurement') {
      return this.clusterByMeasurement(singles, baseResult, dryRun);
    }

    if (strategy === 'higher_order') {
      // Always prefer the compact (composites + leftover-singles) input —
      // it stays under the LLM context limit. If no composites have been
      // created yet, the helper falls back to all singles.
      const input = await this.buildLlmInputForHigherOrder(shipId, singles);
      return this.clusterByLlmHigherOrder(input, baseResult, dryRun);
    }

    // strategy === 'both'
    const afterStage1 = await this.clusterByMeasurement(
      singles,
      baseResult,
      dryRun,
    );
    const stage2Input = await this.buildLlmInputForHigherOrder(shipId, singles);
    return this.clusterByLlmHigherOrder(stage2Input, afterStage1, dryRun);
  }

  // =================================================================
  // Strategy 1 — deterministic per-measurement
  // =================================================================

  private async clusterByMeasurement(
    singles: SingleConceptRecord[],
    result: SemanticClusteringResult,
    dryRun: boolean,
  ): Promise<SemanticClusteringResult> {
    // Group leaves by (bucket, measurement, field-pattern).
    type BucketKey = string;
    const groups = new Map<
      BucketKey,
      {
        bucket: string;
        measurement: string;
        pattern: MeasurementFieldPattern;
        members: SingleConceptRecord[];
      }
    >();

    for (const record of singles) {
      const measurement = record.measurement?.trim();
      if (!measurement) continue;
      if (SKIP_MEASUREMENTS.has(measurement)) continue;
      if (SKIP_MEASUREMENTS.has(measurement.toLowerCase())) continue;
      const pattern = this.detectFieldPattern(record.field);
      const key = `${record.bucket}|${measurement}|${pattern.pattern}`;
      if (!groups.has(key)) {
        groups.set(key, {
          bucket: record.bucket,
          measurement,
          pattern,
          members: [],
        });
      }
      groups.get(key)!.members.push(record);
    }

    this.logger.log(
      `clusterByMeasurement: proposed ${groups.size} group(s) ` +
        `from ${singles.length} single concept(s)`,
    );

    for (const group of groups.values()) {
      result.proposedGroups += 1;
      if (group.members.length < MIN_GROUP_MEMBERS) {
        result.skippedSmallGroups += 1;
        continue;
      }

      const slug = this.normalizeSlug(
        [group.bucket, group.measurement, group.pattern.pattern].join('_'),
      );
      const displayName = this.truncate(
        `${this.humanize(group.measurement)} — ${group.pattern.label}`,
        255,
      );
      const category = this.deriveCategoryFromBucket(group.bucket);
      const description = this.truncate(
        `Auto-derived from Influx measurement "${group.measurement}" in bucket "${group.bucket}", bundling ${group.members.length} ${group.pattern.label.toLowerCase()} field(s) as a ${AGGREGATION_LABEL[group.pattern.aggregation]} aggregate.`,
        2000,
      );
      const unit = group.pattern.defaultUnit;
      const memberCatalogIds = group.members.map((m) => m.metricCatalogId);

      if (dryRun) {
        result.groups.push({
          strategy: 'measurement',
          slug,
          displayName,
          aggregation: AGGREGATION_LABEL[group.pattern.aggregation],
          memberCount: memberCatalogIds.length,
          action: 'created',
        });
        continue;
      }

      const persisted = await this.upsertCompositeGroup(slug, {
        display_name: displayName,
        description,
        category,
        aggregation_rule: group.pattern.aggregation,
        unit,
        memberCatalogIds,
      });

      if (persisted.created) result.createdGroups += 1;
      else result.reusedGroups += 1;
      result.totalMembersLinked += persisted.memberCount;
      result.groups.push({
        strategy: 'measurement',
        slug,
        displayName,
        aggregation: AGGREGATION_LABEL[group.pattern.aggregation],
        memberCount: persisted.memberCount,
        action: persisted.created ? 'created' : 'reused',
      });
    }

    return result;
  }

  // Field-name → semantic pattern.
  //
  // The Trending bucket is dominated by 3-phase electrical measurements
  // for each device. Power phases are SUMmed for total real power,
  // current/voltage phases are MEANed (phase asymmetry is small), energy
  // counters take LAST (cumulative reading). Everything else falls back
  // to MEAN — better than NONE for the executor which would otherwise
  // return null on a heterogeneous composite.
  private detectFieldPattern(field: string): MeasurementFieldPattern {
    const lower = field.toLowerCase();
    if (lower.includes('active power')) {
      return {
        pattern: 'active_power',
        label: 'Active power',
        aggregation: MetricAggregationRule.SUM,
        defaultUnit: 'W',
      };
    }
    if (
      lower.includes('partial active energy') ||
      lower.includes('energy delivered')
    ) {
      return {
        pattern: 'energy_counter',
        label: 'Energy counter',
        aggregation: MetricAggregationRule.LAST,
        defaultUnit: 'Wh',
      };
    }
    if (lower.includes('reactive power')) {
      return {
        pattern: 'reactive_power',
        label: 'Reactive power',
        aggregation: MetricAggregationRule.SUM,
        defaultUnit: 'VAr',
      };
    }
    if (lower.includes('apparent power')) {
      return {
        pattern: 'apparent_power',
        label: 'Apparent power',
        aggregation: MetricAggregationRule.SUM,
        defaultUnit: 'VA',
      };
    }
    if (lower.includes('rms current')) {
      return {
        pattern: 'rms_current',
        label: 'RMS current',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: 'A',
      };
    }
    if (lower.includes('rms') && lower.includes('voltage')) {
      return {
        pattern: 'rms_voltage',
        label: 'RMS voltage',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: 'V',
      };
    }
    if (lower.includes('frequency')) {
      return {
        pattern: 'frequency',
        label: 'Frequency',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: 'Hz',
      };
    }
    if (lower.includes('temperature') || /\btemp\b/.test(lower)) {
      return {
        pattern: 'temperature',
        label: 'Temperature',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: '°C',
      };
    }
    if (lower.includes('level')) {
      return {
        pattern: 'level',
        label: 'Level',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: null,
      };
    }
    if (lower.includes('pressure')) {
      return {
        pattern: 'pressure',
        label: 'Pressure',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: null,
      };
    }
    if (lower.includes('flow')) {
      return {
        pattern: 'flow',
        label: 'Flow rate',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: null,
      };
    }
    if (lower.includes('power factor') || lower.includes('powerfactor')) {
      return {
        pattern: 'power_factor',
        label: 'Power factor',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: null,
      };
    }
    if (lower.includes('thd')) {
      return {
        pattern: 'thd',
        label: 'Total harmonic distortion',
        aggregation: MetricAggregationRule.AVG,
        defaultUnit: '%',
      };
    }
    return {
      pattern: 'misc',
      label: 'Fields',
      aggregation: MetricAggregationRule.AVG,
      defaultUnit: null,
    };
  }

  private deriveCategoryFromBucket(bucket: string): string | null {
    const lower = bucket.trim().toLowerCase();
    if (!lower) return null;
    if (lower === 'nmea') return 'navigation';
    if (lower === 'trending') return 'electrical';
    return lower;
  }

  // =================================================================
  // Strategy 2 — LLM higher-order
  // =================================================================

  private async clusterByLlmHigherOrder(
    items: LlmInputItem[],
    result: SemanticClusteringResult,
    dryRun: boolean,
  ): Promise<SemanticClusteringResult> {
    if (!this.grafanaLlmService.isConfigured()) {
      throw new BadRequestException(
        'LLM is not configured. Set GRAFANA_LLM_BASE_URL / GRAFANA_LLM_API_KEY in env.',
      );
    }
    if (items.length === 0) {
      this.logger.warn('No input concepts for higher-order LLM clustering');
      return result;
    }

    const proposal = await this.proposeGroupsViaLlm(items);

    // Build slug -> leaf catalog ids map (an input slug can already be a
    // composite, in which case we union its member catalog ids).
    const slugToCatalogIds = new Map<string, string[]>();
    for (const item of items) {
      slugToCatalogIds.set(item.slug, item.catalogIds);
    }

    const usedSlugs = new Set<string>();
    for (const group of proposal.groups) {
      result.proposedGroups += 1;
      const groupSlug = this.normalizeSlug(group.slug);
      if (!groupSlug || usedSlugs.has(groupSlug)) {
        result.skippedSmallGroups += 1;
        continue;
      }
      usedSlugs.add(groupSlug);

      // Resolve member slugs → catalog ids (union; allow overlap with
      // strategy-1 composites — a leaf can be in many composites).
      const catalogIdSet = new Set<string>();
      for (const memberSlug of group.member_slugs) {
        const normalized = this.normalizeSlug(memberSlug);
        const ids = slugToCatalogIds.get(normalized);
        if (!ids) continue;
        ids.forEach((id) => catalogIdSet.add(id));
      }
      const memberCatalogIds = [...catalogIdSet];

      if (memberCatalogIds.length < MIN_GROUP_MEMBERS) {
        result.skippedSmallGroups += 1;
        continue;
      }

      const aggregationRule = AGGREGATION_TO_RULE[group.aggregation];
      if (!aggregationRule) {
        result.skippedSmallGroups += 1;
        continue;
      }

      if (dryRun) {
        result.groups.push({
          strategy: 'higher_order',
          slug: groupSlug,
          displayName: group.display_name,
          aggregation: group.aggregation,
          memberCount: memberCatalogIds.length,
          action: 'created',
        });
        continue;
      }

      const persisted = await this.upsertCompositeGroup(groupSlug, {
        display_name: group.display_name,
        description: group.description,
        category: group.category,
        aggregation_rule: aggregationRule,
        unit: group.unit,
        memberCatalogIds,
      });
      if (persisted.created) result.createdGroups += 1;
      else result.reusedGroups += 1;
      result.totalMembersLinked += persisted.memberCount;
      result.groups.push({
        strategy: 'higher_order',
        slug: groupSlug,
        displayName: group.display_name,
        aggregation: group.aggregation,
        memberCount: persisted.memberCount,
        action: persisted.created ? 'created' : 'reused',
      });
    }

    return result;
  }

  // Build input list for strategy 2: always pulls existing composites from
  // DB first, then adds singles that aren't already covered. Works whether
  // strategy 1 ran in this request, ran in a previous request, or never ran
  // (in which case the loop returns just the singles).
  private async buildLlmInputForHigherOrder(
    shipId: string,
    singles: SingleConceptRecord[],
  ): Promise<LlmInputItem[]> {
    // Map each leaf catalog id to one or more concept ids covering it (we
    // want strategy-2 to see the COMPOSITE rather than the underlying SINGLE
    // when they overlap).
    const composites = await this.metricConceptRepository.find({
      where: { type: MetricConceptType.COMPOSITE, isActive: true },
      relations: { members: { metricCatalog: true } },
    });

    const items: LlmInputItem[] = [];
    const coveredCatalogIds = new Set<string>();

    for (const concept of composites) {
      const catalogIds = (concept.members ?? [])
        .filter((m) => m.metricCatalog?.shipId === shipId)
        .map((m) => m.metricCatalogId);
      if (!catalogIds.length) continue;
      catalogIds.forEach((id) => coveredCatalogIds.add(id));
      const sample = concept.members?.[0]?.metricCatalog;
      // For a composite, the concept's own description is the auto-generated
      // "Auto-derived from Influx measurement X" boilerplate — useless. The
      // first member's catalog description (filled by backfill) is the
      // real domain hint that catches mislabeled measurements (e.g. fuel
      // metrics living under measurement="Temperatures").
      items.push({
        slug: concept.slug,
        displayName: concept.displayName,
        memberCount: catalogIds.length,
        bucket: sample?.bucket ?? '',
        measurement: (sample?.key ?? '').split('::')[1] ?? '',
        field: sample?.field ?? '',
        catalogIds,
        description: sample?.description ?? undefined,
      });
    }

    // Add singles that are NOT covered by any composite yet (so the LLM has
    // a chance to weave them into a higher-order group too).
    for (const single of singles) {
      if (coveredCatalogIds.has(single.metricCatalogId)) continue;
      if (SKIP_MEASUREMENTS.has(single.measurement)) continue;
      items.push({
        slug: single.slug,
        displayName: single.displayName,
        memberCount: 1,
        bucket: single.bucket,
        measurement: single.measurement,
        field: single.field,
        catalogIds: [single.metricCatalogId],
        description: single.description ?? undefined,
      });
    }

    return items;
  }

  private async proposeGroupsViaLlm(
    items: LlmInputItem[],
  ): Promise<LlmClusteringResponse> {
    const lines = items.map((item) => {
      // Tight descriptions only. Anything longer than this both wastes
      // tokens and tends to repeat the slug/displayName. We chop at 80
      // chars to keep ~2000 items comfortably under gpt-4o's 128K context.
      const desc = (item.description ?? '').replace(/\s+/g, ' ').trim();
      const truncatedDesc = desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
      return [
        item.slug,
        item.displayName,
        item.bucket,
        item.measurement,
        item.field,
        `members:${item.memberCount}`,
        truncatedDesc ? `desc:${truncatedDesc}` : '',
      ]
        .filter((part) => part.length > 0)
        .map((part) => part.replace(/\|/g, ' '))
        .join(' | ');
    });

    const systemPrompt = [
      'You are organizing marine vessel telemetry into HIGHER-ORDER semantic groups for a chat assistant.',
      'Each input line is: `slug | display_name | bucket | measurement | field | members:<n> | desc:<description>`. A members count > 1 means the slug is already a per-device composite. The `desc:` field is the authoritative semantic hint — TRUST IT OVER measurement/field names. If desc says "fuel tank level" or "engine fuel rate" while measurement says "Temperatures", the metric IS fuel-related; group it in the fuel system.',
      'Your job: cluster these into 10-20 VESSEL-WIDE operational domains a yacht crew would ask about:',
      '  Total electrical load on board, Vessel navigation, Vessel position/heading, All HVAC, Whole fuel system, All fresh-water tanks, All sewage / black-water, Engine instrumentation, All refrigeration, Vessel-wide safety alarms, Hydraulic systems, ...',
      'Each group MUST have an aggregation strategy describing how members combine into ONE answer:',
      '  - "sum"  : totals (total active power, total fuel consumption flow rate, total energy delivered)',
      '  - "mean" : representative averages across similar tanks/zones (average tank level, average cabin temperature)',
      '  - "last" : single current state of a coordinate-like primary (vessel position, heading, speed)',
      '  - "max"  : peak (max engine room temperature)',
      '  - "min"  : floor (min fresh-water tank level)',
      'Group rules:',
      '  - >= 3 input slugs per group; AGGRESSIVELY include EVERY slug that fits the domain (NOT just 3-5 examples).',
      '  - A slug may appear in multiple groups (e.g. "AFT-GARAGE-HYDRAULIC active power" can be in both "Aft electrical load" and "Total electrical load on board").',
      '  - Use input slugs EXACTLY (do not invent).',
      '  - Aim to cover at least 70% of input. Skip only truly miscellaneous sensors.',
      'For each group: slug (snake_case unique, <= 60 chars), display_name (<= 60 chars human), description (1-2 sentences), category (one word: fuel|navigation|electrical|water|sewage|hvac|engine|hydraulics|safety|refrigeration|other), aggregation (sum|mean|last|max|min), unit (most representative or null), member_slugs (array of input slugs).',
      'Return JSON only: {"groups": [...]}',
    ].join('\n');

    const userPrompt = [
      `Input items: ${items.length}.`,
      'ITEMS (one per line):',
      lines.join('\n'),
    ].join('\n');

    const raw = await this.grafanaLlmService.createChatCompletion({
      model: this.clusteringModel,
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: this.maxOutputTokens,
    });

    if (!raw) {
      throw new BadRequestException(
        'LLM returned no clustering output (rate-limited or unavailable)',
      );
    }

    return this.parseLlmJsonResponse(raw);
  }

  private parseLlmJsonResponse(raw: string): LlmClusteringResponse {
    const stripped = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (error) {
      this.logger.error(
        `Failed to parse LLM clustering JSON: ${(error as Error).message}; first 200 chars: ${stripped.slice(0, 200)}`,
      );
      throw new BadRequestException(
        'LLM returned malformed JSON for clustering proposal',
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as LlmClusteringResponse).groups)
    ) {
      throw new BadRequestException(
        'LLM clustering response is missing a `groups` array',
      );
    }

    return parsed as LlmClusteringResponse;
  }

  // =================================================================
  // Shared persistence
  // =================================================================

  private async loadShipSingleConcepts(
    shipId: string,
  ): Promise<SingleConceptRecord[]> {
    const concepts = await this.metricConceptRepository.find({
      where: {
        type: MetricConceptType.SINGLE,
        isActive: true,
      },
      relations: {
        members: {
          metricCatalog: true,
        },
      },
    });

    const records: SingleConceptRecord[] = [];
    for (const concept of concepts) {
      const member = concept.members?.find(
        (entry) => entry.metricCatalog?.shipId === shipId,
      );
      if (!member?.metricCatalog) continue;
      // The catalog stores measurement inside `key` (bucket::measurement::field
      // per the bootstrap convention) — no dedicated column. The execution
      // service uses the same parse trick.
      const keyParts = (member.metricCatalog.key ?? '').split('::');
      const measurement = keyParts[1] ?? '';
      records.push({
        conceptId: concept.id,
        slug: concept.slug,
        displayName: concept.displayName,
        description: concept.description,
        metricCatalogId: member.metricCatalog.id,
        bucket: member.metricCatalog.bucket ?? '',
        measurement,
        field: member.metricCatalog.field ?? '',
      });
    }
    return records;
  }

  private async upsertCompositeGroup(
    slug: string,
    group: {
      display_name: string;
      description: string | null;
      category: string | null;
      aggregation_rule: MetricAggregationRule;
      unit: string | null;
      memberCatalogIds: string[];
    },
  ): Promise<{ created: boolean; memberCount: number }> {
    const existing = await this.metricConceptRepository.findOne({
      where: { slug },
    });

    let concept: MetricConceptEntity;
    let created = false;

    if (!existing) {
      concept = this.metricConceptRepository.create({
        slug,
        displayName: this.truncate(group.display_name, 255),
        description: this.truncate(group.description ?? null, 2000),
        category: group.category ? group.category.slice(0, 100) : null,
        type: MetricConceptType.COMPOSITE,
        aggregationRule: group.aggregation_rule,
        unit: group.unit ? group.unit.slice(0, 50) : null,
        isActive: true,
      });
      concept = await this.metricConceptRepository.save(concept);
      created = true;
    } else {
      existing.displayName = this.truncate(group.display_name, 255);
      existing.description = this.truncate(group.description ?? null, 2000);
      existing.category = group.category ? group.category.slice(0, 100) : null;
      existing.type = MetricConceptType.COMPOSITE;
      existing.aggregationRule = group.aggregation_rule;
      existing.unit = group.unit ? group.unit.slice(0, 50) : null;
      existing.isActive = true;
      concept = await this.metricConceptRepository.save(existing);
      await this.metricConceptMemberRepository.delete({
        conceptId: concept.id,
      });
    }

    const validCatalog = await this.shipMetricCatalogRepository.find({
      where: { id: In(group.memberCatalogIds) },
      select: { id: true },
    });
    const validIds = validCatalog.map((row) => row.id);

    const members = validIds.map((id, index) =>
      this.metricConceptMemberRepository.create({
        conceptId: concept.id,
        metricCatalogId: id,
        role: 'member',
        sortOrder: index,
      }),
    );
    if (members.length) {
      await this.metricConceptMemberRepository.save(members);
    }

    return { created, memberCount: members.length };
  }

  // =================================================================
  // Misc utilities
  // =================================================================

  private normalizeSlug(slug: string | null | undefined): string {
    if (!slug) return '';
    return slug
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);
  }

  private humanize(text: string): string {
    return text
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map(
        (segment) =>
          segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase(),
      )
      .join(' ');
  }

  private truncate(value: string | null, max: number): string {
    if (value === null || value === undefined) return value as unknown as string;
    return value.length <= max ? value : value.slice(0, max);
  }
}

interface LlmInputItem {
  slug: string;
  displayName: string;
  memberCount: number;
  bucket: string;
  measurement: string;
  field: string;
  catalogIds: string[];
  // Backfilled per-metric description. Critical for catching cases like
  // misnamed measurements (e.g. fuel-tank level fields living under a
  // `Temperatures` measurement) where description text says "fuel" but
  // measurement/field names don't.
  description?: string;
}
