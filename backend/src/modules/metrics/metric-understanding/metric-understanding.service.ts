import { formatError } from '../../../common/utils/error.utils';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  InfluxMetricSelector,
  InfluxService,
} from '../../../integrations/influx/influx.service';
import { LlmService } from '../../../integrations/llm/llm.service';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { AssetLifecycleStatus } from '../../assets/enums/asset-lifecycle-status.enum';
import { ShipEntity } from '../../ships/entities/ship.entity';
import {
  MetricAiKind,
  ShipMetricCatalogEntity,
} from '../entities/ship-metric-catalog.entity';
import { buildAssetShortlist } from './asset-prefilter';
import {
  AnalyzeBundle,
  ANALYZE_METRIC_SYSTEM_PROMPT,
  renderAnalyzeBundle,
  vesselHintForShip,
} from './metric-understanding.prompts';
import {
  AnalyzeOneResult,
  AnalyzeShipKickoffResult,
  AnalyzeShipOptions,
  AnalyzeShipResult,
  MetricAnalysisJson,
  MetricFingerprint,
} from './metric-understanding.types';

// Pricing for cost estimate (current as of 2026-06; the service is not the
// place to be precise about this, just give a sane ballpark for logs/UI).
const COST_PER_1M_INPUT_TOKENS_USD = 0.15;
const COST_PER_1M_OUTPUT_TOKENS_USD = 0.6;
const AVG_TOKENS_PER_METRIC = 1200;

@Injectable()
export class MetricUnderstandingService {
  private readonly logger = new Logger(MetricUnderstandingService.name);

  // Per-ship progress + lock. Prevents a second concurrent bulk run on the
  // same ship while one is still in flight.
  private readonly inFlight = new Map<string, {
    startedAt: Date;
    done: number;
    total: number;
  }>();

  constructor(
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly metricRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    private readonly influxService: InfluxService,
    private readonly llmService: LlmService,
  ) {}

  // ── Public API ───────────────────────────────────────────────────────────

  async analyzeOne(metricId: string): Promise<AnalyzeOneResult> {
    const metric = await this.metricRepository.findOne({
      where: { id: metricId },
    });
    if (!metric) {
      throw new NotFoundException(`Metric ${metricId} not found`);
    }
    return this.analyzeMetricEntity(metric);
  }

  async analyzeForShipBackground(
    shipId: string,
    opts: AnalyzeShipOptions = {},
  ): Promise<AnalyzeShipKickoffResult> {
    if (this.inFlight.has(shipId)) {
      throw new BadRequestException(
        `An analyze run is already in progress for ship ${shipId}`,
      );
    }

    const target = await this.prepareTarget(shipId, opts);

    // Fire-and-forget. Errors are logged but don't surface to the caller —
    // poll the progress endpoint for status.
    void this.runAnalyzeLoop(shipId, target, opts).catch((err) => {
      this.logger.error(
        `Background analyze for ship ${shipId} crashed: ${formatError(err)}`,
      );
      this.inFlight.delete(shipId);
    });

    return {
      shipId,
      started: true,
      totalQueued: target.length,
      message: `Analyzing ${target.length} metrics in background. Poll GET /metrics/ships/${shipId}/analyze/progress for status.`,
    };
  }

  async analyzeForShip(
    shipId: string,
    opts: AnalyzeShipOptions = {},
  ): Promise<AnalyzeShipResult> {
    if (this.inFlight.has(shipId)) {
      throw new BadRequestException(
        `An analyze run is already in progress for ship ${shipId}`,
      );
    }

    const target = await this.prepareTarget(shipId, opts);
    return this.runAnalyzeLoop(shipId, target, opts);
  }

  private async prepareTarget(
    shipId: string,
    opts: AnalyzeShipOptions,
  ): Promise<ShipMetricCatalogEntity[]> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException(`Ship ${shipId} not found`);

    const maxMetrics = Math.min(opts.maxMetrics ?? 3000, 10_000);
    const onlyMissing = opts.onlyMissing ?? true;

    const where: Record<string, unknown> = { shipId };
    if (onlyMissing) where.aiGeneratedAt = IsNull();

    const allMetrics = await this.metricRepository.find({
      where,
      take: maxMetrics,
      order: { id: 'ASC' },
    });

    // Measurement isn't its own column — it lives inside `key`, which is
    // formatted as "bucket::measurement::field". Filter in memory.
    return opts.measurement
      ? allMetrics.filter((m) => m.key.includes(`::${opts.measurement}::`))
      : allMetrics;
  }

  private async runAnalyzeLoop(
    shipId: string,
    target: ShipMetricCatalogEntity[],
    opts: AnalyzeShipOptions,
  ): Promise<AnalyzeShipResult> {
    const concurrency = Math.min(Math.max(opts.concurrency ?? 5, 1), 20);

    this.inFlight.set(shipId, {
      startedAt: new Date(),
      done: 0,
      total: target.length,
    });

    const startedAt = Date.now();
    let analyzed = 0;
    let skippedNoData = 0;
    let failedLlm = 0;
    let failedParse = 0;

    try {
      for (let i = 0; i < target.length; i += concurrency) {
        const slice = target.slice(i, i + concurrency);
        const results = await Promise.all(
          slice.map((m) =>
            this.analyzeMetricEntity(m).catch((err) => ({
              metricId: m.id,
              status: 'llm_failed' as const,
              durationMs: 0,
              errorMessage: formatError(err),
            })),
          ),
        );
        for (const r of results) {
          if (r.status === 'analyzed') analyzed++;
          else if (r.status === 'no_data') skippedNoData++;
          else if (r.status === 'parse_failed') failedParse++;
          else failedLlm++;
        }
        const inFlight = this.inFlight.get(shipId);
        if (inFlight)
          inFlight.done = analyzed + skippedNoData + failedLlm + failedParse;
      }
    } finally {
      this.inFlight.delete(shipId);
    }

    const durationMs = Date.now() - startedAt;
    const estimatedCostUsd =
      ((AVG_TOKENS_PER_METRIC * 0.75 * COST_PER_1M_INPUT_TOKENS_USD +
        AVG_TOKENS_PER_METRIC * 0.25 * COST_PER_1M_OUTPUT_TOKENS_USD) /
        1_000_000) *
      analyzed;

    return {
      shipId,
      totalConsidered: target.length,
      analyzed,
      skippedNoData,
      failedLlm,
      failedParse,
      durationMs,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    };
  }

  getProgress(shipId: string) {
    return this.inFlight.get(shipId) ?? null;
  }

  // ── Core analyzer ────────────────────────────────────────────────────────

  private async analyzeMetricEntity(
    metric: ShipMetricCatalogEntity,
  ): Promise<AnalyzeOneResult> {
    const t0 = Date.now();

    const ship = await this.shipRepository.findOne({
      where: { id: metric.shipId },
    });
    if (!ship?.organizationName?.trim()) {
      return {
        metricId: metric.id,
        status: 'llm_failed',
        durationMs: Date.now() - t0,
        errorMessage: 'Ship has no organizationName for Influx',
      };
    }

    const selector = this.parseSelectorFromKey(metric.key, metric.bucket, metric.field);
    if (!selector) {
      return {
        metricId: metric.id,
        status: 'no_data',
        durationMs: Date.now() - t0,
        errorMessage: 'Could not parse measurement from key',
      };
    }

    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    let samples: Array<{ timestamp: string; value: number }>;
    try {
      samples = await this.influxService.queryMetricSamples(
        ship.organizationName,
        selector,
        start,
        end,
        '5m',
      );
    } catch (err) {
      return {
        metricId: metric.id,
        status: 'no_data',
        durationMs: Date.now() - t0,
        errorMessage: `Influx query failed: ${formatError(err)}`,
      };
    }

    if (samples.length === 0) {
      return { metricId: metric.id, status: 'no_data', durationMs: Date.now() - t0 };
    }

    const fingerprint = this.computeFingerprint(samples);

    const assets = await this.assetRepository.find({
      where: { shipId: metric.shipId, lifecycleStatus: AssetLifecycleStatus.IN_SERVICE },
    });
    const shortlist = buildAssetShortlist(selector.measurement, selector.field, assets);

    const bundle: AnalyzeBundle = {
      metric: { name_in_influx: selector.field, measurement: selector.measurement, bucket: selector.bucket },
      context: { vessel: vesselHintForShip(ship.metricAnalysisHint) },
      assets: shortlist,
      statistical_summary_7d: fingerprint,
      recent_samples: [...samples.slice(0, 5), ...samples.slice(-5)].map((s) => ({
        t: s.timestamp,
        v: Number(s.value.toFixed(3)),
      })),
    };

    const parsed = await this.llmService.createJsonChatCompletion<MetricAnalysisJson>({
      systemPrompt: ANALYZE_METRIC_SYSTEM_PROMPT,
      userPrompt: renderAnalyzeBundle(bundle),
      // Pinned to the cheap tier regardless of LLM_MODEL: this is a bulk
      // classification task (~2000 metrics per ship). On the main model
      // (gpt-5 class) a full re-analyze costs ~$150; on 4.1-mini ~$7 with
      // near-identical binding accuracy. Low-confidence results get human
      // review in the Metrics tab anyway.
      model: 'gpt-4.1-mini',
      temperature: 0.1,
      maxTokens: 800,
    });

    if (!parsed) {
      return {
        metricId: metric.id,
        status: 'llm_failed',
        durationMs: Date.now() - t0,
        errorMessage: 'LLM returned no parseable JSON',
      };
    }

    try {
      await this.persistAnalysis(metric, parsed, fingerprint);
    } catch (err) {
      return {
        metricId: metric.id,
        status: 'parse_failed',
        durationMs: Date.now() - t0,
        errorMessage: formatError(err),
      };
    }

    return {
      metricId: metric.id,
      status: 'analyzed',
      analysis: parsed,
      fingerprint,
      durationMs: Date.now() - t0,
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private async persistAnalysis(
    metric: ShipMetricCatalogEntity,
    analysis: MetricAnalysisJson,
    fingerprint: MetricFingerprint,
  ): Promise<void> {
    let boundAssetId: string | null = null;
    if (analysis.bound_asset_id && analysis.bound_asset_id !== 'NONE') {
      const asset = await this.assetRepository.findOne({
        where: {
          shipId: metric.shipId,
          assetIdInternal: analysis.bound_asset_id,
        },
      });
      boundAssetId = asset?.id ?? null;
    }

    metric.aiDescription = analysis.description ?? null;
    metric.aiKind = (analysis.kind as MetricAiKind) ?? null;
    metric.aiUnit = analysis.unit ?? null;
    metric.aiUnitConfidence = numOrNull(analysis.unit_confidence);
    metric.boundAssetId = boundAssetId;
    metric.aiBoundConfidence = numOrNull(analysis.bound_asset_confidence);
    metric.aiTypicalP5 = numOrNull(fingerprint.p5);
    metric.aiTypicalP50 = numOrNull(fingerprint.p50);
    metric.aiTypicalP95 = numOrNull(fingerprint.p95);
    metric.aiNonZeroSharePct = numOrNull(fingerprint.non_zero_share_pct);
    metric.aiIsMonotonic = fingerprint.is_monotonic;
    metric.aiQuestionsCanAnswer = JSON.stringify(analysis.questions_can_answer ?? []);
    metric.aiWarnings = JSON.stringify(analysis.warnings ?? []);
    metric.aiReasoning = analysis.reasoning ?? null;

    // Auto-detected scale correction — never override a manual admin value.
    if (metric.scaleSource !== 'manual') {
      const detected = numOrNull(analysis.scale_factor);
      const sf =
        detected != null && Number.isFinite(detected) && detected > 0 ? detected : 1;
      metric.scaleFactor = sf;
      metric.scaleSource = sf === 1 ? 'default' : 'auto';
    }

    metric.aiGeneratedAt = new Date();
    metric.aiModel = process.env.LLM_MODEL ?? 'gpt-4o-mini';

    await this.metricRepository.save(metric);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private parseSelectorFromKey(
    key: string,
    bucketFallback: string,
    fieldFallback: string,
  ): InfluxMetricSelector | null {
    // Key format: "bucket::measurement::field". Bucket+field already live on
    // their own columns, but measurement is *only* in the key — extract it.
    const parts = key.split('::');
    if (parts.length !== 3) return null;
    const [bucket, measurement, field] = parts;
    return {
      bucket: bucketFallback || bucket,
      measurement,
      field: fieldFallback || field,
    };
  }

  private computeFingerprint(
    samples: Array<{ timestamp: string; value: number }>,
  ): MetricFingerprint {
    const values = samples.map((s) => s.value).sort((a, b) => a - b);
    const n = values.length;
    const pct = (p: number) => values[Math.min(n - 1, Math.floor((p / 100) * (n - 1)))];

    let monotonic = true;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].value < samples[i - 1].value - 0.001) {
        monotonic = false;
        break;
      }
    }
    const nonZero = values.filter((v) => Math.abs(v) > 0.001).length;

    const round = (x: number, digits = 3) =>
      Number.isFinite(x) ? Number(x.toFixed(digits)) : 0;

    return {
      count: n,
      min: round(pct(0)),
      p5: round(pct(5)),
      p50: round(pct(50)),
      p95: round(pct(95)),
      max: round(pct(100)),
      mean: round(values.reduce((a, b) => a + b, 0) / n),
      is_monotonic: monotonic,
      non_zero_share_pct: round((nonZero / n) * 100, 1),
    };
  }
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}
