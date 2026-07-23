import { formatError } from '../../../common/utils/error.utils';
import { stripDuplicateMarkdownTables } from '../../../common/utils/strip-markdown-tables.util';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository } from 'typeorm';
import {
  InfluxMetricSelector,
  InfluxService,
} from '../../../integrations/influx/influx.service';
import { LlmService } from '../../../integrations/llm/llm.service';
import { buildVesselContextString } from '../../../common/vessel-context.util';
import { RagService } from '../../../integrations/rag/rag.service';
import { WebSearchService } from '../../../integrations/web-search/web-search.service';
import { WindyClient } from '../../../integrations/windy/windy.client';
import {
  ChatMessage,
  ChatToolDefinition,
  OpenAiToolCall,
} from '../../../integrations/shared/openai-compatible-http';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { ServiceRuleEntity } from '../../assets/entities/service-rule.entity';
import { buildAssetFullLocator } from '../../assets/enums/asset-location-vocab';
import { ShipEntity } from '../../ships/entities/ship.entity';
import { PmsTaskEntity } from '../../pms/entities/pms-task.entity';
import {
  computeTaskDueHours,
  derivePmsStatus,
  effectiveDueDate,
} from '../../pms/pms-status.util';
import { ComplianceDocEntity } from '../../compliance/entities/compliance-doc.entity';
import { ComplianceDocTypeEntity } from '../../compliance/entities/compliance-doc-type.entity';
import { InventoryItemEntity } from '../../inventory/entities/inventory-item.entity';
import { InventoryItemAssetEntity } from '../../inventory/entities/inventory-item-asset.entity';
import { ShipMetricCatalogEntity } from '../entities/ship-metric-catalog.entity';
import {
  AnalyzedCatalogItem,
  AnswerQuestionResult,
  ChatChart,
  ChatChartAnnotation,
  ChatChartSeries,
  ChatChartSeriesPoint,
  ChatMap,
  ChatMapTrackPoint,
  ChatTable,
  ChatTableColumn,
  ChatKpiBlock,
  ChatKpiItem,
  OtherToolCallAudit,
  ToolCallAudit,
} from './metric-analyzer-responder.types';
import { SYSTEM_PROMPT_BASE } from './prompts/system-prompt.const';
import { vesselHintForShip } from './metric-understanding.prompts';
import { TOOL_DEFINITIONS } from './tools/tool-definitions.const';
import { haversineNm } from './utils/geo.util';
import { tokenizeForSearch } from './utils/text.util';
import { scoreAssetsByQuery } from './utils/asset-search.util';
import { parseDurationMs, parseFluxTime, parseRange } from './utils/time.util';

// Multi-step chains (e.g. lookup_asset → lookup_manual_spec → query_metric →
// forecast_metric → final answer) routinely use 4-5 iterations; we leave
// headroom for cross-domain composition without letting the LLM loop forever.
const MAX_ITERATIONS = 12;
const MAX_PARALLEL_TOOL_CALLS_PER_ROUND = 20;

interface NominatimResult {
  display_name?: string;
  address?: Record<string, string>;
  name?: string;
  type?: string;
  /** Local marker so the tool payload can flag cached hits. */
  _cached?: boolean;
}

// Per-million USD pricing per model. Used for ballpark cost reporting in
// the analyzer payload — not authoritative; refresh as OpenAI updates list
// prices. Unknown models fall back to gpt-4.1-mini pricing.
const MODEL_PRICING_USD_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-4.1':         { input: 2.0,   output: 8.0  },
  'gpt-4.1-mini':    { input: 0.15,  output: 0.6  },
  'gpt-4.1-nano':    { input: 0.10,  output: 0.4  },
  'gpt-4o':          { input: 2.5,   output: 10.0 },
  'gpt-4o-mini':     { input: 0.15,  output: 0.6  },
  'gpt-5':           { input: 1.25,  output: 10.0 },
  'gpt-5-mini':      { input: 0.25,  output: 2.0  },
  'gpt-5-nano':      { input: 0.05,  output: 0.4  },
  // Anthropic (cache write = 1.25×, cache read = 0.1× of input — applied
  // in the cost formula, not here)
  'claude-fable-5':  { input: 10.0,  output: 50.0 },
  'claude-opus-4':   { input: 5.0,   output: 25.0 },
  'claude-sonnet-4': { input: 3.0,   output: 15.0 },
  'claude-haiku-4':  { input: 1.0,   output: 5.0  },
};
const PRICING_FALLBACK = MODEL_PRICING_USD_PER_1M['gpt-4.1-mini'];

function pricingFor(model: string): { input: number; output: number } {
  // Match longest prefix in the table so dated variants (e.g.
  // "gpt-4.1-mini-2025-10") still resolve correctly.
  const m = model.trim().toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICING_USD_PER_1M)) {
    if (m.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best ? MODEL_PRICING_USD_PER_1M[best] : PRICING_FALLBACK;
}


@Injectable()
export class MetricAnalyzerResponderService {
  private readonly logger = new Logger(MetricAnalyzerResponderService.name);

  constructor(
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly metricRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ServiceRuleEntity)
    private readonly serviceRuleRepository: Repository<ServiceRuleEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(PmsTaskEntity)
    private readonly pmsTaskRepository: Repository<PmsTaskEntity>,
    @InjectRepository(ComplianceDocEntity)
    private readonly complianceDocRepository: Repository<ComplianceDocEntity>,
    @InjectRepository(ComplianceDocTypeEntity)
    private readonly complianceTypeRepository: Repository<ComplianceDocTypeEntity>,
    @InjectRepository(InventoryItemEntity)
    private readonly inventoryRepository: Repository<InventoryItemEntity>,
    @InjectRepository(InventoryItemAssetEntity)
    private readonly inventoryAssetLinkRepository: Repository<InventoryItemAssetEntity>,
    private readonly influxService: InfluxService,
    private readonly llmService: LlmService,
    private readonly ragService: RagService,
    private readonly webSearchService: WebSearchService,
    private readonly windyClient: WindyClient,
  ) {}

  async answer(
    shipId: string,
    question: string,
    opts?: {
      /** Live progress callback — receives a short human-readable line per
       * tool round (used by the chat SSE progress stream). */
      onProgress?: (text: string) => void;
      /** Live answer-text deltas. Called with `null` at each new LLM round
       * (reset signal — the previous round's text was tool-call preamble,
       * not the final answer), then with text chunks as they stream. */
      onTextDelta?: (delta: string | null) => void;
    },
  ): Promise<AnswerQuestionResult> {
    const t0 = Date.now();
    if (!question || !question.trim()) {
      throw new BadRequestException('question is required');
    }

    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException(`Ship ${shipId} not found`);
    if (!ship.organizationName?.trim()) {
      throw new BadRequestException('Ship has no organizationName for Influx');
    }

    const catalogRaw = await this.metricRepository.find({
      where: { shipId, aiGeneratedAt: Not(IsNull()) },
      relations: { boundAsset: true },
      order: { id: 'ASC' },
    });

    if (catalogRaw.length === 0) {
      throw new BadRequestException(
        'No analyzed metrics for this ship yet. Run /metrics/ships/:shipId/analyze first.',
      );
    }

    const catalog: AnalyzedCatalogItem[] = catalogRaw.map((m) => {
      const { measurement, field } = this.splitKey(m.key, m.field);
      const sf =
        typeof m.scaleFactor === 'number' && Number.isFinite(m.scaleFactor) && m.scaleFactor !== 0
          ? m.scaleFactor
          : 1;
      const scale = (v: number | null): number | null =>
        v == null ? null : v * sf;
      return {
        metricId: m.id,
        measurement,
        field,
        bucket: m.bucket,
        description: m.aiDescription,
        kind: m.aiKind,
        unit: m.aiUnit,
        boundAssetIdInternal: m.boundAsset?.assetIdInternal ?? null,
        boundAssetName: m.boundAsset?.displayName ?? null,
        // Typical percentiles are pre-scaled so the AI's context matches the
        // displayed values (raw × scaleFactor).
        typicalP5: scale(m.aiTypicalP5),
        typicalP50: scale(m.aiTypicalP50),
        typicalP95: scale(m.aiTypicalP95),
        nonZeroSharePct: m.aiNonZeroSharePct,
        isMonotonic: m.aiIsMonotonic,
        scaleFactor: sf,
      };
    });

    const catalogIndex = this.buildCatalogIndex(catalog);
    const digest = this.renderCatalogDigest(catalog);

    const tools: ChatToolDefinition[] = TOOL_DEFINITIONS;

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    // Two system messages, stable-first: the big block (prompt + catalog
    // digest) only changes when metrics are re-analyzed, so the Anthropic
    // adapter can cache it (cache_control goes on the second-to-last system
    // block — see anthropic-http.ts). The date lives in its own trailing
    // block so the midnight rollover doesn't invalidate the cached catalog.
    // The OpenAI path simply concatenates both blocks — no behavior change.
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          SYSTEM_PROMPT_BASE +
          '\n\nVESSEL PROFILE (this ship — use it for equipment, sides and naming):\n' +
          vesselHintForShip(ship.metricAnalysisHint) +
          '\n\nMETRIC CATALOG (ship: ' +
          (ship.name || ship.id) +
          '):\n' +
          digest,
      },
      {
        role: 'system',
        content:
          'CURRENT DATE (server clock, UTC): ' +
          todayIso +
          '\nWhen the user names a month or relative period without a year ' +
          '("in May", "yesterday", "last week"), interpret it relative to the ' +
          'CURRENT DATE above — never use your training-data year. ' +
          'For absolute Flux times, anchor the year to the current date.',
      },
      { role: 'user', content: question.trim() },
    ];

    const audit: ToolCallAudit[] = [];
    const otherAudit: OtherToolCallAudit[] = [];
    const charts: ChatChart[] = [];
    const maps: ChatMap[] = [];
    const tables: ChatTable[] = [];
    const kpis: ChatKpiBlock[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCacheReadTokens = 0;
    let iteration = 0;
    let finalAnswer: string | null = null;
    let hitTurnLimit = false;

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      // Retry ONLY on transient failures (rate-limit, 5xx, network).
      // Permanent failures (misconfig, 400 bad request) fail fast — retrying
      // a 400 just burns OpenAI quota for no reason.
      // Drop temperature on models that reject it with a 400:
      //   - Anthropic Opus 4.x / Sonnet 4.x ("temperature is deprecated")
      //   - Anthropic Fable / Mythos (sampling params fully removed)
      // For OpenAI gpt-5 and o-series, the HTTP client strips it itself.
      const mainModel = this.llmService.getConfiguredModel();
      const fixedTempClaude =
        /^claude-(?:opus|sonnet)-4/i.test(mainModel) ||
        /^claude-(?:fable|mythos)/i.test(mainModel);
      // Reset the streamed draft at each round: text from non-final rounds
      // is preamble narration before tool calls, not the answer.
      opts?.onTextDelta?.(null);
      const llmCallArgs = {
        messages, tools, maxTokens: 4000,
        ...(fixedTempClaude ? {} : { temperature: 0 }),
        ...(opts?.onTextDelta
          ? { onTextDelta: (d: string) => opts.onTextDelta!(d) }
          : {}),
      };
      let attempt = await this.llmService.createToolCallChatCompletionDetailed(llmCallArgs);
      let llmRetries = 0;
      // Up to 5 attempts. Default backoff is linear (3s, 6s, … 15s), but
      // when the provider sends retry-after (Anthropic 429s do — it's the
      // seconds until the rate window resets) we sleep THAT long instead:
      // linear backoff burns all 5 attempts before a 60s ITPM window
      // reopens, turning a transient throttle into a user-facing failure.
      while (!attempt.ok && attempt.transient && llmRetries < 5) {
        llmRetries += 1;
        const waitMs = attempt.retryAfterSeconds
          ? Math.min(attempt.retryAfterSeconds * 1000 + 500, 90_000)
          : 3000 * llmRetries;
        await new Promise((r) => setTimeout(r, waitMs));
        attempt = await this.llmService.createToolCallChatCompletionDetailed(llmCallArgs);
      }
      if (!attempt.ok) {
        // Permanent failure → surface the actual error class so chat composer
        // doesn't silently rephrase as "configuration is not set up".
        const trail = attempt.transient
          ? ` after ${llmRetries} retry attempts`
          : '';
        throw new BadRequestException(
          `LLM upstream failed (${attempt.kind}${attempt.status ? ` ${attempt.status}` : ''})${trail}: ${attempt.error.slice(0, 200)}`,
        );
      }
      const round = attempt.result;
      totalPromptTokens += round.promptTokens;
      totalCompletionTokens += round.completionTokens;
      totalCacheWriteTokens += round.cacheCreationInputTokens ?? 0;
      totalCacheReadTokens += round.cacheReadInputTokens ?? 0;

      if (round.toolCalls && round.toolCalls.length > 0) {
        // OpenAI protocol: the assistant message's tool_calls and the
        // subsequent tool messages must match exactly. If we cap parallelism,
        // we must ALSO cap the assistant message's tool_calls — otherwise
        // OpenAI rejects the next round with "tool_call_ids did not have
        // response messages".
        const totalRequested = round.toolCalls.length;
        const calls = round.toolCalls.slice(0, MAX_PARALLEL_TOOL_CALLS_PER_ROUND);
        const dropped = totalRequested - calls.length;
        messages.push({
          role: 'assistant',
          content: round.content,
          tool_calls: calls,
        });
        if (opts?.onProgress) {
          const labels = calls
            .map((tc) => tc.function.name.replace(/_/g, ' '))
            .join(', ');
          opts.onProgress(labels);
        }
        const results = await Promise.all(
          calls.map((tc) =>
            this.dispatchToolCall(
              tc,
              shipId,
              ship.organizationName!,
              catalogIndex,
              iteration,
            ),
          ),
        );

        for (const r of results) {
          if (r.metricCall) {
            audit.push(r.metricCall);
          } else if (r.otherCall) {
            otherAudit.push(r.otherCall);
          }
          if (r.chart) {
            charts.push(r.chart);
          }
          if (r.map) {
            maps.push(r.map);
          }
          if (r.table) {
            tables.push(r.table);
          }
          if (r.kpi) {
            kpis.push(r.kpi);
          }
          messages.push({
            role: 'tool',
            tool_call_id: r.toolCallId,
            content: JSON.stringify(r.payload),
          });
        }

        // Tell the model that some of its calls were dropped, so it does
        // not write a final answer assuming all parallel results are in.
        if (dropped > 0) {
          messages.push({
            role: 'user',
            content:
              `[system note] You requested ${totalRequested} tool calls in one round but the runtime caps parallelism at ${MAX_PARALLEL_TOOL_CALLS_PER_ROUND}. The last ${dropped} call(s) were NOT executed and have no result. ` +
              'Re-issue any remaining calls you still need in your next turn (split work into batches of ' +
              `${MAX_PARALLEL_TOOL_CALLS_PER_ROUND} or fewer).`,
          });
        }
        continue;
      }

      // No tool calls → final answer
      finalAnswer = round.content ?? '';
      break;
    }

    if (finalAnswer === null) {
      hitTurnLimit = true;
      finalAnswer =
        'Sorry, I could not gather a complete answer within the allowed number of tool calls. Try a more focused question.';
    }

    // render_table/render_kpi already display every value — but despite the
    // tool description forbidding it, the model sometimes ALSO writes a
    // markdown table restating the same data. Prompt-only steering didn't
    // reliably stop this, so strip any markdown-table block deterministically
    // whenever this turn rendered one of these presentation blocks.
    if (tables.length > 0 || kpis.length > 0) {
      finalAnswer = stripDuplicateMarkdownTables(finalAnswer);
    }

    // Anthropic prompt-cache economics: cache writes bill at 1.25× input,
    // cache reads at 0.1× input. promptTokens from the Anthropic adapter is
    // ONLY the uncached remainder — the three buckets are disjoint. For
    // OpenAI both cache counters stay 0 and the formula degrades to the
    // classic input×price.
    const pricing = pricingFor(this.llmService.getConfiguredModel());
    const cost =
      (totalPromptTokens * pricing.input +
        totalCacheWriteTokens * pricing.input * 1.25 +
        totalCacheReadTokens * pricing.input * 0.1 +
        totalCompletionTokens * pricing.output) /
      1_000_000;

    if (totalCacheReadTokens > 0 || totalCacheWriteTokens > 0) {
      this.logger.log(
        `Prompt cache: read=${totalCacheReadTokens} write=${totalCacheWriteTokens} uncached=${totalPromptTokens} (saved ≈$${(
          (totalCacheReadTokens * pricing.input * 0.9) / 1_000_000
        ).toFixed(3)})`,
      );
    }

    return {
      shipId,
      question,
      answer: finalAnswer,
      toolCalls: audit,
      otherToolCalls: otherAudit,
      charts,
      maps,
      tables,
      kpis,
      totalTokens:
        totalPromptTokens +
        totalCacheWriteTokens +
        totalCacheReadTokens +
        totalCompletionTokens,
      estimatedCostUsd: Number(cost.toFixed(5)),
      durationMs: Date.now() - t0,
      iterations: iteration,
      hitTurnLimit,
    };
  }

  // ── Tool dispatcher ──────────────────────────────────────────────────────
  private async dispatchToolCall(
    tc: OpenAiToolCall,
    shipId: string,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    metricCall?: ToolCallAudit;
    otherCall?: OtherToolCallAudit;
    chart?: ChatChart;
    map?: ChatMap;
    table?: ChatTable;
    kpi?: ChatKpiBlock;
  }> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch (err) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Bad arguments JSON: ${err instanceof Error ? err.message : 'parse error'}`,
        },
      };
    }

    try {
    switch (tc.function.name) {
      case 'query_metric':
        return await this.toolQueryMetric(tc, args, orgName, catalogIndex, iteration);
      case 'lookup_asset':
        return await this.toolLookupAsset(tc, args, shipId, iteration);
      case 'find_asset_metrics':
        return await this.toolFindAssetMetrics(tc, args, shipId, iteration);
      case 'list_assets_by_sfi':
        return await this.toolListAssetsBySfi(tc, args, shipId, iteration);
      case 'find_event':
        return await this.toolFindEvent(tc, args, orgName, catalogIndex, iteration);
      case 'find_bunker_events':
        return await this.toolFindBunkerEvents(tc, args, orgName, catalogIndex, iteration);
      case 'find_fuel_consumption_total':
        return await this.toolFindFuelConsumptionTotal(tc, args, orgName, catalogIndex, iteration);
      case 'find_consumable_consumption_total':
        return await this.toolFindConsumableConsumptionTotal(tc, args, orgName, catalogIndex, iteration);
      case 'find_metrics_by_intent':
        return await this.toolFindMetricsByIntent(tc, args, catalogIndex, iteration);
      case 'render_chart':
        return await this.toolRenderChart(tc, args, orgName, catalogIndex, iteration);
      case 'render_map':
        return await this.toolRenderMap(tc, args, orgName, catalogIndex, iteration);
      case 'render_table':
        return this.toolRenderTable(tc, args, iteration);
      case 'render_kpi':
        return this.toolRenderKpi(tc, args, iteration);
      case 'find_assets_by_function':
        return await this.toolFindAssetsByFunction(tc, args, shipId, iteration);
      case 'lookup_asset_fact':
        return await this.toolLookupAssetFact(tc, args, shipId, iteration);
      case 'aggregate_asset_facts':
        return await this.toolAggregateAssetFacts(tc, args, shipId, iteration);
      case 'compare_to_typical':
        return await this.toolCompareToTypical(tc, args, orgName, catalogIndex, iteration);
      case 'reverse_geocode':
        return await this.toolReverseGeocode(tc, args, iteration);
      case 'web_search':
        return await this.toolWebSearch(tc, args, shipId, iteration);
      case 'find_load_energy_consumed':
        return await this.toolFindLoadEnergyConsumed(tc, args, orgName, catalogIndex, iteration);
      case 'run_flux_query':
        return await this.toolRunFluxQuery(tc, args, orgName, catalogIndex, iteration);
      case 'forecast_metric':
        return await this.toolForecastMetric(tc, args, orgName, catalogIndex, iteration);
      case 'find_pms_due':
        return await this.toolFindPmsDue(tc, args, orgName, catalogIndex, shipId, iteration);
      case 'get_maintenance_tasks':
        return await this.toolGetMaintenanceTasks(tc, args, shipId, iteration);
      case 'get_compliance_status':
        return await this.toolGetComplianceStatus(tc, args, shipId, iteration);
      case 'get_inventory':
        return await this.toolGetInventory(tc, args, shipId, iteration);
      case 'compare_periods':
        return await this.toolComparePeriods(tc, args, orgName, catalogIndex, iteration);
      case 'infer_runtime_from_power':
        return await this.toolInferRuntimeFromPower(tc, args, orgName, catalogIndex, iteration);
      case 'find_voyages':
        return await this.toolFindVoyages(tc, args, orgName, catalogIndex, iteration);
      case 'compute_fuel_per_nm':
        return await this.toolComputeFuelPerNm(tc, args, orgName, catalogIndex, iteration);
      case 'compute_kw_avg_when_state':
        return await this.toolComputeKwAvgWhenState(tc, args, orgName, catalogIndex, iteration);
      case 'correlate_metrics':
        return await this.toolCorrelateMetrics(tc, args, orgName, catalogIndex, iteration);
      case 'find_unusual_periods':
        return await this.toolFindUnusualPeriods(tc, args, orgName, catalogIndex, iteration);
      case 'lookup_manual_spec':
        return await this.toolLookupManualSpec(tc, args, shipId, iteration);
      case 'find_active_alarms':
        return await this.toolFindActiveAlarms(tc, args, orgName, catalogIndex, shipId, iteration);
      case 'find_threshold_crossings':
        return await this.toolFindThresholdCrossings(tc, args, orgName, catalogIndex, iteration);
      case 'get_vessel_state':
        return await this.toolGetVesselState(tc, args, orgName, catalogIndex, iteration);
      case 'find_running_hours':
        return await this.toolFindRunningHours(tc, args, orgName, catalogIndex, shipId, iteration);
      case 'find_power_consumption_total':
        return await this.toolFindPowerConsumptionTotal(tc, args, orgName, catalogIndex, iteration);
      case 'find_assets_by_location':
        return await this.toolFindAssetsByLocation(tc, args, shipId, iteration);
      case 'get_inspection_schedule':
        return await this.toolGetInspectionSchedule(tc, args, shipId, iteration);
      case 'get_drawing_ref':
        return await this.toolGetDrawingRef(tc, args, shipId, iteration);
      case 'get_marine_forecast':
        return await this.toolGetMarineForecast(tc, args, iteration);
      case 'trace_dependencies':
        return await this.toolTraceDependencies(tc, args, shipId, iteration);
      default:
        return {
          toolCallId: tc.id,
          payload: { ok: false, error: `Unknown tool: ${tc.function.name}` },
        };
    }
    } catch (err) {
      // Any unhandled exception from a tool handler (including invalid Flux
      // time format thrown by parseFluxTime) is surfaced to the LLM as a
      // tool-level error message rather than crashing the whole turn. The
      // LLM can then retry with corrected args.
      const msg = formatError(err);
      this.logger.warn(
        `Tool ${tc.function.name} threw: ${msg}`,
      );
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: msg },
      };
    }
  }

  private async toolQueryMetric(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    metricCall: ToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '?');
    const field = String(args.field ?? '?');
    const aggregation = String(args.aggregation ?? 'last') as
      | 'mean' | 'last' | 'first' | 'min' | 'max' | 'sum' | 'delta' | 'integral';
    const range = (args.range ?? {}) as { start?: string; stop?: string };

    const audit: ToolCallAudit = {
      iteration,
      measurement,
      field,
      resolvedField: field,
      aggregation,
      rangeStart: range.start ?? '-10m',
      rangeStop: range.stop,
      value: null,
      ok: false,
      latencyMs: 0,
    };

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      audit.errorMessage = `Metric ${measurement}::${field} not in catalog (try find_metrics_by_intent to search)`;
      audit.latencyMs = Date.now() - t0;
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: audit.errorMessage },
        metricCall: audit,
      };
    }
    if (item.field !== field) {
      audit.resolvedField = item.field;
    }

    const selector: InfluxMetricSelector = {
      bucket: item.bucket,
      measurement: item.measurement,
      field: item.field,
    };

    const { start, stop } = parseRange({
      start: range.start ?? '-10m',
      stop: range.stop,
    });

    try {
      const sample = await this.influxService.queryMetricRange(
        orgName,
        selector,
        start,
        stop,
        aggregation,
      );
      const rawValue = sample?.value;
      const sf =
        typeof item.scaleFactor === 'number' && Number.isFinite(item.scaleFactor) && item.scaleFactor !== 0
          ? item.scaleFactor
          : 1;
      audit.value =
        typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? rawValue * sf
          : null;
      audit.ok = audit.value !== null;
    } catch (err) {
      audit.errorMessage = formatError(err);
    }
    audit.latencyMs = Date.now() - t0;

    return {
      toolCallId: tc.id,
      payload: {
        ok: audit.ok,
        value: audit.value,
        measurement: audit.measurement,
        field: audit.resolvedField,
        aggregation: audit.aggregation,
        range: { start: audit.rangeStart, stop: audit.rangeStop },
        unit: item.unit,
        error: audit.errorMessage,
      },
      metricCall: audit,
    };
  }

  private async toolFindEvent(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    const kindRaw = String(args.kind ?? 'step_up');
    const kind: 'step_up' | 'step_down' | 'both' =
      kindRaw === 'step_down' || kindRaw === 'both' ? kindRaw : 'step_up';
    const minDelta = typeof args.min_delta === 'number' ? args.min_delta : NaN;
    const every = typeof args.every === 'string' ? args.every : '30m';
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const limit = typeof args.limit === 'number' ? args.limit : 10;

    const callArgs = {
      measurement,
      field,
      kind,
      min_delta: minDelta,
      every,
      range: { start: range.start ?? '-7d', stop: range.stop },
      limit,
    };

    if (!measurement || !field || !Number.isFinite(minDelta)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'measurement, field and min_delta are required' },
        otherCall: {
          iteration, tool: 'find_event', args: callArgs, ok: false,
          resultSummary: 'missing required arg',
          errorMessage: 'measurement / field / min_delta required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      const err = `Metric ${measurement}::${field} not in catalog (try find_metrics_by_intent)`;
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: err },
        otherCall: {
          iteration, tool: 'find_event', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog',
          errorMessage: err,
          latencyMs: Date.now() - t0,
        },
      };
    }
    const resolvedField = item.field;

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    try {
      const events = await this.influxService.queryStepChanges(
        orgName,
        { bucket: item.bucket, measurement: item.measurement, field: item.field },
        start,
        stop,
        { every, kind, minDelta, limit },
      );
      return {
        toolCallId: tc.id,
        otherCall: {
          iteration, tool: 'find_event', args: callArgs, ok: true,
          resultSummary: `${events.length} ${kind} event(s) on ${item.measurement}::${item.field} ≥ ${minDelta}`,
          latencyMs: Date.now() - t0,
        },
        payload: {
          ok: true,
          measurement: item.measurement,
          field: resolvedField,
          unit: item.unit,
          kind,
          min_delta: minDelta,
          every,
          range: { start: range.start, stop: range.stop ?? 'now()' },
          event_count: events.length,
          events,
        },
      };
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: msg },
        otherCall: {
          iteration, tool: 'find_event', args: callArgs, ok: false,
          resultSummary: 'influx query failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }
  }

  private async toolFindBunkerEvents(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const perTankMin =
      typeof args.per_tank_min_l === 'number' ? args.per_tank_min_l : 200;
    const dayTotalMin =
      typeof args.day_total_min_l === 'number' ? args.day_total_min_l : 5000;
    const minTanks =
      typeof args.min_tanks === 'number' ? Math.floor(args.min_tanks) : 3;
    const every = typeof args.every === 'string' ? args.every : '30m';

    const callArgs = {
      range: { start: range.start ?? '-30d', stop: range.stop },
      per_tank_min_l: perTankMin,
      day_total_min_l: dayTotalMin,
      min_tanks: minTanks,
      every,
    };

    // Auto-discover fuel tank fields: any catalog entry whose field starts
    // with "Fuel_Tank" or whose ai_unit is "L"/"liters" and bound asset SFI
    // group is 2.8.* (fuel storage tanks). Stay loose so the same tool works
    // on future vessels with different naming.
    const tankSelectors: Array<{
      measurement: string;
      field: string;
      bucket: string;
      tankLabel: string;
    }> = [];
    for (const [meas, fieldMap] of catalogIndex) {
      for (const [field, item] of fieldMap) {
        const isFuelTankField = /^Fuel_Tank_/i.test(field);
        if (!isFuelTankField) continue;
        tankSelectors.push({
          measurement: meas,
          field,
          bucket: item.bucket,
          tankLabel: field,
        });
      }
    }

    if (tankSelectors.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'No Fuel_Tank_* metrics found in catalog. Cannot detect bunker events.',
        },
        otherCall: {
          iteration, tool: 'find_bunker_events', args: callArgs, ok: false,
          resultSummary: 'no fuel tanks in catalog',
          errorMessage: 'no fuel tank metrics found',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-30d',
      stop: range.stop,
    });

    let perTankEvents: Array<{
      tank: string;
      ups: Array<{ timestamp: string; delta: number }>;
      downs: Array<{ timestamp: string; delta: number }>;
    }>;
    try {
      perTankEvents = await Promise.all(
        tankSelectors.map(async (sel) => {
          const [ups, downs] = await Promise.all([
            this.influxService.queryStepChanges(
              orgName,
              { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
              start,
              stop,
              { every, kind: 'step_up', minDelta: perTankMin, limit: 50 },
            ),
            this.influxService.queryStepChanges(
              orgName,
              { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
              start,
              stop,
              { every, kind: 'step_down', minDelta: perTankMin, limit: 50 },
            ),
          ]);
          return { tank: sel.tankLabel, ups, downs };
        }),
      );
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: msg },
        otherCall: {
          iteration, tool: 'find_bunker_events', args: callArgs, ok: false,
          resultSummary: 'influx query failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Bin events by UTC calendar day. For each (day, tank) track the NET
    // change = sum(positive jumps) - sum(negative drops). Fuel polishing
    // moves fuel between tanks (one up, another down) — its net across the
    // ship sums to ~0 and won't qualify as a bunker. A true bunker is a
    // ship-wide positive net change.
    const tanksByDay = new Map<string, Map<string, { up: number; down: number }>>();
    for (const tank of perTankEvents) {
      for (const e of tank.ups) {
        const day = e.timestamp.slice(0, 10);
        let perTank = tanksByDay.get(day);
        if (!perTank) {
          perTank = new Map();
          tanksByDay.set(day, perTank);
        }
        const cur = perTank.get(tank.tank) ?? { up: 0, down: 0 };
        cur.up += e.delta;
        perTank.set(tank.tank, cur);
      }
      for (const e of tank.downs) {
        const day = e.timestamp.slice(0, 10);
        let perTank = tanksByDay.get(day);
        if (!perTank) {
          perTank = new Map();
          tanksByDay.set(day, perTank);
        }
        const cur = perTank.get(tank.tank) ?? { up: 0, down: 0 };
        // step_down deltas are negative; record their absolute value as
        // outflow.
        cur.down += Math.abs(e.delta);
        perTank.set(tank.tank, cur);
      }
    }

    const bunkers: Array<{
      day: string;
      totalLiters: number;        // ship-wide net change
      grossUpLiters: number;      // sum of up-jumps
      grossDownLiters: number;    // sum of down-jumps
      tankCount: number;          // tanks with net > 0
      perTank: Array<{ tank: string; netLiters: number; upLiters: number; downLiters: number }>;
    }> = [];
    for (const [day, perTank] of tanksByDay) {
      let grossUp = 0;
      let grossDown = 0;
      let tanksWithNetGain = 0;
      const breakdown: Array<{ tank: string; netLiters: number; upLiters: number; downLiters: number }> = [];
      for (const [tank, flow] of perTank) {
        grossUp += flow.up;
        grossDown += flow.down;
        const net = flow.up - flow.down;
        if (net > 0) tanksWithNetGain += 1;
        breakdown.push({
          tank,
          netLiters: Math.round(net),
          upLiters: Math.round(flow.up),
          downLiters: Math.round(flow.down),
        });
      }
      const netTotal = grossUp - grossDown;
      if (netTotal >= dayTotalMin && tanksWithNetGain >= minTanks) {
        bunkers.push({
          day,
          totalLiters: Math.round(netTotal),
          grossUpLiters: Math.round(grossUp),
          grossDownLiters: Math.round(grossDown),
          tankCount: tanksWithNetGain,
          perTank: breakdown.sort((a, b) => b.netLiters - a.netLiters),
        });
      }
    }
    bunkers.sort((a, b) => b.day.localeCompare(a.day)); // newest first

    const latest = bunkers[0] ?? null;
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_bunker_events', args: callArgs, ok: true,
        resultSummary: latest
          ? `latest bunker: ${latest.day} total=${latest.totalLiters}L across ${latest.tankCount} tanks (${bunkers.length} qualifying events in window)`
          : `0 qualifying bunker events (per_tank_min=${perTankMin}L, day_total_min=${dayTotalMin}L, min_tanks=${minTanks})`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        criteria: {
          per_tank_min_l: perTankMin,
          day_total_min_l: dayTotalMin,
          min_tanks: minTanks,
          every,
          range: { start: range.start, stop: range.stop ?? 'now()' },
        },
        tanks_discovered: tankSelectors.map((t) => t.tankLabel),
        event_count: bunkers.length,
        events: bunkers,
      },
    };
  }

  private async toolFindFuelConsumptionTotal(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const groupByDay = args.group_by_day === true;
    const callArgs = {
      range: { start: range.start ?? '-7d', stop: range.stop },
      group_by_day: groupByDay,
    };

    // ── Discover fuel tanks (the source) and engine counters (secondary) ──
    const tankSelectors: Array<{ measurement: string; field: string; bucket: string }> = [];
    const counterSelectors: Array<{
      measurement: string; field: string; bucket: string; engineLabel: string;
    }> = [];
    for (const [meas, fieldMap] of catalogIndex) {
      for (const [field, item] of fieldMap) {
        if (/^Fuel_Tank_/i.test(field)) {
          tankSelectors.push({ measurement: meas, field, bucket: item.bucket });
        } else if (/^Total Fuel Used/i.test(field)) {
          counterSelectors.push({
            measurement: meas, field, bucket: item.bucket, engineLabel: meas,
          });
        }
      }
    }

    if (tankSelectors.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'No Fuel_Tank_* metrics in the catalog — cannot compute tank-balance consumption.',
        },
        otherCall: {
          iteration, tool: 'find_fuel_consumption_total', args: callArgs, ok: false,
          resultSummary: 'no fuel tanks discovered',
          errorMessage: 'no fuel tanks found',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    // ── Tank balance: total = level_start - level_end + bunkered_in_window ──
    const tankLevels = await Promise.all(
      tankSelectors.map(async (sel) => {
        const sel2 = { bucket: sel.bucket, measurement: sel.measurement, field: sel.field };
        const [first, last] = await Promise.all([
          this.influxService.queryMetricRange(orgName, sel2, start, stop, 'first'),
          this.influxService.queryMetricRange(orgName, sel2, start, stop, 'last'),
        ]);
        const f = typeof first?.value === 'number' ? first.value : null;
        const l = typeof last?.value === 'number' ? last.value : null;
        return { tank: sel.field, first: f, last: l, ok: f !== null && l !== null };
      }),
    );
    const okTanks = tankLevels.filter((t) => t.ok);
    const sumFirst = okTanks.reduce((a, t) => a + (t.first as number), 0);
    const sumLast = okTanks.reduce((a, t) => a + (t.last as number), 0);

    // Bunker inflow during window (re-use bunker detection logic).
    const bunkerInflow = await this.computeBunkerInflowInWindow(
      orgName,
      tankSelectors,
      start,
      stop,
    );

    const tankBalanceLiters = Math.round((sumFirst - sumLast + bunkerInflow) * 10) / 10;

    // ── Engine-counter delta (for cross-check / breakdown) ──
    const perEngine = await Promise.all(
      counterSelectors.map(async (sel) => {
        try {
          const sample = await this.influxService.queryMetricRange(
            orgName,
            { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
            start, stop, 'delta',
          );
          const v = sample?.value;
          const num = typeof v === 'number' && Number.isFinite(v) ? v : null;
          return {
            engine: sel.engineLabel,
            measurement: sel.measurement,
            field: sel.field,
            liters: num !== null ? Math.round(num * 10) / 10 : null,
            ok: num !== null,
          };
        } catch (err) {
          return {
            engine: sel.engineLabel,
            measurement: sel.measurement,
            field: sel.field,
            liters: null,
            ok: false,
            errorMessage: formatError(err),
          };
        }
      }),
    );
    const instrumentedTotal = Math.round(
      perEngine
        .filter((e) => e.ok && e.liters !== null)
        .reduce((a, e) => a + (e.liters as number), 0) * 10,
    ) / 10;
    const uninstrumentedEstimate = Math.round((tankBalanceLiters - instrumentedTotal) * 10) / 10;

    // ── Anomaly detection — these MUST be surfaced to the user, not silently ──
    // dropped. Each anomaly carries a code, severity, what was observed, and
    // a list of possible causes so the LLM can reason about it.
    const anomalies: Array<{
      code: string;
      severity: 'high' | 'medium' | 'low' | 'info';
      observation: string;
      possible_causes: string[];
    }> = [];

    if (
      instrumentedTotal > 500 &&
      uninstrumentedEstimate < -500
    ) {
      anomalies.push({
        code: 'instrumented_exceeds_tank_balance',
        severity: 'high',
        observation:
          `Metered engine counters report ${instrumentedTotal} L burnt over the window, ` +
          `but the tank-balance method (which captures the true fuel that left the tanks) ` +
          `shows only ${tankBalanceLiters} L net consumption. The gap is ${uninstrumentedEstimate} L, ` +
          `i.e. the metered counters overcount by about ${Math.abs(uninstrumentedEstimate)} L.`,
        possible_causes: [
          'metered fuel counter reset or rolled over inside the window (delta on a reset counter is wrong).',
          'metered fuel counter is mis-calibrated (reports too much per actual liter consumed).',
          'There is a fuel-return line from a metered engine back to the tank — counter sees outbound flow but some returns, so tanks lose less than the counter shows.',
          'Bunker inflow was actually larger than the ' + Math.round(bunkerInflow) + ' L detected (e.g. multiple top-ups below the qualifying threshold, or splash/venting not captured by sensors).',
          'Tank-level sensors have calibration drift in one direction (under-reporting consumption).',
        ],
      });
    }

    if (
      bunkerInflow < 100 &&
      tankBalanceLiters < -500
    ) {
      anomalies.push({
        code: 'tanks_gained_without_bunker',
        severity: 'medium',
        observation:
          `Tanks gained ${-tankBalanceLiters} L over the window but no qualifying bunker event ` +
          `(≥5000 L across ≥3 tanks) was detected. Consumption is negative, which is physically impossible.`,
        possible_causes: [
          'A small bunker/top-up happened below the ≥5000 L / ≥3 tanks threshold — adjust find_bunker_events to look for smaller inflows.',
          'Fuel was transferred IN from a portable tote / external source (small-volume top-up).',
          'Tank-level sensor calibration shifted upward over the window (drift).',
          'Tank shape/strapping table was updated, changing the L reading without a real volume change.',
        ],
      });
    }

    if (
      Math.abs(tankBalanceLiters) < 100 &&
      instrumentedTotal < 50 &&
      bunkerInflow === 0
    ) {
      anomalies.push({
        code: 'near_zero_consumption',
        severity: 'info',
        observation:
          `Both tank balance (${tankBalanceLiters} L) and the metered counters (${instrumentedTotal} L) ` +
          `report essentially zero consumption. This is consistent with a quiet vessel state ` +
          `(no engines running, shore power, etc.). Any small non-zero figure is sensor noise.`,
        possible_causes: [
          'Vessel was on shore power / batteries; no gensets ran.',
          'Tank-level noise (each tank ±20 L sensor jitter sums up across the tanks).',
        ],
      });
    }

    if (
      bunkerInflow > 1000 &&
      tankBalanceLiters > bunkerInflow * 1.5
    ) {
      anomalies.push({
        code: 'consumption_far_exceeds_bunker',
        severity: 'low',
        observation:
          `Consumption (${tankBalanceLiters} L) is more than 1.5× the bunker inflow ` +
          `(${Math.round(bunkerInflow)} L) — a lot of stored fuel was burnt during the window.`,
        possible_causes: [
          'Long voyage / heavy use period — normal during deliveries or long-haul cruises.',
          'Bunker inflow was undercounted (see "instrumented_exceeds_tank_balance" rules).',
        ],
      });
    }

    // ── Optional per-day breakdown via daily tank-sum diff + bunker inflow ──
    let perDay: Array<{ day: string; liters: number }> | null = null;
    if (groupByDay) {
      perDay = await this.computeTankBalanceConsumptionPerDay(
        orgName, tankSelectors, start, stop,
      );
    }

    const caveat =
      'Total is computed from the tank-balance method: ' +
      'sum(fuel-tank levels at start) − sum(levels at end) + bunker inflow during the window. ' +
      'This captures ALL fuel consumers regardless of whether they have flow meters ' +
      '(all gensets, auxiliaries, boilers, and anything that drew fuel). ' +
      'The `by_instrumented_engine` breakdown only shows engines with `Total Fuel Used (l)` ' +
      'counters; the `uninstrumented_estimate` is the gap and represents ' +
      'consumption by everything else (primarily the consumers without fuel counters).';

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_fuel_consumption_total', args: callArgs, ok: okTanks.length > 0,
        resultSummary:
          `${tankBalanceLiters} L (tank-balance over ${range.start}); ` +
          `instrumented=${instrumentedTotal} L, uninstrumented≈${uninstrumentedEstimate} L; ` +
          `bunker inflow=${Math.round(bunkerInflow)} L`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: okTanks.length > 0,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        method: 'tank_balance',
        tanks_used: okTanks.length,
        sum_tank_level_start_l: Math.round(sumFirst),
        sum_tank_level_end_l: Math.round(sumLast),
        bunker_inflow_l: Math.round(bunkerInflow),
        total_liters: tankBalanceLiters,
        by_instrumented_engine: perEngine,
        instrumented_total_l: instrumentedTotal,
        uninstrumented_estimate_l: uninstrumentedEstimate,
        per_day: perDay,
        anomalies,
        caveat,
      },
    };
  }

  private async toolFindConsumableConsumptionTotal(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const VALID = ['fresh_water', 'grey_water', 'black_water'] as const;
    type ConsumableType = (typeof VALID)[number];
    const consumableTypeRaw = String(args.consumable_type ?? '').trim();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const groupByDay = args.group_by_day === true;
    const callArgs = {
      consumable_type: consumableTypeRaw,
      range: { start: range.start ?? '-30d', stop: range.stop },
      group_by_day: groupByDay,
    };

    if (consumableTypeRaw === 'fuel') {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error:
            'For fuel use `find_fuel_consumption_total` — it includes the metered engine-counter breakdown that this generic tool omits.',
        },
        otherCall: {
          iteration, tool: 'find_consumable_consumption_total', args: callArgs, ok: false,
          resultSummary: 'redirected to find_fuel_consumption_total',
          errorMessage: 'use fuel-specific tool',
          latencyMs: Date.now() - t0,
        },
      };
    }
    if (!(VALID as readonly string[]).includes(consumableTypeRaw)) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Invalid consumable_type "${consumableTypeRaw}". Allowed: ${VALID.join(', ')}.`,
        },
        otherCall: {
          iteration, tool: 'find_consumable_consumption_total', args: callArgs, ok: false,
          resultSummary: 'bad consumable_type',
          errorMessage: 'invalid type',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const consumableType = consumableTypeRaw as ConsumableType;
    const tanks = this.discoverConsumableTanks(consumableType, catalogIndex);

    if (tanks.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error:
            `No ${consumableType.replace('_', ' ')} tank-level metrics found in the catalog. ` +
            `Either this vessel does not telemeter them, or naming doesn't match the discovery patterns. ` +
            `Try \`find_metrics_by_intent\` with a custom query to locate the tanks.`,
        },
        otherCall: {
          iteration, tool: 'find_consumable_consumption_total', args: callArgs, ok: false,
          resultSummary: `no ${consumableType} tanks discovered`,
          errorMessage: 'discovery returned 0 tanks',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-30d',
      stop: range.stop,
    });

    const tankLevels = await Promise.all(
      tanks.map(async (sel) => {
        const sel2 = { bucket: sel.bucket, measurement: sel.measurement, field: sel.field };
        const [first, last] = await Promise.all([
          this.influxService.queryMetricRange(orgName, sel2, start, stop, 'first'),
          this.influxService.queryMetricRange(orgName, sel2, start, stop, 'last'),
        ]);
        const f = typeof first?.value === 'number' ? first.value : null;
        const l = typeof last?.value === 'number' ? last.value : null;
        return { tank: sel.tankLabel, first: f, last: l, ok: f !== null && l !== null };
      }),
    );
    const okTanks = tankLevels.filter((t) => t.ok);
    const sumFirst = okTanks.reduce((a, t) => a + (t.first as number), 0);
    const sumLast = okTanks.reduce((a, t) => a + (t.last as number), 0);

    // Water tanks are 1-2 orders of magnitude smaller than fuel tanks, and
    // refills/pump-offs happen more frequently in smaller increments. Lower
    // the step-event detection floor accordingly.
    const STEP_OPTS = { perTankMinL: 30, every: '30m' };

    let refillsL = 0;
    let pumpOffsL = 0;
    let totalLiters: number;
    let totalSemantic: 'consumed' | 'produced';

    if (consumableType === 'fresh_water') {
      refillsL = await this.computeInflowInWindow(
        orgName, tanks, start, stop,
        { ...STEP_OPTS, dayTotalMinL: 50, minTanks: 1 },
      );
      totalLiters = Math.round((sumFirst - sumLast + refillsL) * 10) / 10;
      totalSemantic = 'consumed';
    } else {
      pumpOffsL = await this.computePumpOffsInWindow(
        orgName, tanks, start, stop, STEP_OPTS,
      );
      totalLiters = Math.round((sumLast - sumFirst + pumpOffsL) * 10) / 10;
      totalSemantic = 'produced';
    }

    const anomalies: Array<{
      code: string;
      severity: 'high' | 'medium' | 'low' | 'info';
      observation: string;
      possible_causes: string[];
    }> = [];

    if (totalLiters < -100) {
      anomalies.push({
        code: 'negative_balance',
        severity: 'medium',
        observation:
          `Tank balance returned ${totalLiters} L of ${totalSemantic} — physically impossible (negative). ` +
          (consumableType === 'fresh_water'
            ? 'Refill events smaller than the detection threshold are likely the cause.'
            : 'Pump-off events smaller than the detection threshold are likely the cause.'),
        possible_causes: [
          'Refill / pump-off events below the 30 L/tank detection floor.',
          'Tank-level sensor drift over the window.',
          'Window boundary falls mid-event.',
        ],
      });
    }

    if (consumableType === 'fresh_water' && refillsL === 0 && (stop.getTime() - start.getTime()) > 86_400_000) {
      anomalies.push({
        code: 'no_refills_detected',
        severity: 'info',
        observation:
          'No discrete refill events detected. If the watermaker ran continuously (typical underway), it adds water as a slow trickle that does NOT register as step-ups. The reported total then UNDERSTATES true consumption.',
        possible_causes: [
          'Watermaker ran continuously — trickle production not captured.',
          'Vessel on shore-side hookup without measured refill events.',
        ],
      });
    }

    let perDay: Array<{ day: string; liters: number }> | null = null;
    if (groupByDay) {
      perDay = await this.computeTankBalanceConsumptionPerDay(
        orgName, tanks, start, stop,
      );
      if (consumableType !== 'fresh_water') {
        // Helper returns first-minus-last; for grey/black we want produced.
        perDay = perDay.map((d) => ({ day: d.day, liters: -d.liters }));
      }
    }

    const days = Math.max(1, (stop.getTime() - start.getTime()) / 86_400_000);
    const dailyAvg = Math.round((totalLiters / days) * 10) / 10;

    const caveat =
      consumableType === 'fresh_water'
        ? 'Tank balance: sum(fresh-water levels at start) − sum(at end) + detected refill inflow (step-up events ≥ 30 L per tank). Continuous watermaker trickle production is NOT detected, so the figure is a LOWER BOUND of true consumption when the watermaker ran.'
        : `Tank balance: sum(${consumableType.replace('_', ' ')} levels at end) − sum(at start) + detected pump-offs (step-down events ≥ 30 L per tank). The result represents the volume PRODUCED over the window.`;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_consumable_consumption_total', args: callArgs,
        ok: okTanks.length > 0,
        resultSummary:
          `${consumableType}: ${totalLiters} L ${totalSemantic} ` +
          `(${okTanks.length}/${tanks.length} tanks, avg ${dailyAvg} L/day)`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: okTanks.length > 0,
        consumable_type: consumableType,
        method: 'tank_balance',
        range: { start: range.start ?? '-30d', stop: range.stop ?? 'now()' },
        tanks_used: okTanks.length,
        tanks_discovered: tanks.length,
        sum_tank_level_start_l: Math.round(sumFirst),
        sum_tank_level_end_l: Math.round(sumLast),
        refills_l: Math.round(refillsL),
        pump_offs_l: Math.round(pumpOffsL),
        total_liters: totalLiters,
        total_semantic: totalSemantic,
        daily_avg_l: dailyAvg,
        days_in_window: Math.round(days * 10) / 10,
        per_day: perDay,
        anomalies,
        caveat,
      },
    };
  }

  /**
   * Find tank-level metrics for a given consumable type via heuristics on
   * measurement, field, and description text. Constrained to litre-unit
   * non-rate gauges. Returns an empty array if discovery finds nothing.
   */
  private discoverConsumableTanks(
    consumableType: 'fresh_water' | 'grey_water' | 'black_water',
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
  ): Array<{ measurement: string; field: string; bucket: string; tankLabel: string }> {
    const PATTERNS: Record<typeof consumableType, RegExp[]> = {
      fresh_water: [
        /fresh[\s_-]*water/i,
        /potable/i,
        /\bfw[\s_-]*tank\b/i,
        /\bfreshwater\b/i,
      ],
      grey_water: [
        /grey[\s_-]*water/i,
        /gray[\s_-]*water/i,
        /\bgw[\s_-]*tank\b/i,
        /\bgreywater\b/i,
        /\bgraywater\b/i,
      ],
      black_water: [
        /black[\s_-]*water/i,
        /sewage|sewer/i,
        /\bbw[\s_-]*tank\b/i,
        /\bblackwater\b/i,
      ],
    };
    const TANK_HINTS = /tank|level|volume/i;
    const isLiterUnit = (u: string | null) =>
      !!u && /^(l|liters?|litres?|литры?)$/i.test(u.trim());

    const patterns = PATTERNS[consumableType];
    const tanks: Array<{
      measurement: string; field: string; bucket: string; tankLabel: string;
    }> = [];
    for (const [meas, fieldMap] of catalogIndex) {
      for (const [field, item] of fieldMap) {
        const haystack = `${meas} ${field} ${item.description ?? ''}`;
        if (!patterns.some((p) => p.test(haystack))) continue;
        if (!isLiterUnit(item.unit)) continue;
        if (!TANK_HINTS.test(haystack)) continue;
        if (item.kind === 'rate') continue;
        tanks.push({
          measurement: meas, field, bucket: item.bucket, tankLabel: field,
        });
      }
    }
    return tanks;
  }

  /**
   * Configurable variant of `computeBunkerInflowInWindow`. Caller sets the
   * per-tank step-event floor, daily total floor, and minimum tanks. Used by
   * the generic consumable tool with much lower thresholds than fuel.
   */
  private async computeInflowInWindow(
    orgName: string,
    tankSelectors: Array<{ measurement: string; field: string; bucket: string }>,
    start: Date,
    stop: Date,
    opts: { perTankMinL: number; dayTotalMinL: number; minTanks: number; every: string },
  ): Promise<number> {
    const perTank = await Promise.all(
      tankSelectors.map(async (sel) => {
        const sel2 = { bucket: sel.bucket, measurement: sel.measurement, field: sel.field };
        const [ups, downs] = await Promise.all([
          this.influxService.queryStepChanges(orgName, sel2, start, stop, {
            every: opts.every, kind: 'step_up', minDelta: opts.perTankMinL, limit: 100,
          }),
          this.influxService.queryStepChanges(orgName, sel2, start, stop, {
            every: opts.every, kind: 'step_down', minDelta: opts.perTankMinL, limit: 100,
          }),
        ]);
        return { ups, downs };
      }),
    );
    const tanksByDay = new Map<string, Map<number, { up: number; down: number }>>();
    perTank.forEach((tank, idx) => {
      for (const e of tank.ups) {
        const day = e.timestamp.slice(0, 10);
        let m = tanksByDay.get(day);
        if (!m) { m = new Map(); tanksByDay.set(day, m); }
        const cur = m.get(idx) ?? { up: 0, down: 0 };
        cur.up += e.delta;
        m.set(idx, cur);
      }
      for (const e of tank.downs) {
        const day = e.timestamp.slice(0, 10);
        let m = tanksByDay.get(day);
        if (!m) { m = new Map(); tanksByDay.set(day, m); }
        const cur = m.get(idx) ?? { up: 0, down: 0 };
        cur.down += Math.abs(e.delta);
        m.set(idx, cur);
      }
    });
    let inflow = 0;
    for (const [, perTankFlow] of tanksByDay) {
      let dayUp = 0, dayDown = 0, tanksWithNetGain = 0;
      for (const flow of perTankFlow.values()) {
        dayUp += flow.up; dayDown += flow.down;
        if (flow.up - flow.down > 0) tanksWithNetGain += 1;
      }
      const net = dayUp - dayDown;
      if (net >= opts.dayTotalMinL && tanksWithNetGain >= opts.minTanks) inflow += net;
    }
    return inflow;
  }

  /**
   * Sum of all step-down events across the supplied tanks. Each step-down on
   * a grey/black-water tank is a pump-off (overboard or shore connection),
   * so the total represents waste flushed out — added to (end − start) to
   * recover the volume the vessel produced.
   */
  private async computePumpOffsInWindow(
    orgName: string,
    tankSelectors: Array<{ measurement: string; field: string; bucket: string }>,
    start: Date,
    stop: Date,
    opts: { perTankMinL: number; every: string },
  ): Promise<number> {
    let total = 0;
    await Promise.all(
      tankSelectors.map(async (sel) => {
        const sel2 = { bucket: sel.bucket, measurement: sel.measurement, field: sel.field };
        const downs = await this.influxService.queryStepChanges(orgName, sel2, start, stop, {
          every: opts.every, kind: 'step_down', minDelta: opts.perTankMinL, limit: 200,
        });
        for (const e of downs) total += Math.abs(e.delta);
      }),
    );
    return total;
  }

  private async computeBunkerInflowInWindow(
    orgName: string,
    tankSelectors: Array<{ measurement: string; field: string; bucket: string }>,
    start: Date,
    stop: Date,
  ): Promise<number> {
    // Sum of NET positive ship-wide changes over 24h windows above the
    // qualifying threshold. Mirrors find_bunker_events default thresholds
    // so the two stay consistent.
    const perTank = await Promise.all(
      tankSelectors.map(async (sel) => {
        const sel2 = { bucket: sel.bucket, measurement: sel.measurement, field: sel.field };
        const [ups, downs] = await Promise.all([
          this.influxService.queryStepChanges(orgName, sel2, start, stop, {
            every: '30m', kind: 'step_up', minDelta: 200, limit: 50,
          }),
          this.influxService.queryStepChanges(orgName, sel2, start, stop, {
            every: '30m', kind: 'step_down', minDelta: 200, limit: 50,
          }),
        ]);
        return { ups, downs };
      }),
    );
    const tanksByDay = new Map<string, Map<number, { up: number; down: number }>>();
    perTank.forEach((tank, idx) => {
      for (const e of tank.ups) {
        const day = e.timestamp.slice(0, 10);
        let m = tanksByDay.get(day);
        if (!m) { m = new Map(); tanksByDay.set(day, m); }
        const cur = m.get(idx) ?? { up: 0, down: 0 };
        cur.up += e.delta;
        m.set(idx, cur);
      }
      for (const e of tank.downs) {
        const day = e.timestamp.slice(0, 10);
        let m = tanksByDay.get(day);
        if (!m) { m = new Map(); tanksByDay.set(day, m); }
        const cur = m.get(idx) ?? { up: 0, down: 0 };
        cur.down += Math.abs(e.delta);
        m.set(idx, cur);
      }
    });
    let inflow = 0;
    for (const [, perTankFlow] of tanksByDay) {
      let dayUp = 0;
      let dayDown = 0;
      let tanksWithNetGain = 0;
      for (const flow of perTankFlow.values()) {
        dayUp += flow.up;
        dayDown += flow.down;
        if (flow.up - flow.down > 0) tanksWithNetGain += 1;
      }
      const net = dayUp - dayDown;
      if (net >= 5000 && tanksWithNetGain >= 3) {
        inflow += net;
      }
    }
    return inflow;
  }

  private async computeTankBalanceConsumptionPerDay(
    orgName: string,
    tankSelectors: Array<{ measurement: string; field: string; bucket: string }>,
    start: Date,
    stop: Date,
  ): Promise<Array<{ day: string; liters: number }>> {
    // Day total = sum(tanks at day-end) - sum(tanks at next-day-end) + bunker
    // inflow that day. Use 1d aggregateWindow(last) to get daily endpoints.
    const perTankDaily = await Promise.all(
      tankSelectors.map(async (sel) => {
        try {
          const samples = await this.influxService.queryMetricSamples(
            orgName,
            { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
            start, stop, '1d',
          );
          return samples;
        } catch {
          return [] as Array<{ timestamp: string; value: number }>;
        }
      }),
    );
    // Pivot to day → sum of tank levels.
    const sumByDay = new Map<string, number>();
    const countByDay = new Map<string, number>();
    for (const arr of perTankDaily) {
      for (const s of arr) {
        const d = s.timestamp.slice(0, 10);
        sumByDay.set(d, (sumByDay.get(d) ?? 0) + s.value);
        countByDay.set(d, (countByDay.get(d) ?? 0) + 1);
      }
    }
    // Only keep days where ALL tanks reported, so the diff is comparable.
    const expected = tankSelectors.length;
    const days = Array.from(sumByDay.keys())
      .filter((d) => (countByDay.get(d) ?? 0) >= expected)
      .sort();
    // Bunker inflows binned by day from existing detection.
    const bunkerByDay = await this.computeBunkerInflowByDay(orgName, tankSelectors, start, stop);
    const out: Array<{ day: string; liters: number }> = [];
    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i - 1];
      const day = days[i];
      const drop = (sumByDay.get(prevDay) ?? 0) - (sumByDay.get(day) ?? 0);
      const inflow = bunkerByDay.get(day) ?? 0;
      const burnt = drop + inflow;
      out.push({ day, liters: Math.round(burnt * 10) / 10 });
    }
    return out;
  }

  private async computeBunkerInflowByDay(
    orgName: string,
    tankSelectors: Array<{ measurement: string; field: string; bucket: string }>,
    start: Date,
    stop: Date,
  ): Promise<Map<string, number>> {
    const perTank = await Promise.all(
      tankSelectors.map(async (sel) => {
        const sel2 = { bucket: sel.bucket, measurement: sel.measurement, field: sel.field };
        const [ups, downs] = await Promise.all([
          this.influxService.queryStepChanges(orgName, sel2, start, stop, {
            every: '30m', kind: 'step_up', minDelta: 200, limit: 50,
          }),
          this.influxService.queryStepChanges(orgName, sel2, start, stop, {
            every: '30m', kind: 'step_down', minDelta: 200, limit: 50,
          }),
        ]);
        return { ups, downs };
      }),
    );
    const tanksByDay = new Map<string, Map<number, { up: number; down: number }>>();
    perTank.forEach((tank, idx) => {
      for (const e of tank.ups) {
        const day = e.timestamp.slice(0, 10);
        let m = tanksByDay.get(day);
        if (!m) { m = new Map(); tanksByDay.set(day, m); }
        const cur = m.get(idx) ?? { up: 0, down: 0 };
        cur.up += e.delta;
        m.set(idx, cur);
      }
      for (const e of tank.downs) {
        const day = e.timestamp.slice(0, 10);
        let m = tanksByDay.get(day);
        if (!m) { m = new Map(); tanksByDay.set(day, m); }
        const cur = m.get(idx) ?? { up: 0, down: 0 };
        cur.down += Math.abs(e.delta);
        m.set(idx, cur);
      }
    });
    const out = new Map<string, number>();
    for (const [day, perTankFlow] of tanksByDay) {
      let dayUp = 0;
      let dayDown = 0;
      let tanksWithNetGain = 0;
      for (const flow of perTankFlow.values()) {
        dayUp += flow.up;
        dayDown += flow.down;
        if (flow.up - flow.down > 0) tanksWithNetGain += 1;
      }
      const net = dayUp - dayDown;
      if (net >= 5000 && tanksWithNetGain >= 3) {
        out.set(day, net);
      }
    }
    return out;
  }

  // ── Batch 2: discovery + contextualization ───────────────────────────────

  private async toolFindMetricsByIntent(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const query = String(args.query ?? '').trim();
    const topN = typeof args.top_n === 'number' ? Math.max(1, Math.min(100, args.top_n)) : 20;
    const kindFilter = typeof args.kind_filter === 'string' ? args.kind_filter : 'any';
    const callArgs = { query, top_n: topN, kind_filter: kindFilter };

    if (!query) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'query is required' },
        otherCall: {
          iteration, tool: 'find_metrics_by_intent', args: callArgs, ok: false,
          resultSummary: 'empty query',
          errorMessage: 'query required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const tokens = tokenizeForSearch(query);
    if (tokens.size === 0) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'query produced no usable search tokens' },
        otherCall: {
          iteration, tool: 'find_metrics_by_intent', args: callArgs, ok: false,
          resultSummary: 'no usable tokens',
          errorMessage: 'no tokens',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const scored: Array<{ item: AnalyzedCatalogItem; score: number; matched: string[] }> = [];
    for (const [, fieldMap] of catalogIndex) {
      for (const [, item] of fieldMap) {
        if (kindFilter !== 'any' && item.kind !== kindFilter) continue;
        const haystack = [
          item.measurement,
          item.field,
          item.description ?? '',
          item.boundAssetIdInternal ?? '',
          item.boundAssetName ?? '',
        ]
          .join(' ')
          .toLowerCase();
        const haystackTokens = tokenizeForSearch(haystack);
        let score = 0;
        const matched: string[] = [];
        for (const t of tokens) {
          if (haystackTokens.has(t)) {
            score += 1;
            matched.push(t);
          }
          if (haystack.includes(t)) {
            score += 0.5;
          }
        }
        if (score > 0) scored.push({ item, score, matched });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topN);

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_metrics_by_intent', args: callArgs, ok: true,
        resultSummary: `${scored.length} match(es) total, returning top ${top.length}`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        query,
        kind_filter: kindFilter,
        total_matches: scored.length,
        results: top.map((s) => ({
          measurement: s.item.measurement,
          field: s.item.field,
          ai_kind: s.item.kind,
          ai_unit: s.item.unit,
          bound_asset_id_internal: s.item.boundAssetIdInternal,
          bound_asset_name: s.item.boundAssetName,
          typical_p5: s.item.typicalP5,
          typical_p50: s.item.typicalP50,
          typical_p95: s.item.typicalP95,
          description: s.item.description,
          match_score: Math.round(s.score * 10) / 10,
          matched_tokens: s.matched,
        })),
      },
    };
  }

  /**
   * Builds a time-series chart for the user to SEE. Resolves each requested
   * metric in the catalog, pulls down-sampled samples over the range, applies
   * each metric's scaleFactor, and returns a `chart` (accumulated out-of-band
   * and drawn client-side). The model gets only a compact per-series summary
   * back — the full point arrays never re-enter the prompt.
   */
  private async toolRenderChart(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
    chart?: ChatChart;
  }> {
    const t0 = Date.now();
    const title = String(args.title ?? '').trim() || 'Chart';
    const chartType =
      args.chart_type === 'bar'
        ? 'bar'
        : args.chart_type === 'area'
          ? 'area'
          : 'line';
    const combine = args.combine === 'sum' ? 'sum' : 'none';
    const markEvents = args.mark_events === true;
    const forecast = args.forecast === true;
    const forecastTo =
      typeof args.forecast_to === 'number' && Number.isFinite(args.forecast_to)
        ? args.forecast_to
        : null;
    const forecastLabel =
      typeof args.forecast_label === 'string' && args.forecast_label.trim()
        ? args.forecast_label.trim()
        : 'Forecast';
    const combinedLabel =
      typeof args.combined_label === 'string' && args.combined_label.trim()
        ? args.combined_label.trim()
        : null;
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const rawSeries = Array.isArray(args.series) ? args.series.slice(0, 4) : [];
    const callArgs = {
      title,
      chart_type: chartType,
      combine,
      combined_label: combinedLabel,
      mark_events: markEvents,
      forecast,
      forecast_to: forecastTo,
      range: { start: range.start ?? '-7d', stop: range.stop },
      series: rawSeries,
      every: typeof args.every === 'string' ? args.every : undefined,
    };

    const fail = (error: string) => ({
      toolCallId: tc.id,
      payload: { ok: false, error },
      otherCall: {
        iteration, tool: 'render_chart', args: callArgs, ok: false,
        resultSummary: error, errorMessage: error, latencyMs: Date.now() - t0,
      },
    });

    if (rawSeries.length === 0) {
      return fail('series is required (1–4 metrics)');
    }
    if (!range.start) {
      return fail('range.start is required, e.g. "-30d"');
    }

    let start: Date;
    let stop: Date;
    try {
      ({ start, stop } = parseRange({ start: range.start, stop: range.stop }));
    } catch (err) {
      return fail(formatError(err));
    }

    const spanMs = Math.max(1, stop.getTime() - start.getTime());
    const every = this.pickChartEvery(spanMs, callArgs.every);

    let chartSeries: ChatChart['series'] = [];
    const units = new Set<string>();
    let summaries: string[] = [];
    const notFound: string[] = [];
    // For mark_events: the single resolved metric's selector + scale, so we
    // can run step-change detection on it after the series is built.
    let eventSource:
      | { selector: InfluxMetricSelector; sf: number; unit: string | null }
      | null = null;

    for (const raw of rawSeries) {
      const s = (raw ?? {}) as { measurement?: unknown; field?: unknown; label?: unknown };
      const measurement = String(s.measurement ?? '');
      const field = String(s.field ?? '');
      const item = this.findCatalogItem(catalogIndex, measurement, field);
      if (!item) {
        notFound.push(`${measurement}::${field}`);
        continue;
      }
      const sf =
        typeof item.scaleFactor === 'number' && Number.isFinite(item.scaleFactor) && item.scaleFactor !== 0
          ? item.scaleFactor
          : 1;
      const name =
        (typeof s.label === 'string' && s.label.trim()) ||
        item.boundAssetName ||
        `${item.measurement} — ${item.field}`;
      if (item.unit) units.add(item.unit);

      const selector: InfluxMetricSelector = {
        bucket: item.bucket,
        measurement: item.measurement,
        field: item.field,
      };
      if (rawSeries.length === 1) {
        eventSource = { selector, sf, unit: item.unit };
      }

      try {
        const samples = await this.influxService.queryMetricSamples(
          orgName,
          selector,
          start,
          stop,
          every,
        );
        const points = samples.map((p) => ({ t: p.timestamp, v: p.value * sf }));
        // Typical p5–p95 range (already scaled in AnalyzedCatalogItem) rides
        // along so the client can shade a "normal range" band.
        const band =
          item.typicalP5 != null || item.typicalP95 != null
            ? { p5: item.typicalP5, p95: item.typicalP95 }
            : null;
        chartSeries.push({ name, points, band });

        if (points.length === 0) {
          summaries.push(`"${name}": no data in range`);
        } else {
          const vals = points.map((p) => p.v);
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          summaries.push(
            `"${name}": ${points.length} pts, min ${this.fmtNum(min)}, max ${this.fmtNum(max)}, avg ${this.fmtNum(avg)}, last ${this.fmtNum(vals[vals.length - 1])}${item.unit ? ' ' + item.unit : ''}`,
          );
        }
      } catch (err) {
        summaries.push(`"${name}": query failed (${formatError(err)})`);
      }
    }

    if (chartSeries.length === 0) {
      return fail(
        `none of the requested metrics resolved in the catalog${notFound.length ? ` (${notFound.join(', ')})` : ''} — use find_metrics_by_intent to get exact measurement+field`,
      );
    }

    const unit = units.size === 1 ? [...units][0] : null;

    // combine:'sum' → collapse every resolved series into ONE line by adding
    // values per aligned bucket. All series share the same range+every so the
    // aggregateWindow timestamps line up exactly; a bucket a given series is
    // missing (createEmpty:false dropped it) simply doesn't add to that
    // total. This is what "total X across all tanks" means — one summed
    // trend, not N overlaid lines (and never a single metric mislabelled as
    // the total). Only meaningful for a shared unit; if the units differ we
    // refuse to sum apples and oranges and keep the separate lines.
    if (combine === 'sum' && chartType !== 'area' && chartSeries.length > 1 && units.size <= 1) {
      const byTs = new Map<string, number>();
      for (const series of chartSeries) {
        for (const point of series.points) {
          if (point.v == null || !Number.isFinite(point.v)) continue;
          byTs.set(point.t, (byTs.get(point.t) ?? 0) + point.v);
        }
      }
      const summedPoints = [...byTs.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([t, v]) => ({ t, v }));
      const summedName =
        combinedLabel || (unit ? `Total (${unit})` : 'Total');
      const summedCount = chartSeries.length;
      // The combined "normal range" is the sum of the contributing metrics'
      // percentiles (only when every one has a band, else omit).
      const bands = chartSeries.map((s) => s.band);
      const sumBand = (pick: (b: { p5: number | null; p95: number | null }) => number | null): number | null =>
        bands.every((b) => b != null && pick(b) != null)
          ? bands.reduce((acc, b) => acc + (pick(b!) as number), 0)
          : null;
      const summedBand =
        bands.every((b) => b != null)
          ? { p5: sumBand((b) => b.p5), p95: sumBand((b) => b.p95) }
          : null;
      chartSeries = [{ name: summedName, points: summedPoints, band: summedBand }];

      if (summedPoints.length === 0) {
        summaries = [`"${summedName}": no data in range`];
      } else {
        const vals = summedPoints.map((p) => p.v);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        summaries = [
          `"${summedName}" (sum of ${summedCount} series): ${summedPoints.length} pts, min ${this.fmtNum(min)}, max ${this.fmtNum(max)}, avg ${this.fmtNum(avg)}, last ${this.fmtNum(vals[vals.length - 1])}${unit ? ' ' + unit : ''}`,
        ];
      }
    }

    // mark_events → detect significant step changes (refills = step-up, big
    // draws = step-down) on the single plotted metric and mark them on the
    // time axis. Threshold scales off the metric's own value range so it
    // adapts per metric (a 200 L jump matters on a daily tank, not on a
    // 10 000 L one). Only for a single line — meaningless across N series.
    let annotations: ChatChartAnnotation[] | undefined;
    if (markEvents && eventSource && chartSeries.length === 1) {
      annotations = await this.detectChartEvents(
        orgName,
        eventSource,
        start,
        stop,
        every,
        chartSeries[0].points,
      );
    }

    // forecast → fit a linear trend on the single plotted line and project it
    // forward as a dashed "estimate" series that extends the time axis; when a
    // target is set (forecast_to, e.g. 0 = empty) and the trend heads toward
    // it, mark the ETA date. Not for bar/area or multi-series.
    let forecastNote = '';
    if (forecast && chartType !== 'bar' && chartSeries.length === 1) {
      const fc = this.buildForecast(
        chartSeries[0].points,
        every,
        forecastTo,
        forecastLabel,
        unit,
      );
      if (fc) {
        chartSeries.push(fc.series);
        if (fc.annotation) {
          annotations = [...(annotations ?? []), fc.annotation];
        }
        forecastNote = ` [forecast: ${fc.summary}]`;
      }
    }

    const chart: ChatChart = {
      title,
      unit,
      kind: chartType,
      series: chartSeries,
      ...(annotations && annotations.length ? { annotations } : {}),
    };

    const eventNote =
      annotations && annotations.length
        ? ` [${annotations.length} marker(s): ${annotations
            .map((a) => `${a.label}@${a.t.slice(0, 10)}`)
            .join(', ')}]`
        : '';
    const resultSummary = `chart "${title}" (${every} buckets): ${summaries.join('; ')}${eventNote}${forecastNote}${
      notFound.length ? `; unresolved: ${notFound.join(', ')}` : ''
    }`;

    return {
      toolCallId: tc.id,
      chart,
      otherCall: {
        iteration, tool: 'render_chart', args: callArgs, ok: true,
        resultSummary, latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        chart_rendered: true,
        title,
        every,
        series: summaries,
        events:
          annotations && annotations.length
            ? annotations.map((a) => ({ when: a.t, change: a.label, kind: a.kind }))
            : undefined,
        note: 'The chart is now displayed to the user. Do NOT list the data points; give a one-line takeaway. If events were marked, you may reference them (e.g. a refill on <date>).',
      },
    };
  }

  /**
   * Finds significant step changes on a single metric over the chart window
   * and turns them into time-axis markers. The minimum step is derived from
   * the plotted series' own value spread (so the threshold is meaningful for
   * both a small daily tank and a large storage tank); best-effort — any
   * Influx error just yields no markers rather than failing the chart.
   */
  private async detectChartEvents(
    orgName: string,
    source: { selector: InfluxMetricSelector; sf: number; unit: string | null },
    start: Date,
    stop: Date,
    every: string,
    points: Array<{ t: string; v: number | null }>,
  ): Promise<ChatChartAnnotation[]> {
    const vals = points
      .map((p) => p.v)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (vals.length < 3) return [];
    const range = Math.max(...vals) - Math.min(...vals);
    if (!(range > 0)) return [];
    // A "significant" step is ≥30% of the observed range. minDelta is in RAW
    // units (queryStepChanges compares raw values), so divide by the scale.
    const minDeltaScaled = range * 0.3;
    const minDeltaRaw = minDeltaScaled / (source.sf || 1);

    try {
      const steps = await this.influxService.queryStepChanges(
        orgName,
        source.selector,
        start,
        stop,
        { every, kind: 'both', minDelta: minDeltaRaw, limit: 8 },
      );
      const unitSuffix = source.unit ? ` ${source.unit}` : '';
      return steps.map((s) => {
        const deltaScaled = s.delta * (source.sf || 1);
        const sign = deltaScaled > 0 ? '+' : '';
        return {
          t: s.timestamp,
          label: `${sign}${this.fmtNum(deltaScaled)}${unitSuffix}`,
          kind: deltaScaled >= 0 ? ('up' as const) : ('down' as const),
        };
      });
    } catch {
      return [];
    }
  }

  /** Flux single-unit duration ("1h", "4h", "1d") → milliseconds, or null. */
  private fluxDurationMs(d: string): number | null {
    const m = d.trim().match(/^(\d+)(s|m|h|d|w)$/);
    if (!m) return null;
    const mult: Record<string, number> = {
      s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
    };
    return parseInt(m[1], 10) * mult[m[2]];
  }

  /**
   * Fits a least-squares linear trend on the plotted (scaled) points and
   * projects it forward as a dashed "estimate" series. If a target value is
   * given (forecast_to, e.g. 0 = empty) and the trend is heading toward it,
   * the horizon runs to that ETA (capped) and an annotation marks the date;
   * otherwise it projects a modest window ahead. The forecast line starts AT
   * the last real point so it visually continues the actual line. Returns
   * null when there is too little data or the trend can't be projected.
   */
  private buildForecast(
    points: Array<{ t: string; v: number | null }>,
    every: string,
    forecastTo: number | null,
    forecastLabel: string,
    unit: string | null,
  ): {
    series: ChatChartSeries;
    annotation?: ChatChartAnnotation;
    summary: string;
  } | null {
    const pts = points
      .map((p) => ({ t: Date.parse(p.t), v: p.v }))
      .filter(
        (p): p is { t: number; v: number } =>
          Number.isFinite(p.t) && typeof p.v === 'number' && Number.isFinite(p.v),
      );
    if (pts.length < 4) return null;

    const n = pts.length;
    const meanT = pts.reduce((a, p) => a + p.t, 0) / n;
    const meanV = pts.reduce((a, p) => a + p.v, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.t - meanT) * (p.v - meanV);
      den += (p.t - meanT) ** 2;
    }
    const slope = den !== 0 ? num / den : 0; // value per ms
    const last = pts[pts.length - 1];
    const windowMs = Math.max(1, last.t - pts[0].t);
    const everyMs =
      this.fluxDurationMs(every) ??
      Math.max(60_000, Math.round(windowMs / Math.max(2, n - 1)));

    const MAX_HORIZON = 180 * 86_400_000; // 180 days
    const SLOPE_EPS = 1e-15;
    let horizonMs = Math.min(windowMs * 0.4, 90 * 86_400_000); // default look-ahead
    let etaMs: number | null = null;
    if (forecastTo != null && Math.abs(slope) > SLOPE_EPS) {
      const dtMs = (forecastTo - last.v) / slope; // ms from last point to target
      if (dtMs > 0) {
        etaMs = last.t + dtMs;
        horizonMs = Math.min(Math.max(dtMs, everyMs), MAX_HORIZON);
      }
    }
    horizonMs = Math.min(horizonMs, MAX_HORIZON);
    if (horizonMs < everyMs) return null;

    const steps = Math.min(300, Math.ceil(horizonMs / everyMs));
    const fcPoints: ChatChartSeriesPoint[] = [
      { t: new Date(last.t).toISOString(), v: last.v },
    ];
    for (let i = 1; i <= steps; i++) {
      const t = last.t + i * everyMs;
      let v = last.v + slope * (t - last.t);
      // Don't let the projection shoot past the target (a tank doesn't go
      // negative); clamp at forecast_to in the direction of travel.
      if (forecastTo != null) {
        if (slope < 0) v = Math.max(v, forecastTo);
        else if (slope > 0) v = Math.min(v, forecastTo);
      }
      fcPoints.push({ t: new Date(t).toISOString(), v });
    }

    const ratePerDay = slope * 86_400_000;
    const unitSuffix = unit ? ` ${unit}` : '';
    let annotation: ChatChartAnnotation | undefined;
    let etaText = '';
    if (etaMs != null && etaMs - last.t <= MAX_HORIZON) {
      const days = Math.round(((etaMs - last.t) / 86_400_000) * 10) / 10;
      const dateStr = new Date(etaMs).toISOString().slice(0, 10);
      annotation = {
        t: new Date(etaMs).toISOString(),
        label: `≈ ${this.fmtNum(forecastTo as number)}${unitSuffix} · ${dateStr}`,
        kind: 'event',
      };
      etaText = `reaches ${this.fmtNum(forecastTo as number)}${unitSuffix} ≈ ${dateStr} (~${days}d)`;
    }
    const summary = `rate ${this.fmtNum(ratePerDay)}${unitSuffix}/day${etaText ? '; ' + etaText : ''}`;

    return {
      series: { name: forecastLabel, points: fcPoints, dashed: true },
      annotation,
      summary,
    };
  }

  /**
   * Picks a Flux down-sample bucket for a chart so the point count stays
   * readable (~≤500). Honours a caller-supplied `every` when it is a valid
   * Flux duration that would not blow past ~2000 points.
   */
  private pickChartEvery(spanMs: number, requested: string | undefined): string {
    const ladder: Array<[string, number]> = [
      ['1m', 60_000],
      ['5m', 300_000],
      ['15m', 900_000],
      ['30m', 1_800_000],
      ['1h', 3_600_000],
      ['3h', 10_800_000],
      ['6h', 21_600_000],
      ['12h', 43_200_000],
      ['1d', 86_400_000],
      ['1w', 604_800_000],
    ];
    const single = requested?.trim().match(/^(\d+)(s|m|h|d|w)$/);
    if (single) {
      const mult: Record<string, number> = {
        s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
      };
      const ms = parseInt(single[1], 10) * mult[single[2]];
      if (ms > 0 && spanMs / ms <= 2000) return requested!.trim();
    }
    for (const [label, ms] of ladder) {
      if (spanMs / ms <= 500) return label;
    }
    return '1w';
  }

  private fmtNum(v: number): string {
    if (!Number.isFinite(v)) return 'n/a';
    const abs = Math.abs(v);
    if (abs !== 0 && abs < 0.01) return v.toExponential(2);
    return (Math.round(v * 100) / 100).toString();
  }

  /**
   * Builds a map of the vessel's GPS track over a period (+ current position)
   * for the client to draw on an interactive Windy map. Pulls
   * navigation.position lat & lon, down-samples, joins them by timestamp, and
   * returns a `map` accumulated out-of-band like charts. Weather layers are a
   * client-side Windy concern — the backend only supplies track + a default
   * layer name.
   */
  private async toolRenderMap(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
    map?: ChatMap;
  }> {
    const t0 = Date.now();
    const title = String(args.title ?? '').trim() || 'Vessel track';
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const ALLOWED_LAYERS = new Set([
      'wind', 'waves', 'currents', 'pressure', 'temp', 'rain', 'gust', 'swell',
    ]);
    const weatherLayer =
      typeof args.weather_layer === 'string' && ALLOWED_LAYERS.has(args.weather_layer)
        ? args.weather_layer
        : 'wind';
    const callArgs = {
      title,
      weather_layer: weatherLayer,
      range: { start: range.start ?? '-7d', stop: range.stop },
    };

    const fail = (error: string) => ({
      toolCallId: tc.id,
      payload: { ok: false, error },
      otherCall: {
        iteration, tool: 'render_map', args: callArgs, ok: false,
        resultSummary: error, errorMessage: error, latencyMs: Date.now() - t0,
      },
    });

    const latItem = this.findCatalogItem(catalogIndex, 'navigation.position', 'lat');
    const lonItem = this.findCatalogItem(catalogIndex, 'navigation.position', 'lon');
    const bucket = latItem?.bucket ?? lonItem?.bucket ?? 'NMEA';

    let start: Date;
    let stop: Date;
    try {
      ({ start, stop } = parseRange({ start: range.start ?? '-7d', stop: range.stop }));
    } catch (err) {
      return fail(formatError(err));
    }

    const spanMs = Math.max(1, stop.getTime() - start.getTime());
    const every = this.pickChartEvery(spanMs, undefined);

    let latSamples: Array<{ timestamp: string; value: number }>;
    let lonSamples: Array<{ timestamp: string; value: number }>;
    try {
      [latSamples, lonSamples] = await Promise.all([
        this.influxService.queryMetricSamples(
          orgName,
          { bucket, measurement: 'navigation.position', field: 'lat' },
          start, stop, every,
        ),
        this.influxService.queryMetricSamples(
          orgName,
          { bucket, measurement: 'navigation.position', field: 'lon' },
          start, stop, every,
        ),
      ]);
    } catch (err) {
      return fail(`Failed to read vessel position: ${formatError(err)}`);
    }

    const lonByTs = new Map(lonSamples.map((s) => [s.timestamp, s.value]));
    const track: ChatMapTrackPoint[] = [];
    for (const s of latSamples) {
      const lat = s.value;
      const lon = lonByTs.get(s.timestamp);
      if (
        typeof lon === 'number' &&
        Number.isFinite(lat) && Number.isFinite(lon) &&
        Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0) // drop null-island garbage fixes
      ) {
        track.push({ t: s.timestamp, lat, lon });
      }
    }
    track.sort((a, b) => a.t.localeCompare(b.t));

    if (track.length === 0) {
      return fail(
        'No GPS position fixes for this period — the vessel may not have reported navigation.position in that window.',
      );
    }

    const current = track[track.length - 1];
    const map: ChatMap = { title, track, current, weatherLayer };

    const lats = track.map((p) => p.lat);
    const lons = track.map((p) => p.lon);
    const resultSummary =
      `map "${title}": ${track.length} track pts (${every}), ` +
      `current ${this.fmtNum(current.lat)},${this.fmtNum(current.lon)}, ` +
      `bbox [${this.fmtNum(Math.min(...lats))},${this.fmtNum(Math.min(...lons))} → ` +
      `${this.fmtNum(Math.max(...lats))},${this.fmtNum(Math.max(...lons))}]`;

    return {
      toolCallId: tc.id,
      map,
      otherCall: {
        iteration, tool: 'render_map', args: callArgs, ok: true,
        resultSummary, latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        map_rendered: true,
        title,
        weather_layer: weatherLayer,
        track_points: track.length,
        current: { lat: current.lat, lon: current.lon, at: current.t },
        note: 'The map is now displayed to the user with the vessel track and weather. Do NOT paste coordinate lists; give a short takeaway (area, distance covered, current position in plain terms).',
      },
    };
  }

  /**
   * Presentation-only tool: unlike render_chart/render_map, this never
   * queries Influx itself — the model already gathered every value with its
   * other tools and just hands over rows to display as a structured,
   * sortable table instead of a hand-typed markdown table.
   */
  private toolRenderTable(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    iteration: number,
  ): {
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
    table?: ChatTable;
  } {
    const t0 = Date.now();
    const title = String(args.title ?? '').trim() || 'Table';
    const rawColumns = Array.isArray(args.columns) ? args.columns.slice(0, 8) : [];
    const rawRows = Array.isArray(args.rows) ? args.rows.slice(0, 50) : [];
    const callArgs = { title, columns: rawColumns, rows: rawRows };

    const fail = (error: string) => ({
      toolCallId: tc.id,
      payload: { ok: false, error },
      otherCall: {
        iteration, tool: 'render_table', args: callArgs, ok: false,
        resultSummary: error, errorMessage: error, latencyMs: Date.now() - t0,
      },
    });

    if (rawColumns.length === 0) {
      return fail('columns is required (1–8 columns)');
    }
    if (rawRows.length === 0) {
      return fail('rows is required (at least 1 row)');
    }

    const columns: ChatTableColumn[] = [];
    for (const raw of rawColumns) {
      const c = (raw ?? {}) as { key?: unknown; label?: unknown; align?: unknown; unit?: unknown };
      const key = String(c.key ?? '').trim();
      const label = String(c.label ?? '').trim();
      if (!key || !label) {
        return fail('each column needs a non-empty key and label');
      }
      columns.push({
        key,
        label,
        align: c.align === 'right' || c.align === 'center' ? c.align : 'left',
        unit: typeof c.unit === 'string' && c.unit.trim() ? c.unit.trim() : null,
      });
    }

    const columnKeys = new Set(columns.map((c) => c.key));
    const rows: Array<Record<string, string | number | boolean | null>> = [];
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const row: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!columnKeys.has(k)) continue;
        row[k] =
          v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? v
            : String(v);
      }
      rows.push(row);
    }
    if (rows.length === 0) {
      return fail('no valid rows — each row\'s keys must match the columns\' keys');
    }

    const table: ChatTable = { title, columns, rows };
    const resultSummary = `table "${title}": ${columns.length} columns × ${rows.length} rows`;

    return {
      toolCallId: tc.id,
      table,
      otherCall: {
        iteration, tool: 'render_table', args: callArgs, ok: true,
        resultSummary, latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        table_rendered: true,
        title,
        rows: rows.length,
        note: 'The table is now displayed to the user, sortable by column. Do NOT also write a markdown table with the same data — just a one-line takeaway.',
      },
    };
  }

  /**
   * Presentation-only tool (same nature as render_table): the model already
   * has the value(s) from its other tools; this just draws gauge/stat cards.
   */
  private toolRenderKpi(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    iteration: number,
  ): {
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
    kpi?: ChatKpiBlock;
  } {
    const t0 = Date.now();
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const rawItems = Array.isArray(args.items) ? args.items.slice(0, 6) : [];
    const callArgs = { title, items: rawItems };

    const fail = (error: string) => ({
      toolCallId: tc.id,
      payload: { ok: false, error },
      otherCall: {
        iteration, tool: 'render_kpi', args: callArgs, ok: false,
        resultSummary: error, errorMessage: error, latencyMs: Date.now() - t0,
      },
    });

    if (rawItems.length === 0) {
      return fail('items is required (1–6 KPI items)');
    }

    const items: ChatKpiItem[] = [];
    for (const raw of rawItems) {
      const it = (raw ?? {}) as Record<string, unknown>;
      const label = String(it.label ?? '').trim();
      const value =
        typeof it.value === 'number' && Number.isFinite(it.value) ? it.value : null;
      if (!label || value === null) continue;
      const format = it.format === 'number' ? 'number' : 'percent';
      const min = typeof it.min === 'number' && Number.isFinite(it.min) ? it.min : 0;
      const max =
        typeof it.max === 'number' && Number.isFinite(it.max) && it.max > min
          ? it.max
          : format === 'percent'
            ? 100
            : Math.max(min + 1, value);
      const status =
        it.status === 'ok' || it.status === 'warn' || it.status === 'critical'
          ? it.status
          : null;
      const unit = typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim() : null;
      items.push({ label, value, unit, format, min, max, status });
    }
    if (items.length === 0) {
      return fail('no valid items — each needs a label and a numeric value');
    }

    const kpi: ChatKpiBlock = { title, items };
    const resultSummary = `kpi${title ? ` "${title}"` : ''}: ${items
      .map((i) => `${i.label}=${i.value}${i.unit ?? ''}`)
      .join(', ')}`;

    return {
      toolCallId: tc.id,
      kpi,
      otherCall: {
        iteration, tool: 'render_kpi', args: callArgs, ok: true,
        resultSummary, latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        kpi_rendered: true,
        note: 'The KPI card(s) are now displayed to the user. Give one short takeaway; do not restate every number in prose.',
      },
    };
  }

  private async toolFindAssetsByFunction(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const query = String(args.query ?? '').trim();
    const topN = typeof args.top_n === 'number' ? Math.max(1, Math.min(100, args.top_n)) : 20;
    const callArgs = { query, top_n: topN };

    if (!query) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'query is required' },
        otherCall: {
          iteration, tool: 'find_assets_by_function', args: callArgs, ok: false,
          resultSummary: 'empty query',
          errorMessage: 'query required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const assets = await this.assetRepository.find({ where: { shipId } });

    const { hits: top, totalMatches } = scoreAssetsByQuery(assets, query, {
      topN, includeLocation: true,
    });

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_assets_by_function', args: callArgs, ok: true,
        resultSummary: `${totalMatches} match(es), top ${top.length}`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        query,
        total_matches: totalMatches,
        results: top.map((s) => ({
          asset_id_internal: s.asset.assetIdInternal,
          display_name: s.asset.displayName,
          sfi_group: s.asset.sfiGroup,
          sfi_sub: s.asset.sfiSub,
          sfi_sub_name: s.asset.sfiSubName,
          brand: s.asset.brand,
          model: s.asset.model,
          location: s.asset.location,
          criticality: s.asset.criticality,
          match_score: Math.round(s.score * 10) / 10,
          matched_tokens: s.matched,
        })),
      },
    };
  }

  // ── Generic asset-fact extraction (Layer "everything in notes") ───────────
  //
  // The asset register is the source of truth for static metadata: capacity,
  // rated power, warranty dates, service intervals, weight, voltage — any
  // attribute that doesn't change moment-to-moment. Rather than adding a
  // dedicated tool per attribute, lookup_asset_fact / aggregate_asset_facts
  // delegate the parsing to a cheap LLM sub-call over the asset's raw text
  // fields (brand, model, display_name, notes). One tool answers anything
  // the register can support.

  private async toolLookupAssetFact(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const assetIdInternal = String(args.asset_id_internal ?? '').trim();
    const question = String(args.question ?? '').trim();
    const callArgs = { asset_id_internal: assetIdInternal, question };

    if (!assetIdInternal || !question) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'asset_id_internal and question are both required',
        },
        otherCall: {
          iteration, tool: 'lookup_asset_fact', args: callArgs, ok: false,
          resultSummary: 'missing args',
          errorMessage: 'missing args',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const asset = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal },
    });
    if (!asset) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Asset ${assetIdInternal} not found.` },
        otherCall: {
          iteration, tool: 'lookup_asset_fact', args: callArgs, ok: false,
          resultSummary: 'asset not found',
          errorMessage: 'asset not found',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Build the asset text bundle. The cheap LLM sees ONLY this asset's
    // structured fields + free-text — nothing else from the chat / catalog.
    const assetBundle = {
      asset_id_internal: asset.assetIdInternal,
      display_name: asset.displayName,
      sfi_group: asset.sfiGroup,
      sfi_sub: asset.sfiSub,
      sfi_sub_name: asset.sfiSubName,
      brand: asset.brand,
      model: asset.model,
      serial_no: asset.serialNo,
      location: asset.location,
      criticality: asset.criticality,
      commissioned_date: asset.commissionedDate,
      rina_ref: asset.rinaRef,
      notes: asset.notes,
    };

    const systemPrompt =
      'You extract one specific fact from an asset register entry. The asset is described by structured fields plus a free-form notes field. ' +
      'Return ONLY raw JSON (no markdown, no preamble) with this exact shape:\n' +
      '{"value": "<extracted value, or null if unknown>", "unit": "<unit or null>", "source_field": "<which field the value came from: model | display_name | notes | brand | serial_no | other>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}\n' +
      'Numeric values: extract as numbers (4820 not "4820"). Capacity values: convert to LITRES if the source is m³ (×1000) or US gallons (×3.785) and set unit="L".' +
      ' If the asset record genuinely does not state the answer, return value=null, confidence≤0.2, and explain in reasoning what is missing.';

    const userPrompt =
      'Question: ' + question + '\n\nAsset record:\n' +
      JSON.stringify(assetBundle, null, 2);

    interface FactResult {
      value: number | string | null;
      unit: string | null;
      source_field: string;
      confidence: number;
      reasoning: string;
    }

    const result = await this.llmService.createJsonChatCompletion<FactResult>({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 240,
      // Sub-LLM parsing — pin to cheap OpenAI regardless of the main
      // responder's model (Claude is overkill for free-text field extraction).
      model: 'gpt-4.1-mini',
    });

    if (!result) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'LLM extraction failed — service not configured or rate-limited.',
        },
        otherCall: {
          iteration, tool: 'lookup_asset_fact', args: callArgs, ok: false,
          resultSummary: 'llm failed',
          errorMessage: 'llm failed',
          latencyMs: Date.now() - t0,
        },
      };
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'lookup_asset_fact', args: callArgs, ok: true,
        resultSummary:
          `${assetIdInternal}: ${result.value ?? 'null'}` +
          (result.unit ? ` ${result.unit}` : '') +
          ` (conf=${result.confidence})`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset_id_internal: assetIdInternal,
        display_name: asset.displayName,
        value: result.value,
        unit: result.unit,
        source_field: result.source_field,
        confidence: result.confidence,
        reasoning: result.reasoning,
      },
    };
  }

  private async toolAggregateAssetFacts(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const filter = (args.filter ?? {}) as {
      sfi_group?: string;
      sfi_sub_prefix?: string;
      keyword?: string;
      brand?: string;
    };
    const attribute = String(args.attribute ?? '').trim();
    const op = String(args.op ?? 'sum').trim();
    const callArgs = { filter, attribute, op };

    if (!attribute) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'attribute is required' },
        otherCall: {
          iteration, tool: 'aggregate_asset_facts', args: callArgs, ok: false,
          resultSummary: 'missing attribute',
          errorMessage: 'missing attribute',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const validOps = ['sum', 'avg', 'count', 'min', 'max', 'list'];
    if (!validOps.includes(op)) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Invalid op "${op}". Allowed: ${validOps.join(', ')}.`,
        },
        otherCall: {
          iteration, tool: 'aggregate_asset_facts', args: callArgs, ok: false,
          resultSummary: 'bad op',
          errorMessage: 'invalid op',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Build asset query from filter.
    const qb = this.assetRepository
      .createQueryBuilder('a')
      .where('a.ship_id = :shipId', { shipId });
    if (filter.sfi_group) {
      qb.andWhere('a.sfi_group = :sfiGroup', { sfiGroup: filter.sfi_group });
    }
    if (filter.sfi_sub_prefix) {
      qb.andWhere('a.sfi_sub LIKE :sfiPrefix', {
        sfiPrefix: `${filter.sfi_sub_prefix}%`,
      });
    }
    if (filter.brand) {
      qb.andWhere('a.brand ILIKE :brand', { brand: `%${filter.brand}%` });
    }
    if (filter.keyword) {
      const like = `%${filter.keyword}%`;
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('a.display_name ILIKE :like', { like })
            .orWhere('a.model ILIKE :like', { like })
            .orWhere('a.notes ILIKE :like', { like })
            .orWhere('a.sfi_sub_name ILIKE :like', { like }),
        ),
      );
    }
    const matched = await qb.orderBy('a.asset_id_internal', 'ASC').limit(200).getMany();

    if (matched.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'No assets matched the filter — broaden keyword or remove constraints.',
          filter,
        },
        otherCall: {
          iteration, tool: 'aggregate_asset_facts', args: callArgs, ok: false,
          resultSummary: '0 assets matched',
          errorMessage: 'no assets',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Build the bundle for the LLM — slim per-asset record so we fit many.
    const slim = matched.map((a) => ({
      asset_id_internal: a.assetIdInternal,
      display_name: a.displayName,
      brand: a.brand,
      model: a.model,
      notes: a.notes,
    }));

    const systemPrompt =
      'You aggregate one specific attribute across multiple asset register entries. ' +
      'For each asset, extract the attribute value from its model / display_name / notes / brand fields. ' +
      'Numeric capacity values: convert m³ → litres (×1000) and US gal → litres (×3.785); unit="L". ' +
      'Power values: keep in kW (or convert hp×0.7457). ' +
      'Then apply the operation (sum/avg/count/min/max/list). ' +
      'Return ONLY raw JSON (no markdown, no preamble):\n' +
      '{"op": "<op>", "attribute": "<attribute>", "unit": "<unit or null>", "result": <number or array>, "per_asset": [{"asset_id_internal":"...","value":<num or null>,"unit":"...","reasoning":"<short>"}, ...], "n_matched": <int>, "n_with_value": <int>, "notes": "<one sentence describing where you parsed values from, any gaps>"}\n' +
      'If many assets lack the attribute, set value=null on those and reflect n_with_value < n_matched in the totals.';

    const userPrompt =
      'Attribute: ' + attribute + '\nOperation: ' + op + '\n\nAssets:\n' +
      JSON.stringify(slim, null, 2);

    interface AggregateResult {
      op: string;
      attribute: string;
      unit: string | null;
      result: number | string[] | null;
      per_asset: Array<{
        asset_id_internal: string;
        value: number | string | null;
        unit?: string | null;
        reasoning?: string;
      }>;
      n_matched: number;
      n_with_value: number;
      notes: string;
    }

    const result = await this.llmService.createJsonChatCompletion<AggregateResult>({
      systemPrompt,
      userPrompt,
      temperature: 0,
      // Bigger output budget — per_asset breakdown can be long.
      maxTokens: Math.min(8000, 200 + matched.length * 80),
      // Sub-LLM parsing — pin to cheap OpenAI regardless of main model.
      model: 'gpt-4.1-mini',
    });

    if (!result) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'LLM aggregation failed — service not configured or rate-limited.',
        },
        otherCall: {
          iteration, tool: 'aggregate_asset_facts', args: callArgs, ok: false,
          resultSummary: 'llm failed',
          errorMessage: 'llm failed',
          latencyMs: Date.now() - t0,
        },
      };
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'aggregate_asset_facts', args: callArgs, ok: true,
        resultSummary:
          `${attribute} ${op} over ${matched.length} assets → ${result.result}` +
          (result.unit ? ` ${result.unit}` : '') +
          ` (${result.n_with_value}/${result.n_matched} had value)`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        ...result,
      },
    };
  }

  private async toolCompareToTypical(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    const atTimeStr = typeof args.at_time === 'string' ? args.at_time : 'now()';
    const callArgs = { measurement, field, at_time: atTimeStr };

    if (!measurement || !field) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'measurement and field are required' },
        otherCall: {
          iteration, tool: 'compare_to_typical', args: callArgs, ok: false,
          resultSummary: 'missing args',
          errorMessage: 'measurement / field required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Metric ${measurement}::${field} not in catalog (try find_metrics_by_intent)`,
        },
        otherCall: {
          iteration, tool: 'compare_to_typical', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog',
          errorMessage: 'metric not in catalog',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const resolvedField = item.field;

    const stop = parseFluxTime(atTimeStr, new Date());
    const start = new Date(stop.getTime() - 10 * 60 * 1000);

    let current: number | null = null;
    let currentTimestamp: string | null = null;
    try {
      const sample = await this.influxService.queryMetricRange(
        orgName,
        { bucket: item.bucket, measurement: item.measurement, field: item.field },
        start, stop, 'last',
      );
      if (typeof sample?.value === 'number' && Number.isFinite(sample.value)) {
        current = sample.value;
        currentTimestamp = sample.timestamp;
      }
    } catch (err) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: formatError(err) },
        otherCall: {
          iteration, tool: 'compare_to_typical', args: callArgs, ok: false,
          resultSummary: 'influx query failed',
          errorMessage: formatError(err),
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { typicalP5, typicalP50, typicalP95 } = item;
    let percentileBucket:
      | 'well_below'
      | 'below'
      | 'normal'
      | 'above'
      | 'well_above'
      | 'no_typical'
      | 'no_current';
    let interpretation: string;
    let zLike: number | null = null;
    if (current === null) {
      percentileBucket = 'no_current';
      interpretation = 'No current value available for this metric (no recent samples).';
    } else if (typicalP5 == null || typicalP50 == null || typicalP95 == null) {
      percentileBucket = 'no_typical';
      interpretation =
        'This metric has no stored typical fingerprint (p5/p50/p95 are null). Cannot compare to historical range — re-analyze the metric to populate the fingerprint.';
    } else {
      // z-like: distance from p50 normalized by half the p5-p95 spread.
      const spread = (typicalP95 - typicalP5) / 2;
      if (spread > 0) {
        zLike = Math.round(((current - typicalP50) / spread) * 100) / 100;
      }
      if (current < typicalP5) {
        percentileBucket = 'well_below';
        interpretation = `Current ${current} is below the typical p5 (${typicalP5}) for this vessel — historically observed less than 5% of the time. Investigate whether the source is operating, calibration is off, or this is a transient at startup/shutdown.`;
      } else if (current < typicalP50) {
        percentileBucket = 'below';
        interpretation = `Current ${current} is in the lower half of typical range (p5=${typicalP5} … p50=${typicalP50}).`;
      } else if (current <= typicalP95) {
        percentileBucket = 'normal';
        interpretation = `Current ${current} is within typical range (p50=${typicalP50} … p95=${typicalP95}). Nothing unusual statistically — but spec compliance still requires the manufacturer manual.`;
      } else {
        percentileBucket = 'well_above';
        interpretation = `Current ${current} is above the typical p95 (${typicalP95}) — historically exceeded less than 5% of the time. Verify whether the equipment is under heavy load (normal) or whether this is a fault/sensor anomaly.`;
      }
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'compare_to_typical', args: callArgs, ok: true,
        resultSummary: `${item.measurement}::${resolvedField} current=${current} bucket=${percentileBucket}`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        measurement: item.measurement,
        field: resolvedField,
        unit: item.unit,
        at_time: atTimeStr,
        current_value: current,
        current_timestamp: currentTimestamp,
        typical_p5: typicalP5,
        typical_p50: typicalP50,
        typical_p95: typicalP95,
        non_zero_share_pct: item.nonZeroSharePct,
        percentile_bucket: percentileBucket,
        z_like_offset: zLike,
        interpretation,
        caveat:
          'Comparison is purely STATISTICAL — against THIS vessel\'s own 7-day fingerprint at last bootstrap, ' +
          'not against the manufacturer specification. "Normal" here means "consistent with what this sensor ' +
          'historically reports", which can still be out-of-spec (e.g. a sensor stuck at a constant out-of-range ' +
          'value would read as "normal" statistically). For spec compliance, the user must consult the ' +
          'equipment manufacturer manual via the documents responder.',
      },
    };
  }

  /**
   * Builds a 1-3 sentence vessel summary used in web_search calls.
   * Delegates to the shared util so the same logic also powers
   * ShipContextService — no drift, no duplication. The reason we don't just
   * inject ShipContextService here: ShipsModule already imports MetricsModule
   * (for MetricsCatalogService), so adding metrics → ships would create a
   * NestJS circular dep. The pure util sidesteps that.
   */
  private buildVesselContextString(shipId: string): Promise<string | null> {
    return buildVesselContextString(
      this.shipRepository,
      this.assetRepository,
      shipId,
    );
  }

  // ── Batch 3 + 4: voyages, efficiency, correlations, manual bridge ─────────

  private async toolReverseGeocode(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const lat = typeof args.lat === 'number' ? args.lat : NaN;
    const lon = typeof args.lon === 'number' ? args.lon : NaN;
    const language = typeof args.language === 'string' ? args.language : 'en';
    const callArgs = { lat, lon, language };

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'lat and lon are required numbers' },
        otherCall: {
          iteration, tool: 'reverse_geocode', args: callArgs, ok: false,
          resultSummary: 'bad coords',
          errorMessage: 'lat / lon must be numbers',
          latencyMs: Date.now() - t0,
        },
      };
    }

    try {
      const data = await this.nominatimReverseLookup(lat, lon, language);
      const display = data.display_name ?? null;
      const addr = data.address ?? {};
      const country = addr.country ?? null;
      const region = addr.state ?? addr.region ?? null;
      const city = addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? null;
      const sea = addr.sea ?? addr.ocean ?? null;
      // Nominatim returns minimal data offshore. If display_name is null
      // OR there's no country and no sea, mark as offshore and recommend web_search.
      const isOffshoreEmpty = !display && !country && !sea;

      return {
        toolCallId: tc.id,
        otherCall: {
          iteration, tool: 'reverse_geocode', args: callArgs, ok: true,
          resultSummary: isOffshoreEmpty
            ? `(${lat}, ${lon}) → offshore, Nominatim returned no land match. Try web_search with the coordinates.`
            : display ?? `${city ?? region ?? country ?? sea ?? '?'}`,
          latencyMs: Date.now() - t0,
        },
        payload: {
          ok: true,
          lat, lon,
          display_name: display,
          country, region, city, sea,
          is_offshore: isOffshoreEmpty,
          source: 'OpenStreetMap Nominatim',
          cached: data._cached === true ? true : undefined,
          tip:
            isOffshoreEmpty
              ? 'Nominatim has no nearby landmark; for offshore positions call web_search with the lat/lon to identify the sea / approach zone.'
              : 'For nautical context (nearest port, anchorage), also consider web_search with the place name + "harbour" / "port".',
        },
      };
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Nominatim lookup failed: ${msg}. Fall back to web_search with the lat/lon literal.`,
        },
        otherCall: {
          iteration, tool: 'reverse_geocode', args: callArgs, ok: false,
          resultSummary: `nominatim failed: ${msg}`,
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }
  }

  // ── Nominatim cache + rate-limit ──────────────────────────────────────────
  // Nominatim's policy is ≤ 1 req/sec per identifying source. The LLM can
  // batch 20 reverse_geocode calls in one round (one per voyage endpoint),
  // which would get throttled and return 429. We serialize calls with a
  // 1.1s gap and cache by rounded (lat, lon, language) so a voyage trail
  // with shared endpoints reuses results.

  private readonly nominatimCache = new Map<string, Promise<NominatimResult>>();
  private nominatimQueue: Promise<unknown> = Promise.resolve();
  private nominatimLastCallAt = 0;
  private static readonly NOMINATIM_MIN_INTERVAL_MS = 1100;
  private static readonly NOMINATIM_CACHE_MAX = 1000;

  private async nominatimReverseLookup(
    lat: number,
    lon: number,
    language: string,
  ): Promise<NominatimResult> {
    // 4 decimal places ≈ 10m on the surface — fine for "nearest harbour" use.
    const key = `${lat.toFixed(4)}|${lon.toFixed(4)}|${language}`;
    const existing = this.nominatimCache.get(key);
    if (existing) {
      // Mark the resolved value as cached for telemetry; if the in-flight
      // promise hasn't resolved yet, the caller still benefits from sharing.
      return existing.then((r) => ({ ...r, _cached: true }));
    }

    // Soft cap: when we hit the limit, drop the oldest 10%. Simple FIFO.
    if (this.nominatimCache.size >= MetricAnalyzerResponderService.NOMINATIM_CACHE_MAX) {
      const dropCount = Math.floor(
        MetricAnalyzerResponderService.NOMINATIM_CACHE_MAX / 10,
      );
      const keys = Array.from(this.nominatimCache.keys()).slice(0, dropCount);
      for (const k of keys) this.nominatimCache.delete(k);
    }

    const promise = (async () => {
      // Queue serially so we never burst above 1 req/sec.
      const previous = this.nominatimQueue;
      let release!: () => void;
      this.nominatimQueue = new Promise<void>((r) => { release = r; });
      try {
        await previous;
        const sinceLast = Date.now() - this.nominatimLastCallAt;
        if (sinceLast < MetricAnalyzerResponderService.NOMINATIM_MIN_INTERVAL_MS) {
          await new Promise((r) =>
            setTimeout(
              r,
              MetricAnalyzerResponderService.NOMINATIM_MIN_INTERVAL_MS - sinceLast,
            ),
          );
        }
        const url =
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
          `&lat=${encodeURIComponent(lat.toString())}` +
          `&lon=${encodeURIComponent(lon.toString())}` +
          `&zoom=10&accept-language=${encodeURIComponent(language)}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'trident-virtual-ai/1.0 (yacht-management)',
            Accept: 'application/json',
          },
        });
        this.nominatimLastCallAt = Date.now();
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as NominatimResult;
        return body;
      } finally {
        release();
      }
    })();

    this.nominatimCache.set(key, promise);
    // Evict cache entry on rejection so we don't pin a failed result forever.
    promise.catch(() => this.nominatimCache.delete(key));
    return promise;
  }

  private async toolWebSearch(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const query = String(args.query ?? '').trim();
    const locale = typeof args.locale === 'string' ? args.locale : undefined;
    const callArgs = { query, locale };

    if (!query) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'query is required' },
        otherCall: {
          iteration, tool: 'web_search', args: callArgs, ok: false,
          resultSummary: 'empty query',
          errorMessage: 'query required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const vesselContext = (await this.buildVesselContextString(shipId)) ?? undefined;
    try {
      const res = await this.webSearchService.search({
        question: query,
        locale,
        vesselContext,
      });
      const sources = (res.contextReferences ?? []).map((c) => ({
        title: c.sourceTitle ?? null,
        url: c.sourceUrl ?? null,
        snippet: c.snippet ?? null,
      }));
      return {
        toolCallId: tc.id,
        otherCall: {
          iteration, tool: 'web_search', args: callArgs, ok: true,
          resultSummary: `${sources.length} source(s) returned for "${query.slice(0, 50)}"`,
          latencyMs: Date.now() - t0,
        },
        payload: {
          ok: true,
          query,
          answer: res.answer,
          sources,
          provider: res.provider,
          model: res.model,
          caveat:
            'This is public-web information, NOT from the vessel\'s onboard manual or PMS. ' +
            'Always cite the source URL and tell the user this is general guidance, not their specific equipment instructions.',
        },
      };
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `web search failed: ${msg}` },
        otherCall: {
          iteration, tool: 'web_search', args: callArgs, ok: false,
          resultSummary: 'web search failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }
  }

  // ── Escape-hatch / generic tools ──────────────────────────────────────────

  private async toolRunFluxQuery(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const flux = String(args.flux ?? '').trim();
    const maxRows =
      typeof args.max_rows === 'number'
        ? Math.max(1, Math.min(500, args.max_rows))
        : 200;
    // Audit log keeps the FULL query — never truncate the query we executed.
    const callArgs = { flux, max_rows: maxRows };

    if (!flux) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'flux is required' },
        otherCall: {
          iteration, tool: 'run_flux_query', args: callArgs, ok: false,
          resultSummary: 'empty flux',
          errorMessage: 'flux required',
          latencyMs: Date.now() - t0,
        },
      };
    }
    if (!/\|>\s*range\s*\(/i.test(flux)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'Flux must include a |> range(...) for safety.' },
        otherCall: {
          iteration, tool: 'run_flux_query', args: callArgs, ok: false,
          resultSummary: 'no range() in flux',
          errorMessage: 'missing range',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // ── Safety guards ──
    // 1. Forbid any write / network / experimental ops. The Influx token may
    //    have write scope (Tasks, Cloud) — protect against an LLM-generated
    //    query trying to use those.
    const forbiddenPatterns: Array<{ pattern: RegExp; name: string }> = [
      { pattern: /\bto\s*\(/i, name: 'to()' },
      { pattern: /\bto_bucket\s*\(/i, name: 'toBucket()' },
      { pattern: /\bhttp\s*\.\s*post\b/i, name: 'http.post' },
      { pattern: /\bhttp\s*\.\s*get\b/i, name: 'http.get' },
      { pattern: /\bexperimental\s*\./i, name: 'experimental.*' },
      { pattern: /\bdelete\s*\(/i, name: 'delete()' },
      { pattern: /\bbuckets\s*\.\s*createBucket\b/i, name: 'buckets.createBucket' },
      { pattern: /\bsql\s*\./i, name: 'sql.*' },
    ];
    for (const { pattern, name } of forbiddenPatterns) {
      if (pattern.test(flux)) {
        return {
          toolCallId: tc.id,
          payload: {
            ok: false,
            error: `Flux operation ${name} is not allowed via run_flux_query (read-only sandbox).`,
          },
          otherCall: {
            iteration, tool: 'run_flux_query', args: callArgs, ok: false,
            resultSummary: `forbidden op ${name}`,
            errorMessage: `forbidden op ${name}`,
            latencyMs: Date.now() - t0,
          },
        };
      }
    }
    // 2. Pin the bucket. The Flux must reference a bucket that belongs to
    //    this ship's catalog (so the LLM can't roam across other vessels
    //    that share the org token).
    const allowedBuckets = new Set<string>();
    for (const fieldMap of catalogIndex.values()) {
      for (const item of fieldMap.values()) allowedBuckets.add(item.bucket);
    }
    const bucketMatches = [
      ...flux.matchAll(/\bfrom\s*\(\s*bucket\s*:\s*["']([^"']+)["']/gi),
    ];
    if (bucketMatches.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'Flux must include `from(bucket: "<name>")` with one of: ' +
            Array.from(allowedBuckets).map((b) => `"${b}"`).join(', '),
        },
        otherCall: {
          iteration, tool: 'run_flux_query', args: callArgs, ok: false,
          resultSummary: 'no from(bucket:...)',
          errorMessage: 'missing from(bucket)',
          latencyMs: Date.now() - t0,
        },
      };
    }
    for (const m of bucketMatches) {
      if (!allowedBuckets.has(m[1])) {
        return {
          toolCallId: tc.id,
          payload: {
            ok: false,
            error: `Bucket "${m[1]}" is not in this ship's catalog. Allowed: ${Array.from(allowedBuckets).map((b) => `"${b}"`).join(', ')}`,
          },
          otherCall: {
            iteration, tool: 'run_flux_query', args: callArgs, ok: false,
            resultSummary: `bucket "${m[1]}" not allowed`,
            errorMessage: `bucket ${m[1]} not allowed`,
            latencyMs: Date.now() - t0,
          },
        };
      }
    }

    try {
      const { rows, truncated } = await this.influxService.queryRawFlux(
        orgName, flux, maxRows,
      );
      return {
        toolCallId: tc.id,
        otherCall: {
          iteration, tool: 'run_flux_query', args: callArgs, ok: true,
          resultSummary: `${rows.length} rows${truncated ? ` (truncated to ${maxRows})` : ''}`,
          latencyMs: Date.now() - t0,
        },
        payload: {
          ok: true,
          row_count: rows.length,
          truncated,
          rows,
          schema_note:
            'Influx Flux rows expose `_time` (ISO timestamp), `_value` (the numeric reading), `_measurement`, `_field`, plus any tags grouped by the pipeline. ' +
            'For aggregated outputs (mean/sum/last), `_value` is the aggregate and `_time` is the window end. ' +
            'For non-aggregated streams, every row is a distinct sample.',
          note: truncated
            ? `Result was truncated at ${maxRows} rows. Refine the Flux query (filter/aggregate) for a complete view.`
            : null,
        },
      };
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Flux query failed: ${msg}` },
        otherCall: {
          iteration, tool: 'run_flux_query', args: callArgs, ok: false,
          resultSummary: `flux error: ${msg.slice(0, 80)}`,
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }
  }

  private async toolForecastMetric(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    const target = typeof args.target_value === 'number' ? args.target_value : NaN;
    const lookback = typeof args.lookback === 'string' ? args.lookback : '-30d';
    const callArgs = { measurement, field, target_value: target, lookback };

    if (!measurement || !field || !Number.isFinite(target)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'measurement, field, target_value required' },
        otherCall: {
          iteration, tool: 'forecast_metric', args: callArgs, ok: false,
          resultSummary: 'missing args', errorMessage: 'missing args',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'metric not in catalog' },
        otherCall: {
          iteration, tool: 'forecast_metric', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog', errorMessage: 'not in catalog',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const now = new Date();
    const start = parseFluxTime(lookback, now);
    // Pick a sample interval that yields ~20-60 points across the lookback
    // window. Hard-coded '1d' gave 3-7 samples on short lookbacks → noisy fit.
    const windowMs = now.getTime() - start.getTime();
    const windowH = windowMs / (60 * 60 * 1000);
    let every: string;
    if (windowH <= 48) every = '15m';        // ≤ 2 days: fine resolution
    else if (windowH <= 24 * 14) every = '1h';   // ≤ 2 weeks: hourly
    else if (windowH <= 24 * 90) every = '6h';   // ≤ 3 months: 6-hour
    else if (windowH <= 24 * 365) every = '1d';  // ≤ 1 year: daily
    else every = '1w';                            // beyond: weekly
    const samples = await this.influxService.queryMetricSamples(
      orgName,
      { bucket: item.bucket, measurement: item.measurement, field: item.field },
      start, now, every,
    );

    if (samples.length < 3) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Not enough samples (${samples.length}) to forecast — widen lookback.`,
        },
        otherCall: {
          iteration, tool: 'forecast_metric', args: callArgs, ok: false,
          resultSummary: 'too few samples', errorMessage: 'insufficient data',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Linear regression on (timestamp_ms, value) to find slope per ms.
    const pts = samples.map((s) => ({ t: new Date(s.timestamp).getTime(), v: s.value }));
    const n = pts.length;
    const meanT = pts.reduce((a, p) => a + p.t, 0) / n;
    const meanV = pts.reduce((a, p) => a + p.v, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.t - meanT) * (p.v - meanV);
      den += (p.t - meanT) ** 2;
    }
    const slopePerMs = den !== 0 ? num / den : 0;
    const ratePerDay = Math.round(slopePerMs * 86400_000 * 100) / 100;
    const latest = pts[pts.length - 1];

    let predictedTimestamp: string | null = null;
    let daysFromNow: number | null = null;
    let interpretation: string;
    // Treat anything below 1e-15 / ms as "essentially flat" — protects against
    // float underflow producing year-7000 timestamps.
    const SLOPE_EPSILON = 1e-15;
    const MAX_PROJECTION_DAYS = 100_000; // ~273 years
    if (Math.abs(slopePerMs) < SLOPE_EPSILON) {
      interpretation = `Metric is flat over the lookback window (slope ≈ 0); cannot project to ${target}.`;
    } else {
      const dtMs = (target - latest.v) / slopePerMs;
      const target_t = latest.t + dtMs;
      const projectedDays = (target_t - now.getTime()) / 86400_000;
      if (
        !Number.isFinite(target_t) ||
        Math.abs(projectedDays) > MAX_PROJECTION_DAYS
      ) {
        interpretation =
          `Projection is implausibly far (>${MAX_PROJECTION_DAYS} days) — the recent trend is too weak to forecast against ${target} reliably. Widen lookback or check if the rate is truly non-zero.`;
      } else {
        predictedTimestamp = new Date(target_t).toISOString();
        daysFromNow = Math.round(projectedDays * 10) / 10;
        if (daysFromNow < 0) {
          interpretation = `Linear projection would place target_value=${target} in the PAST (${Math.abs(daysFromNow)} days ago) — either the trend has reversed or the metric is already past the target.`;
        } else {
          interpretation = `At the current rate of ${ratePerDay}/day, the metric will reach ${target} in ~${daysFromNow} days (around ${predictedTimestamp.slice(0, 10)}). Linear extrapolation only — assumes the rate stays constant.`;
        }
      }
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'forecast_metric', args: callArgs, ok: true,
        resultSummary: `latest=${latest.v}, rate=${ratePerDay}/d, target=${target}` +
          (predictedTimestamp && daysFromNow !== null
            ? `, ETA in ${daysFromNow}d`
            : ''),
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        measurement: item.measurement,
        field: item.field,
        unit: item.unit,
        target_value: target,
        latest_value: latest.v,
        latest_timestamp: new Date(latest.t).toISOString(),
        rate_per_day: ratePerDay,
        predicted_timestamp: predictedTimestamp,
        days_from_now: daysFromNow,
        n_samples_used: n,
        lookback,
        sample_interval: every,
        interpretation,
        caveat:
          'Linear projection only. Rate fluctuations, seasonal patterns, and operational changes (e.g. moving to shore power) make the actual arrival highly uncertain. Use as rough guidance, verify before scheduling work.',
      },
    };
  }

  private async toolFindPmsDue(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const assetIdInternal =
      typeof args.asset_id_internal === 'string' ? args.asset_id_internal : null;
    const assetQuery =
      typeof args.asset_query === 'string' ? args.asset_query.trim() : null;
    const allWithRules = args.all_with_rules === true;
    const callArgs = {
      asset_id_internal: assetIdInternal,
      asset_query: assetQuery,
      all_with_rules: allWithRules,
    };

    if (!assetIdInternal && !assetQuery && !allWithRules) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error:
            'asset_id_internal, asset_query, or all_with_rules=true required',
        },
        otherCall: {
          iteration, tool: 'find_pms_due', args: callArgs, ok: false,
          resultSummary: 'no asset filter', errorMessage: 'no filter',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Resolve target assets.
    let assets: AssetEntity[];
    if (assetIdInternal) {
      const a = await this.assetRepository.findOne({
        where: { shipId, assetIdInternal },
      });
      assets = a ? [a] : [];
    } else if (allWithRules) {
      // Ship-wide due list: every asset that has at least one service rule.
      const ruleAssetIds = await this.serviceRuleRepository
        .createQueryBuilder('r')
        .select('DISTINCT r.asset_id', 'asset_id')
        .where('r.ship_id = :shipId', { shipId })
        .getRawMany<{ asset_id: string }>();
      const ids = ruleAssetIds.map((r) => r.asset_id);
      assets =
        ids.length === 0
          ? []
          : await this.assetRepository
              .createQueryBuilder('a')
              .where('a.id IN (:...ids)', { ids })
              .getMany();
    } else {
      const candidates = await this.assetRepository.find({
        where: { shipId },
      });
      const { hits } = scoreAssetsByQuery(candidates, assetQuery!, {
        topN: 5, includeLocation: false,
      });
      assets = hits.map((h) => h.asset);
    }

    // Load confirmed service rules for the targets in one query. Rules
    // turn this tool from "here are raw inputs" into "here is the verdict".
    const rulesByAssetId = new Map<string, ServiceRuleEntity[]>();
    if (assets.length > 0) {
      const rules = await this.serviceRuleRepository
        .createQueryBuilder('r')
        .where('r.ship_id = :shipId', { shipId })
        .andWhere('r.asset_id IN (:...ids)', { ids: assets.map((a) => a.id) })
        .getMany();
      for (const r of rules) {
        const list = rulesByAssetId.get(r.assetId) ?? [];
        list.push(r);
        rulesByAssetId.set(r.assetId, list);
      }
    }

    if (assets.length === 0) {
      return {
        toolCallId: tc.id,
        payload: { ok: true, results: [], note: 'No matching assets.' },
        otherCall: {
          iteration, tool: 'find_pms_due', args: callArgs, ok: true,
          resultSummary: 'no matching assets',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Resolve the ship's RAG dataset ONCE — not once per asset. This is the
    // most expensive operation in the loop (paginated dataset listing); the
    // result is the same for every asset on this ship.
    let datasetId: string | null = null;
    try {
      const datasetName = this.ragService.buildShipDatasetName(shipId);
      const dataset = await this.ragService.findAccessibleDatasetByExactName(datasetName);
      datasetId = dataset?.id ?? null;
    } catch {
      // ragflow unavailable; intervalsSnippet stays empty
    }

    // Build the reverse index once so each asset lookup is O(1) instead of
    // a full catalog scan.
    const byAssetIndex = this.buildByAssetIndex(catalogIndex);

    // For each asset: current Running Hours, then — if confirmed service
    // rules exist — compute hard due/overdue verdicts. Manual snippets are
    // the fallback for rule-less assets (and a hint to create rules).
    const now = Date.now();
    const results = await Promise.all(
      assets.map(async (asset) => {
        const boundItems = byAssetIndex.get(asset.assetIdInternal) ?? [];
        const rhItem =
          boundItems.find((it) => /Running Hours/i.test(it.field)) ?? null;

        // Current hours (null when the asset has no RH counter — calendar
        // rules still get verdicts in that case).
        let currentHours: number | null = null;
        if (rhItem) {
          try {
            const sample = await this.influxService.queryMetricRange(
              orgName,
              { bucket: rhItem.bucket, measurement: rhItem.measurement, field: rhItem.field },
              new Date(now - 24 * 60 * 60 * 1000),
              new Date(now),
              'last',
            );
            if (typeof sample?.value === 'number' && Number.isFinite(sample.value)) {
              currentHours = Math.round(sample.value);
            }
          } catch {
            // ignored
          }
        }

        const rules = rulesByAssetId.get(asset.id) ?? [];

        if (rules.length > 0) {
          // ── Rule-driven verdicts ──
          const tasks = rules.map((r) => {
            // Hours axis. Requires an explicit baseline — most Running
            // Hours counters are lifetime totals, so without knowing the
            // counter value at the last service we CANNOT infer due-ness.
            // (For new/post-overhaul equipment, set the baseline to 0
            // explicitly.) Missing baseline → axis stays null → verdict
            // 'unknown', and the answer should prompt the admin to mark
            // the last service.
            let hoursRemaining: number | null = null;
            if (
              r.intervalHours !== null &&
              currentHours !== null &&
              r.lastDoneRuntimeHours !== null
            ) {
              hoursRemaining =
                r.lastDoneRuntimeHours + r.intervalHours - currentHours;
            }

            // Calendar axis.
            let daysRemaining: number | null = null;
            if (r.intervalMonths !== null && r.lastDoneAt !== null) {
              const due = new Date(r.lastDoneAt);
              due.setMonth(due.getMonth() + r.intervalMonths);
              daysRemaining = Math.round((due.getTime() - now) / 86400000);
            }

            // Verdict: worst of the two axes ("whichever comes first").
            let verdict: 'overdue' | 'due_soon' | 'ok' | 'unknown' = 'unknown';
            const axes: Array<'overdue' | 'due_soon' | 'ok'> = [];
            if (hoursRemaining !== null && r.intervalHours !== null) {
              axes.push(
                hoursRemaining <= 0
                  ? 'overdue'
                  : hoursRemaining <= Math.max(25, r.intervalHours * 0.1)
                    ? 'due_soon'
                    : 'ok',
              );
            }
            if (daysRemaining !== null) {
              axes.push(
                daysRemaining <= 0
                  ? 'overdue'
                  : daysRemaining <= 14
                    ? 'due_soon'
                    : 'ok',
              );
            }
            if (axes.includes('overdue')) verdict = 'overdue';
            else if (axes.includes('due_soon')) verdict = 'due_soon';
            else if (axes.length > 0) verdict = 'ok';

            return {
              task: r.taskName,
              interval_hours: r.intervalHours,
              interval_months: r.intervalMonths,
              last_done_at: r.lastDoneAt?.toISOString() ?? null,
              last_done_runtime_hours: r.lastDoneRuntimeHours,
              hours_remaining: hoursRemaining,
              days_remaining: daysRemaining,
              verdict,
              rule_source: r.source,
              notes: r.notes,
            };
          });

          return {
            asset_id_internal: asset.assetIdInternal,
            display_name: asset.displayName,
            brand: asset.brand,
            model: asset.model,
            status: 'rules_evaluated',
            current_running_hours: currentHours,
            tasks,
          };
        }

        // ── No rules: legacy snippet path ──
        if (!rhItem) {
          return {
            asset_id_internal: asset.assetIdInternal,
            display_name: asset.displayName,
            status: 'no_running_hours',
            note: 'No Running Hours counter bound and no service rules configured for this asset.',
          };
        }

        let intervalsSnippet = '';
        if (datasetId) {
          try {
            const ragRes = await this.ragService.retrieveChunks({
              question: `${asset.brand ?? ''} ${asset.model ?? ''} ${asset.displayName} service interval hours maintenance schedule`.trim(),
              datasetIds: [datasetId],
              topK: 3,
              similarityThreshold: 0.2,
              keyword: true,
            });
            intervalsSnippet = (ragRes.chunks ?? [])
              .map((c) => c.content?.slice(0, 400))
              .filter(Boolean)
              .join('\n---\n');
          } catch {
            // ignored — keep snippet empty
          }
        }

        return {
          asset_id_internal: asset.assetIdInternal,
          display_name: asset.displayName,
          brand: asset.brand,
          model: asset.model,
          status: currentHours !== null ? 'analyzed' : 'no_current_hours',
          current_running_hours: currentHours,
          manual_intervals_snippet: intervalsSnippet ||
            'No service-interval snippet found in the ship dataset.',
          note:
            'No confirmed service rules for this asset — compare current_running_hours against the manual snippet yourself, and suggest the admin add a service rule so future answers are definitive.',
        };
      }),
    );

    // Rank: overdue first, then due_soon, then by least margin.
    const verdictRank = (r: (typeof results)[number]): number => {
      const tasks = (r as { tasks?: Array<{ verdict: string }> }).tasks ?? [];
      if (tasks.some((t) => t.verdict === 'overdue')) return 0;
      if (tasks.some((t) => t.verdict === 'due_soon')) return 1;
      if (tasks.length > 0) return 2;
      return 3;
    };
    results.sort((a, b) => verdictRank(a) - verdictRank(b));

    const overdueCount = results.filter((r) => verdictRank(r) === 0).length;
    const dueSoonCount = results.filter((r) => verdictRank(r) === 1).length;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_pms_due', args: callArgs, ok: true,
        resultSummary: `${results.length} asset(s): ${overdueCount} overdue, ${dueSoonCount} due soon`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset_count: results.length,
        overdue_count: overdueCount,
        due_soon_count: dueSoonCount,
        results,
        note:
          'Assets with status=rules_evaluated carry computed verdicts (overdue / due_soon / ok) — quote them directly. Snippet-only assets need interpretation; recommend creating service rules for them.',
      },
    };
  }

  /**
   * Live PMS Tasks register (PmsTaskEntity) read DIRECTLY via repository — no
   * PmsService/PmsModule import, so no DI cycle. Status is the calendar verdict
   * (overdue / due-soon / ok) from the pure pms-status util; running-hours-based
   * tasks also report their due-hours target so the model can cross-check live
   * hours via find_running_hours. This is the cross-domain bridge: combine
   * telemetry/alarms with "is this equipment due for service?" in one answer.
   */
  private async toolGetMaintenanceTasks(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const callArgs = args ?? {};
    const statusFilter =
      typeof callArgs.status === 'string' ? callArgs.status : 'all';
    const assetQuery =
      typeof callArgs.assetQuery === 'string'
        ? callArgs.assetQuery.toLowerCase().trim()
        : null;

    const rows = await this.pmsTaskRepository.find({
      where: { shipId, completedAt: IsNull() },
      relations: { assets: true },
      order: { createdAt: 'DESC' },
    });

    const enriched = rows.map((task) => {
      const dueHours = computeTaskDueHours(task);
      const { status, due } = derivePmsStatus({
        dueDate: effectiveDueDate(task),
        currentHours: null,
        dueHours,
      });
      return {
        task: task.task,
        status,
        due,
        equipment: (task.assets ?? []).map((a) => a.displayName).filter(Boolean),
        category: task.category,
        department: task.department ?? null,
        due_hours: dueHours,
        interval_hours: task.intervalHours,
        last_done: task.lastDoneAt,
      };
    });

    let filtered = enriched;
    if (assetQuery) {
      const qTokens = assetQuery
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3);
      filtered = filtered.filter((t) => {
        const hay = [t.task, ...t.equipment].join(' ').toLowerCase();
        return hay.includes(assetQuery) || qTokens.some((q) => hay.includes(q));
      });
    }
    if (statusFilter === 'overdue') {
      filtered = filtered.filter((t) => t.status === 'overdue');
    } else if (statusFilter === 'due_soon') {
      filtered = filtered.filter((t) => t.status === 'due-soon');
    }

    const statusRank: Record<string, number> = {
      overdue: 0,
      'due-soon': 1,
      ok: 2,
    };
    filtered.sort(
      (a, b) => (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3),
    );
    const capped = filtered.slice(0, 60);

    const overdue = enriched.filter((t) => t.status === 'overdue').length;
    const dueSoon = enriched.filter((t) => t.status === 'due-soon').length;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration,
        tool: 'get_maintenance_tasks',
        args: callArgs,
        ok: true,
        resultSummary: `${capped.length} task(s); ${overdue} overdue, ${dueSoon} due-soon`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        total: enriched.length,
        overdue_count: overdue,
        due_soon_count: dueSoon,
        tasks: capped,
        note: 'Live PMS Tasks register = source of truth for maintenance status. status/due are the calendar verdict; for due_hours tasks, cross-check the live reading with find_running_hours.',
      },
    };
  }

  /**
   * Live Compliance / certificates register read DIRECTLY via repositories.
   * Status is derived from expiry dates (expired / expiring ≤90 days / valid)
   * and required-but-missing types surface as `missing` — mirrors
   * ComplianceService without importing its module. Lets the analyzer answer
   * survey-readiness / "is the cert in date?" alongside telemetry + maintenance.
   */
  private async toolGetComplianceStatus(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const callArgs = args ?? {};
    const filter =
      typeof callArgs.filter === 'string' ? callArgs.filter : 'attention';
    const query =
      typeof callArgs.query === 'string' ? callArgs.query.toLowerCase().trim() : null;

    const EXPIRING_DAYS = 90;
    const recordStatus = (
      expiryDate: string | null,
    ): 'valid' | 'expiring' | 'expired' => {
      if (!expiryDate) return 'valid';
      const expiry = new Date(expiryDate).getTime();
      const now = Date.now();
      if (expiry < now) return 'expired';
      return (expiry - now) / 86_400_000 <= EXPIRING_DAYS ? 'expiring' : 'valid';
    };

    const [types, docs] = await Promise.all([
      this.complianceTypeRepository.find({ where: { shipId } }),
      this.complianceDocRepository.find({
        where: { shipId },
        relations: { asset: true },
      }),
    ]);

    const docsByType = new Map<string, ComplianceDocEntity[]>();
    for (const doc of docs) {
      const list = docsByType.get(doc.docTypeId) ?? [];
      list.push(doc);
      docsByType.set(doc.docTypeId, list);
    }

    const items: Array<{
      type: string;
      section: string;
      status: string;
      expiry: string | null;
      certNo: string | null;
      issuer: string | null;
      equipment: string | null;
    }> = [];
    for (const type of types) {
      const records = docsByType.get(type.id) ?? [];
      const required =
        type.applicability === 'Y' || type.applicability === 'C';
      if (!records.length) {
        if (required) {
          items.push({
            type: type.name,
            section: type.sectionName,
            status: 'missing',
            expiry: null,
            certNo: null,
            issuer: null,
            equipment: null,
          });
        }
        continue;
      }
      for (const doc of records) {
        items.push({
          type: type.name,
          section: type.sectionName,
          status: recordStatus(doc.expiryDate),
          expiry: doc.expiryDate,
          certNo: doc.certNo,
          issuer: doc.issuer,
          equipment: doc.asset?.displayName ?? null,
        });
      }
    }

    let filtered = items;
    if (query) {
      filtered = filtered.filter((i) =>
        `${i.type} ${i.section}`.toLowerCase().includes(query),
      );
    }
    if (filter === 'expiring') filtered = filtered.filter((i) => i.status === 'expiring');
    else if (filter === 'expired') filtered = filtered.filter((i) => i.status === 'expired');
    else if (filter === 'missing') filtered = filtered.filter((i) => i.status === 'missing');
    else if (filter === 'attention') {
      filtered = filtered.filter((i) =>
        ['expired', 'expiring', 'missing'].includes(i.status),
      );
    }

    const statusRank: Record<string, number> = {
      expired: 0,
      expiring: 1,
      missing: 2,
      valid: 3,
    };
    filtered.sort(
      (a, b) => (statusRank[a.status] ?? 4) - (statusRank[b.status] ?? 4),
    );
    const capped = filtered.slice(0, 80);

    const counts = {
      expired: items.filter((i) => i.status === 'expired').length,
      expiring: items.filter((i) => i.status === 'expiring').length,
      missing: items.filter((i) => i.status === 'missing').length,
    };

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration,
        tool: 'get_compliance_status',
        args: callArgs,
        ok: true,
        resultSummary: `${capped.length} item(s); ${counts.expired} expired, ${counts.expiring} expiring, ${counts.missing} missing`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        counts,
        items: capped,
        note: 'Live Compliance register = source of truth for certificate/statutory-doc status. expiring ≈ within 90 days. Quote expiry dates + certificate numbers.',
      },
    };
  }

  /**
   * Live onboard Inventory read DIRECTLY via repositories. Answers "do we have
   * the spares / consumables onboard?" — the cross-domain payoff (e.g. service
   * due → which parts are needed → are they in stock). Matches the query
   * against item name / part number / manufacturer / supplier / category AND
   * the names of assets each item is linked to, so an equipment query surfaces
   * its linked spares.
   */
  private async toolGetInventory(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const callArgs = args ?? {};
    const query =
      typeof callArgs.query === 'string' ? callArgs.query.toLowerCase().trim() : '';
    const category =
      typeof callArgs.category === 'string' ? callArgs.category.toLowerCase().trim() : null;

    const items = await this.inventoryRepository.find({ where: { shipId } });

    // Resolve which assets each item is linked to (for equipment-based search).
    const links = items.length
      ? await this.inventoryAssetLinkRepository.find({
          where: { inventoryItemId: In(items.map((i) => i.id)) },
        })
      : [];
    const assetIds = Array.from(new Set(links.map((l) => l.assetId)));
    const assets = assetIds.length
      ? await this.assetRepository.find({ where: { id: In(assetIds) } })
      : [];
    const assetNameById = new Map(assets.map((a) => [a.id, a.displayName]));
    const linkedAssetNamesByItem = new Map<string, string[]>();
    for (const link of links) {
      const name = assetNameById.get(link.assetId);
      if (!name) continue;
      const list = linkedAssetNamesByItem.get(link.inventoryItemId) ?? [];
      list.push(name);
      linkedAssetNamesByItem.set(link.inventoryItemId, list);
    }

    const qTokens = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3);

    const scored = items
      .map((item) => {
        const linkedAssets = linkedAssetNamesByItem.get(item.id) ?? [];
        const hay = [
          item.name,
          item.partNumber,
          item.manufacturer,
          item.supplier,
          item.category,
          ...linkedAssets,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        let score: number;
        if (!query) {
          score = 1; // no query → return everything (cap applies)
        } else if (hay.includes(query)) {
          score = 3;
        } else {
          score = qTokens.filter((t) => hay.includes(t)).length;
        }
        if (category && item.category.toLowerCase() === category) {
          score += 1;
        } else if (category && item.category.toLowerCase() !== category) {
          score = 0;
        }
        return { item, score, linkedAssets };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration,
        tool: 'get_inventory',
        args: callArgs,
        ok: true,
        resultSummary: `${scored.length} item(s) matched`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        total: items.length,
        matched: scored.length,
        items: scored.map(({ item, linkedAssets }) => ({
          name: item.name,
          category: item.category,
          part_number: item.partNumber,
          quantity: item.quantity != null ? Number(item.quantity) : null,
          unit: item.unit,
          location: item.location,
          manufacturer: item.manufacturer,
          supplier: item.supplier,
          linked_equipment: linkedAssets,
        })),
        note: 'Live onboard inventory. quantity is current stock on board (null = not tracked). Use to answer "do we have the spares/consumables onboard" — combine with get_maintenance_tasks and the manual to verify the parts a service needs are in stock.',
      },
    };
  }

  private async toolComparePeriods(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    const aggregation = String(args.aggregation ?? 'mean') as
      | 'mean' | 'last' | 'first' | 'min' | 'max' | 'sum' | 'delta' | 'integral';
    const range_a = (args.range_a ?? {}) as { start?: string; stop?: string };
    const range_b = (args.range_b ?? {}) as { start?: string; stop?: string };
    const labelA = typeof args.label_a === 'string' ? args.label_a : 'A';
    const labelB = typeof args.label_b === 'string' ? args.label_b : 'B';
    const callArgs = {
      measurement, field, aggregation, range_a, range_b, label_a: labelA, label_b: labelB,
    };

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'metric not in catalog' },
        otherCall: {
          iteration, tool: 'compare_periods', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog', errorMessage: 'not in catalog',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start: sA, stop: stA } = parseRange({
      start: range_a.start ?? '-7d', stop: range_a.stop,
    });
    const { start: sB, stop: stB } = parseRange({
      start: range_b.start ?? '-14d', stop: range_b.stop,
    });

    const [vA, vB] = await Promise.all([
      this.influxService.queryMetricRange(
        orgName,
        { bucket: item.bucket, measurement: item.measurement, field: item.field },
        sA, stA, aggregation,
      ),
      this.influxService.queryMetricRange(
        orgName,
        { bucket: item.bucket, measurement: item.measurement, field: item.field },
        sB, stB, aggregation,
      ),
    ]);
    const valA = typeof vA?.value === 'number' ? vA.value : null;
    const valB = typeof vB?.value === 'number' ? vB.value : null;
    const absDiff = valA !== null && valB !== null ? Math.round((valA - valB) * 100) / 100 : null;
    const pctChange =
      valA !== null && valB !== null && valB !== 0
        ? Math.round(((valA - valB) / Math.abs(valB)) * 1000) / 10
        : null;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'compare_periods', args: callArgs, ok: true,
        resultSummary: `${labelA}=${valA} vs ${labelB}=${valB}; Δ=${absDiff} (${pctChange}%)`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        measurement: item.measurement,
        field: item.field,
        unit: item.unit,
        aggregation,
        period_a: { label: labelA, range: range_a, value: valA },
        period_b: { label: labelB, range: range_b, value: valB },
        abs_diff: absDiff,
        // Signed percent: positive means A is greater than B by that share
        // of |B|. Named with the explicit unit so the LLM doesn't have to
        // guess (was the cause of "0.5 pct_change" being misread as 0.5%).
        pct_change_percent: pctChange,
      },
    };
  }

  private async toolFindLoadEnergyConsumed(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '').trim();
    const measurementPattern = String(args.measurement_pattern ?? '').trim();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const callArgs = {
      measurement: measurement || null,
      measurement_pattern: measurementPattern || null,
      range: { start: range.start ?? '-7d', stop: range.stop },
    };

    if (!measurement && !measurementPattern) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'measurement or measurement_pattern is required' },
        otherCall: {
          iteration, tool: 'find_load_energy_consumed', args: callArgs, ok: false,
          resultSummary: 'missing arg',
          errorMessage: 'measurement / measurement_pattern required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Resolve target measurements.
    const targets: string[] = [];
    if (measurement) {
      if (catalogIndex.has(measurement)) targets.push(measurement);
    } else {
      // Translate SQL LIKE pattern → JS regex (case-insensitive).
      const re = new RegExp(
        '^' +
          measurementPattern
            // Escape every regex metachar except `%` (which we translate to
            // `.*` below). Missing `?` and `*` here let an LLM's literal
            // pattern silently turn into a regex quantifier.
            .replace(/[.+?*^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.') +
          '$',
        'i',
      );
      for (const m of catalogIndex.keys()) {
        if (re.test(m)) targets.push(m);
      }
    }
    if (targets.length === 0) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'no measurements match this filter' },
        otherCall: {
          iteration, tool: 'find_load_energy_consumed', args: callArgs, ok: true,
          resultSummary: 'no measurements matched',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });
    const windowHours =
      Math.max(0.01, (stop.getTime() - start.getTime()) / (60 * 60 * 1000));

    // ── For aggregate calls (pattern), recurse via internal single-measurement helper ──
    if (targets.length > 1) {
      const perLoad = await Promise.all(
        targets.map(async (m) => {
          const r = await this.computeLoadEnergySingle(m, catalogIndex, orgName, start, stop);
          return { measurement: m, ...r };
        }),
      );
      const okLoads = perLoad.filter((l) => l.best_estimate_kwh !== null);
      const total = Math.round(
        okLoads.reduce((a, l) => a + (l.best_estimate_kwh as number), 0) * 10,
      ) / 10;
      const impliedKw = total / windowHours;
      const anomalies: Array<{
        code: string;
        severity: 'high' | 'medium' | 'low' | 'info';
        observation: string;
        possible_causes: string[];
      }> = [];
      if (impliedKw > 1500) {
        anomalies.push({
          code: 'implausible_group_power',
          severity: 'high',
          observation: `Implied group average draw of ~${Math.round(impliedKw)} kW exceeds the whole-ship envelope of a 50m yacht (~100-300 kW). Sum across pattern likely double-counts metered upstream points.`,
          possible_causes: [
            'Pattern matches BOTH per-feeder and per-bus meters → sum double-counts.',
            'One or more loads have counter glitches that overwhelm the rest.',
          ],
        });
      }
      const topLoads = okLoads
        .slice()
        .sort((a, b) => (b.best_estimate_kwh as number) - (a.best_estimate_kwh as number))
        .slice(0, 10);
      return {
        toolCallId: tc.id,
        otherCall: {
          iteration, tool: 'find_load_energy_consumed', args: callArgs, ok: true,
          resultSummary: `pattern matched ${targets.length} loads → total ${total} kWh (implied ${Math.round(impliedKw)} kW avg)` + (anomalies.length ? ` — ${anomalies.length} anomaly(s)` : ''),
          latencyMs: Date.now() - t0,
        },
        payload: {
          ok: true,
          measurement_pattern: measurementPattern,
          range: { start: range.start, stop: range.stop ?? 'now()' },
          window_hours: Math.round(windowHours * 10) / 10,
          loads_matched: targets.length,
          loads_with_data: okLoads.length,
          total_kwh: total,
          implied_avg_kw: Math.round(impliedKw * 10) / 10,
          top_loads: topLoads,
          all_loads: perLoad,
          anomalies,
          caveat:
            'For aggregate per-load patterns: only the primary (power_integration) figure is summed. Loads without `Total active power` are skipped. Watch the anomalies array — pattern can easily double-count metered upstream points.',
        },
      };
    }

    // ── Single-measurement path: same as before ──
    const singleMeas = targets[0];
    const single = await this.computeLoadEnergySingle(singleMeas, catalogIndex, orgName, start, stop);
    const impliedKw = single.best_estimate_kwh === null ? null : (single.best_estimate_kwh as number) / windowHours;
    const anomalies: Array<{
      code: string;
      severity: 'high' | 'medium' | 'low' | 'info';
      observation: string;
      possible_causes: string[];
    }> = [];
    if (impliedKw !== null && impliedKw > 500) {
      anomalies.push({
        code: 'implausible_load_power',
        severity: 'high',
        observation: `Implied average draw of ~${Math.round(impliedKw)} kW for ${singleMeas} is too high for a single load (envelope: HVAC ≤ 30 kW, watermaker ≤ 20 kW, propulsion 0–500 kW only under way).`,
        possible_causes: [
          'Energy counter reset/rollover in the window.',
          '"delivered + received" double-counts bidirectional flow.',
          'Unit confusion (Wh stored, reported as kWh or vice versa).',
        ],
      });
    }
    if (
      single.primary_kwh !== null &&
      single.secondary_total_energy_counter_kwh !== null &&
      (single.primary_kwh as number) > 0 &&
      Math.abs((single.secondary_total_energy_counter_kwh as number) - (single.primary_kwh as number)) /
        Math.max(single.primary_kwh as number, 1) >
        0.5
    ) {
      anomalies.push({
        code: 'methods_disagree',
        severity: 'medium',
        observation:
          `Power-integration says ${single.primary_kwh} kWh; energy-counter delta says ${single.secondary_total_energy_counter_kwh} kWh. They should agree within ~10% for a clean load.`,
        possible_causes: [
          'Counter is non-monotonic on this measurement.',
          'Power and counter sampled at different rates.',
          'Different Wh/kWh scaling per field.',
        ],
      });
    }
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_load_energy_consumed', args: callArgs, ok: single.best_estimate_kwh !== null,
        resultSummary:
          `${singleMeas}: ${single.best_estimate_kwh ?? 'n/a'} kWh (${single.best_estimate_method}); implied ${Math.round(impliedKw ?? 0)} kW avg` + (anomalies.length ? ` — ${anomalies.length} anomaly(s)` : ''),
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: single.best_estimate_kwh !== null,
        measurement: singleMeas,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        window_hours: Math.round(windowHours * 10) / 10,
        primary_method: 'power_integration',
        primary_kwh: single.primary_kwh,
        primary_note: single.primary_note,
        secondary_total_energy_counter_kwh: single.secondary_total_energy_counter_kwh,
        secondary_total_energy_counter_unit: single.secondary_total_energy_counter_unit,
        secondary_partial_energy_counter_kwh: single.secondary_partial_energy_counter_kwh,
        best_estimate_kwh: single.best_estimate_kwh,
        best_estimate_method: single.best_estimate_method,
        implied_avg_kw: impliedKw === null ? null : Math.round(impliedKw * 10) / 10,
        anomalies,
        caveat: 'Trust primary_kwh (power_integration). Counter delta is shown for comparison and can be misleading.',
      },
    };
  }

  private async computeLoadEnergySingle(
    measurement: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    orgName: string,
    start: Date,
    stop: Date,
  ): Promise<{
    primary_kwh: number | null;
    primary_note: string | null;
    secondary_total_energy_counter_kwh: number | null;
    secondary_total_energy_counter_unit: string | null;
    secondary_partial_energy_counter_kwh: number | null;
    best_estimate_kwh: number | null;
    best_estimate_method: string;
  }> {
    const fieldMap = catalogIndex.get(measurement);
    if (!fieldMap) {
      return {
        primary_kwh: null, primary_note: 'measurement not in catalog',
        secondary_total_energy_counter_kwh: null, secondary_total_energy_counter_unit: null,
        secondary_partial_energy_counter_kwh: null,
        best_estimate_kwh: null, best_estimate_method: 'none',
      };
    }
    let powerItem: AnalyzedCatalogItem | null = null;
    let totalEnergyItem: AnalyzedCatalogItem | null = null;
    let partialEnergyItem: AnalyzedCatalogItem | null = null;
    for (const [field, item] of fieldMap) {
      if (/^Total active power\b/i.test(field)) powerItem = item;
      else if (/^Total active energy delivered/i.test(field)) totalEnergyItem = item;
      else if (/^Partial active energy delivered/i.test(field)) partialEnergyItem = item;
    }
    if (!powerItem && !totalEnergyItem && !partialEnergyItem) {
      return {
        primary_kwh: null, primary_note: 'no power/energy fields',
        secondary_total_energy_counter_kwh: null, secondary_total_energy_counter_unit: null,
        secondary_partial_energy_counter_kwh: null,
        best_estimate_kwh: null, best_estimate_method: 'none',
      };
    }
    // PRIMARY: integrate Total active power (kW) over window → kWh directly.
    let primaryKwh: number | null = null;
    let primaryNote: string | null = null;
    if (powerItem) {
      try {
        const sample = await this.influxService.queryMetricRange(
          orgName,
          { bucket: powerItem.bucket, measurement: powerItem.measurement, field: powerItem.field },
          start, stop, 'integral',
        );
        const v = typeof sample?.value === 'number' && Number.isFinite(sample.value)
          ? sample.value
          : null;
        if (v !== null) {
          // Influx integral(unit:1h) on a kW gauge → kW × h = kWh directly.
          // If the unit is W (not kW), divide by 1000.
          const unitLower = (powerItem.unit ?? '').toLowerCase();
          const scaledKwh = unitLower === 'w' ? v / 1000 : v;
          primaryKwh = Math.round(scaledKwh * 10) / 10;
        } else {
          primaryNote = 'integral over Total active power returned no data';
        }
      } catch (err) {
        primaryNote = `integration failed: ${formatError(err)}`;
      }
    } else {
      primaryNote = 'no `Total active power` field — primary method unavailable';
    }

    // SECONDARY: counter delta on Total active energy (+ received) — non-monotonic on this vessel.
    const secondaryFromCounter = async (
      item: AnalyzedCatalogItem,
    ): Promise<{ kwh: number | null; raw: number | null; unit: string | null }> => {
      try {
        const s = await this.influxService.queryMetricRange(
          orgName,
          { bucket: item.bucket, measurement: item.measurement, field: item.field },
          start, stop, 'delta',
        );
        const v = typeof s?.value === 'number' && Number.isFinite(s.value) ? s.value : null;
        if (v === null) return { kwh: null, raw: null, unit: item.unit };
        let kwh: number;
        const u = (item.unit ?? '').toLowerCase();
        if (u === 'kwh') kwh = v;
        else kwh = v / 1000;
        return { kwh: Math.round(kwh * 10) / 10, raw: v, unit: item.unit };
      } catch {
        return { kwh: null, raw: null, unit: item.unit };
      }
    };
    const totalCounter = totalEnergyItem ? await secondaryFromCounter(totalEnergyItem) : null;
    const partialCounter = partialEnergyItem ? await secondaryFromCounter(partialEnergyItem) : null;

    let bestKwh: number | null = primaryKwh;
    let bestMethod = 'power_integration';
    if (bestKwh === null && totalCounter?.kwh !== null && totalCounter !== null) {
      bestKwh = totalCounter.kwh;
      bestMethod = 'total_active_energy_delta';
    }
    if (bestKwh === null && partialCounter?.kwh !== null && partialCounter !== null) {
      bestKwh = partialCounter.kwh;
      bestMethod = 'partial_active_energy_delta';
    }

    return {
      primary_kwh: primaryKwh,
      primary_note: primaryNote,
      secondary_total_energy_counter_kwh: totalCounter?.kwh ?? null,
      secondary_total_energy_counter_unit: totalCounter?.unit ?? null,
      secondary_partial_energy_counter_kwh: partialCounter?.kwh ?? null,
      best_estimate_kwh: bestKwh,
      best_estimate_method: bestMethod,
    };
  }

  private async toolInferRuntimeFromPower(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    // Defaults match Grafana's standard "running hours" panel: 1-hour windows
    // (aggregateWindow mean), and threshold > 0 (count every hour where the
    // unit had ANY positive power reading — equivalent to OEM hour-meter,
    // which counts energized time including standby / flush, not just
    // production-level draw). Override either if a stricter definition is
    // needed (e.g. on_threshold = rated_power × 0.5 for production-only).
    const onThreshold =
      typeof args.on_threshold === 'number' ? args.on_threshold : 0;
    const every = typeof args.every === 'string' ? args.every : '1h';
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const callArgs = {
      measurement, field, on_threshold: onThreshold, every,
      range: { start: range.start ?? '-7d', stop: range.stop },
    };

    if (!measurement || !field) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'measurement and field are required' },
        otherCall: {
          iteration, tool: 'infer_runtime_from_power', args: callArgs, ok: false,
          resultSummary: 'missing arg',
          errorMessage: 'missing required arg',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `metric ${measurement}::${field} not in catalog` },
        otherCall: {
          iteration, tool: 'infer_runtime_from_power', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog',
          errorMessage: 'metric not found',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    let samples: Array<{ timestamp: string; value: number }>;
    try {
      samples = await this.influxService.queryMetricSamples(
        orgName,
        { bucket: item.bucket, measurement: item.measurement, field: item.field },
        start, stop, every,
      );
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: msg },
        otherCall: {
          iteration, tool: 'infer_runtime_from_power', args: callArgs, ok: false,
          resultSummary: 'influx query failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }

    if (samples.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'no samples in window — metric may not be published, or the field/measurement is wrong',
        },
        otherCall: {
          iteration, tool: 'infer_runtime_from_power', args: callArgs, ok: true,
          resultSummary: 'no samples in window',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Parse `every` to milliseconds for accurate hour math (default 5m if odd).
    const everyMs = parseDurationMs(every) ?? 5 * 60 * 1000;

    let onSamples = 0;
    let totalSamples = 0;
    let sumWhenOn = 0;
    let maxValue = -Infinity;
    for (const s of samples) {
      totalSamples += 1;
      if (s.value > onThreshold) {
        onSamples += 1;
        sumWhenOn += s.value;
      }
      if (s.value > maxValue) maxValue = s.value;
    }
    const inferredRuntimeHours =
      Math.round(((onSamples * everyMs) / (60 * 60 * 1000)) * 10) / 10;
    const windowHours = (stop.getTime() - start.getTime()) / (60 * 60 * 1000);
    const utilizationPct =
      windowHours > 0
        ? Math.round((inferredRuntimeHours / windowHours) * 100 * 10) / 10
        : null;
    const avgValueWhenOn =
      onSamples > 0 ? Math.round((sumWhenOn / onSamples) * 100) / 100 : null;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'infer_runtime_from_power', args: callArgs, ok: true,
        resultSummary:
          `${inferredRuntimeHours} h ON over ${Math.round(windowHours)} h window (util ${utilizationPct}%); ${onSamples}/${totalSamples} samples > ${onThreshold}`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        measurement: item.measurement,
        field: item.field,
        unit: item.unit,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        every,
        on_threshold: onThreshold,
        window_hours: Math.round(windowHours * 10) / 10,
        samples_total: totalSamples,
        samples_above_threshold: onSamples,
        inferred_runtime_hours: inferredRuntimeHours,
        utilization_pct: utilizationPct,
        avg_value_when_on: avgValueWhenOn,
        max_value: maxValue === -Infinity ? null : Math.round(maxValue * 100) / 100,
        note:
          'Runtime is inferred from sample count above threshold × sample interval. Assumes the metric is sampled densely enough; widen `every` if sensor reports irregularly. Threshold should be set just above idle/sensor-noise — for kW power metrics 0.5 kW works well.',
      },
    };
  }

  private async toolFindVoyages(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const every = typeof args.every === 'string' ? args.every : '5m';
    const minDurationH =
      typeof args.min_duration_h === 'number' ? args.min_duration_h : 0.5;
    const minDistanceNm =
      typeof args.min_distance_nm === 'number' ? args.min_distance_nm : 1;
    const callArgs = {
      range: { start: range.start ?? '-7d', stop: range.stop },
      every, min_duration_h: minDurationH, min_distance_nm: minDistanceNm,
    };

    const sog = this.findCatalogItem(catalogIndex, 'navigation.speedOverGround', 'value');
    const lat = this.findCatalogItem(catalogIndex, 'navigation.position', 'lat');
    const lon = this.findCatalogItem(catalogIndex, 'navigation.position', 'lon');
    if (!sog || !lat || !lon) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'Catalog is missing one of navigation.speedOverGround / navigation.position.lat / navigation.position.lon. Re-analyze nav metrics first.',
        },
        otherCall: {
          iteration, tool: 'find_voyages', args: callArgs, ok: false,
          resultSummary: 'nav metrics missing',
          errorMessage: 'nav metrics not in catalog',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    const [sogSamples, latSamples, lonSamples] = await Promise.all([
      this.influxService.queryMetricSamples(
        orgName,
        { bucket: sog.bucket, measurement: sog.measurement, field: sog.field },
        start, stop, every,
      ),
      this.influxService.queryMetricSamples(
        orgName,
        { bucket: lat.bucket, measurement: lat.measurement, field: lat.field },
        start, stop, every,
      ),
      this.influxService.queryMetricSamples(
        orgName,
        { bucket: lon.bucket, measurement: lon.measurement, field: lon.field },
        start, stop, every,
      ),
    ]);

    // Index by timestamp (string).
    const sogMap = new Map(sogSamples.map((s) => [s.timestamp, s.value]));
    const latMap = new Map(latSamples.map((s) => [s.timestamp, s.value]));
    const lonMap = new Map(lonSamples.map((s) => [s.timestamp, s.value]));
    const timestamps = Array.from(
      new Set([...sogMap.keys(), ...latMap.keys(), ...lonMap.keys()]),
    ).sort();

    // SOG threshold: 0.5 (knots OR m/s; either way < 1 = essentially stopped).
    const SOG_THRESHOLD = 0.5;
    type Sample = { ts: string; sog: number | null; lat: number | null; lon: number | null };
    const series: Sample[] = timestamps.map((ts) => ({
      ts,
      sog: sogMap.get(ts) ?? null,
      lat: latMap.get(ts) ?? null,
      lon: lonMap.get(ts) ?? null,
    }));

    // Voyage segmentation: state = moving when sog > threshold for ≥ 2 consecutive
    // samples; back to stopped when sog ≤ threshold for ≥ 3 consecutive samples.
    type Voyage = {
      start: string;
      end: string;
      maxSog: number;
      sumSog: number;
      sogN: number;
      startLat: number | null;
      startLon: number | null;
      endLat: number | null;
      endLon: number | null;
      distanceNm: number;
      prevLat: number | null;
      prevLon: number | null;
    };
    const voyages: Voyage[] = [];
    let current: Voyage | null = null;
    let movingRun = 0;
    let stoppedRun = 0;

    for (const s of series) {
      const isMoving = s.sog !== null && s.sog > SOG_THRESHOLD;
      if (isMoving) {
        stoppedRun = 0;
        movingRun += 1;
        if (!current && movingRun >= 2) {
          current = {
            start: s.ts,
            end: s.ts,
            maxSog: s.sog as number,
            sumSog: s.sog as number,
            sogN: 1,
            startLat: s.lat, startLon: s.lon,
            endLat: s.lat, endLon: s.lon,
            distanceNm: 0,
            prevLat: s.lat, prevLon: s.lon,
          };
        } else if (current) {
          current.end = s.ts;
          if ((s.sog as number) > current.maxSog) current.maxSog = s.sog as number;
          current.sumSog += s.sog as number;
          current.sogN += 1;
          if (s.lat !== null && s.lon !== null && current.prevLat !== null && current.prevLon !== null) {
            current.distanceNm += haversineNm(
              current.prevLat, current.prevLon, s.lat, s.lon,
            );
          }
          current.endLat = s.lat;
          current.endLon = s.lon;
          if (s.lat !== null) current.prevLat = s.lat;
          if (s.lon !== null) current.prevLon = s.lon;
        }
      } else {
        movingRun = 0;
        stoppedRun += 1;
        if (current && stoppedRun >= 3) {
          voyages.push(current);
          current = null;
        }
      }
    }
    if (current) voyages.push(current);

    const finalized = voyages
      .map((v) => {
        const startMs = new Date(v.start).getTime();
        const endMs = new Date(v.end).getTime();
        const durH = Math.max(0, (endMs - startMs) / (60 * 60 * 1000));
        return {
          start_time: v.start,
          end_time: v.end,
          duration_h: Math.round(durH * 10) / 10,
          distance_nm: Math.round(v.distanceNm * 10) / 10,
          max_sog: Math.round(v.maxSog * 100) / 100,
          avg_sog: v.sogN > 0 ? Math.round((v.sumSog / v.sogN) * 100) / 100 : null,
          start_position: { lat: v.startLat, lon: v.startLon },
          end_position: { lat: v.endLat, lon: v.endLon },
        };
      })
      .filter((v) => v.duration_h >= minDurationH && v.distance_nm >= minDistanceNm)
      .sort((a, b) => b.start_time.localeCompare(a.start_time));

    const totalDistanceNm = Math.round(finalized.reduce((a, v) => a + v.distance_nm, 0) * 10) / 10;
    const totalDurationH = Math.round(finalized.reduce((a, v) => a + v.duration_h, 0) * 10) / 10;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_voyages', args: callArgs, ok: true,
        resultSummary:
          `${finalized.length} voyage(s); total ${totalDistanceNm} nm over ${totalDurationH} h`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        every,
        thresholds: { sog_threshold: SOG_THRESHOLD, min_duration_h: minDurationH, min_distance_nm: minDistanceNm },
        voyage_count: finalized.length,
        total_distance_nm: totalDistanceNm,
        total_duration_h: totalDurationH,
        voyages: finalized,
        note: 'SOG unit assumed knots OR m/s — threshold 0.5 is below idle for both. If voyages look suspiciously many/few, check the SOG unit in the catalog.',
      },
    };
  }

  private async toolComputeFuelPerNm(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const callArgs = { range: { start: range.start ?? '-7d', stop: range.stop } };

    // Re-use the fuel-consumption logic by calling its internals directly.
    const fakeArgsFuel = { range, group_by_day: false } as Record<string, unknown>;
    const fakeArgsVoy = { range } as Record<string, unknown>;
    const fakeTc1: OpenAiToolCall = { ...tc, id: tc.id + '-fuel' };
    const fakeTc2: OpenAiToolCall = { ...tc, id: tc.id + '-voy' };
    const [fuelResult, voyResult] = await Promise.all([
      this.toolFindFuelConsumptionTotal(fakeTc1, fakeArgsFuel, orgName, catalogIndex, iteration),
      this.toolFindVoyages(fakeTc2, fakeArgsVoy, orgName, catalogIndex, iteration),
    ]);
    const fuel = fuelResult.payload;
    const voy = voyResult.payload;
    const totalFuelL = typeof fuel.total_liters === 'number' ? (fuel.total_liters as number) : 0;
    const totalDistanceNm = typeof voy.total_distance_nm === 'number' ? (voy.total_distance_nm as number) : 0;
    const overallLPerNm =
      totalDistanceNm > 0 ? Math.round((totalFuelL / totalDistanceNm) * 100) / 100 : null;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'compute_fuel_per_nm', args: callArgs, ok: true,
        resultSummary: `${totalFuelL} L / ${totalDistanceNm} nm = ${overallLPerNm ?? 'n/a'} L/nm`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        total_fuel_l_tank_balance: totalFuelL,
        total_distance_nm: totalDistanceNm,
        total_voyage_duration_h: voy.total_duration_h ?? null,
        overall_l_per_nm: overallLPerNm,
        underlying_fuel_summary: {
          method: fuel.method,
          tank_balance_liters: fuel.total_liters,
          bunker_inflow_l: fuel.bunker_inflow_l,
          anomalies: fuel.anomalies,
        },
        voyage_count: voy.voyage_count,
        caveat:
          'L/nm is the period total divided by total distance under way. ' +
          'It does NOT exclude fuel consumed at anchor (gensets, hotel loads) — those L are in the numerator ' +
          'even though no distance is in the denominator. For a "pure underway" efficiency, restrict the range ' +
          'to a single voyage. Bunker inflow during the window is subtracted from fuel consumed via the ' +
          'tank-balance method (it does not pollute the per-nm figure).',
      },
    };
  }

  private async toolComputeKwAvgWhenState(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const stateFilter = String(args.state ?? '');
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const every = typeof args.every === 'string' ? args.every : '10m';
    const callArgs = { state: stateFilter, range, every };

    if (!['underway', 'at_anchor', 'alongside_on_shore'].includes(stateFilter)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'state must be underway / at_anchor / alongside_on_shore' },
        otherCall: {
          iteration, tool: 'compute_kw_avg_when_state', args: callArgs, ok: false,
          resultSummary: 'bad state',
          errorMessage: 'invalid state',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    const sog = this.findCatalogItem(catalogIndex, 'navigation.speedOverGround', 'value');
    const propItems = this.findPropulsionPowerItems(catalogIndex);
    const gensetItems = this.findGensetPowerItems(catalogIndex);

    const fetchSamples = (item: AnalyzedCatalogItem | null) =>
      item
        ? this.influxService.queryMetricSamples(
            orgName,
            { bucket: item.bucket, measurement: item.measurement, field: item.field },
            start, stop, every,
          )
        : Promise.resolve([] as Array<{ timestamp: string; value: number }>);

    const [sogS, propSets, gensetSets] = await Promise.all([
      fetchSamples(sog),
      Promise.all(propItems.map((it) => fetchSamples(it))),
      Promise.all(gensetItems.map((it) => fetchSamples(it))),
    ]);
    const idx = (arr: typeof sogS) => new Map(arr.map((s) => [s.timestamp, s.value]));
    const sogI = idx(sogS);
    const propMaps = propSets.map(idx);
    const gensetMaps = gensetSets.map(idx);
    const times = Array.from(
      new Set([
        ...sogI.keys(),
        ...propMaps.flatMap((m) => [...m.keys()]),
        ...gensetMaps.flatMap((m) => [...m.keys()]),
      ]),
    ).sort();

    let nMatch = 0;
    let sumKw = 0;
    for (const ts of times) {
      const sogV = sogI.get(ts) ?? 0;
      const propPower = propMaps.reduce((s, m) => s + (m.get(ts) ?? 0), 0);
      const gensetPower = gensetMaps.reduce((s, m) => s + (m.get(ts) ?? 0), 0);

      let state: string;
      if (sogV > 0.5 || Math.abs(propPower) > 5) state = 'underway';
      else if (gensetPower > 1) state = 'at_anchor';
      else state = 'alongside_on_shore';

      if (state === stateFilter) {
        nMatch += 1;
        sumKw += gensetPower;
      }
    }

    const avgKw = nMatch > 0 ? sumKw / nMatch : null;
    const fractionOfWindow = times.length > 0 ? nMatch / times.length : 0;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'compute_kw_avg_when_state', args: callArgs, ok: true,
        resultSummary:
          `state=${stateFilter}; matched=${nMatch}/${times.length} buckets; avg=${avgKw === null ? 'n/a' : Math.round(avgKw)} kW`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        every,
        state: stateFilter,
        bucket_count_total: times.length,
        bucket_count_matched: nMatch,
        fraction_of_window_in_state: Math.round(fractionOfWindow * 1000) / 1000,
        avg_kw_in_state: avgKw === null ? null : Math.round(avgKw * 10) / 10,
        note:
          'kW value is the sum of all discovered genset power (kW) readings at each time bucket. ' +
          'When state=alongside_on_shore, gensets are 0 by definition and the average is 0 kW (true on-shore consumption ' +
          'is invisible without a shore-power input meter).',
      },
    };
  }

  private async toolCorrelateMetrics(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurementA = String(args.measurement_a ?? '');
    const fieldA = String(args.field_a ?? '');
    const measurementB = String(args.measurement_b ?? '');
    const fieldB = String(args.field_b ?? '');
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const every = typeof args.every === 'string' ? args.every : '5m';
    const callArgs = {
      a: `${measurementA}::${fieldA}`,
      b: `${measurementB}::${fieldB}`,
      range, every,
    };

    const itemA = this.findCatalogItem(catalogIndex, measurementA, fieldA);
    const itemB = this.findCatalogItem(catalogIndex, measurementB, fieldB);
    if (!itemA || !itemB) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'one of the two metrics not found in catalog' },
        otherCall: {
          iteration, tool: 'correlate_metrics', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog',
          errorMessage: 'metric not found',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });
    const [sa, sb] = await Promise.all([
      this.influxService.queryMetricSamples(
        orgName,
        { bucket: itemA.bucket, measurement: itemA.measurement, field: itemA.field },
        start, stop, every,
      ),
      this.influxService.queryMetricSamples(
        orgName,
        { bucket: itemB.bucket, measurement: itemB.measurement, field: itemB.field },
        start, stop, every,
      ),
    ]);
    const mb = new Map(sb.map((s) => [s.timestamp, s.value]));
    const pairs: Array<[number, number]> = [];
    for (const s of sa) {
      const v = mb.get(s.timestamp);
      if (v !== undefined && Number.isFinite(s.value) && Number.isFinite(v)) {
        pairs.push([s.value, v]);
      }
    }
    if (pairs.length < 10) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Too few aligned samples (${pairs.length}); widen window or change every.` },
        otherCall: {
          iteration, tool: 'correlate_metrics', args: callArgs, ok: false,
          resultSummary: `too few aligned samples (${pairs.length})`,
          errorMessage: 'too few samples',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const n = pairs.length;
    const meanA = pairs.reduce((s, p) => s + p[0], 0) / n;
    const meanB = pairs.reduce((s, p) => s + p[1], 0) / n;
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (const [a, b] of pairs) {
      const da = a - meanA;
      const db = b - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
    const r = denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : 0;
    const absR = Math.abs(r);
    const strength =
      absR < 0.1 ? 'none'
        : absR < 0.3 ? 'weak'
          : absR < 0.5 ? 'moderate'
            : absR < 0.7 ? 'strong'
              : 'very strong';
    const dir = r > 0 ? 'positive' : 'negative';
    const interpretation =
      absR < 0.1
        ? `No meaningful linear correlation (r=${Math.round(r * 100) / 100}, n=${n}). The two metrics move independently in this window.`
        : `${strength} ${dir} correlation (r=${Math.round(r * 100) / 100}, n=${n}). ${
            absR >= 0.5
              ? 'Correlation does not prove causation — but the two metrics move together (or inversely) strongly enough that they are probably driven by the same underlying process.'
              : 'Mild co-movement; could be coincidence over this window.'
          }`;

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'correlate_metrics', args: callArgs, ok: true,
        resultSummary: `r=${Math.round(r * 100) / 100} (n=${n}, ${strength} ${dir})`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        every,
        n_aligned_samples: n,
        pearson_r: Math.round(r * 1000) / 1000,
        strength, direction: dir,
        interpretation,
        note: 'Pearson r captures linear correlation only. A nonlinear or lagged relationship will register lower r than the visual pattern suggests.',
      },
    };
  }

  private async toolFindUnusualPeriods(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const every = typeof args.every === 'string' ? args.every : '5m';
    const minDurationMin =
      typeof args.min_duration_min === 'number' ? args.min_duration_min : 10;
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const callArgs = { measurement, field, range, every, min_duration_min: minDurationMin, limit };

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'metric not in catalog' },
        otherCall: {
          iteration, tool: 'find_unusual_periods', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog',
          errorMessage: 'metric not found',
          latencyMs: Date.now() - t0,
        },
      };
    }
    if (item.typicalP5 == null || item.typicalP95 == null) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'metric has no typical fingerprint (p5/p95). Re-analyze the metric first.',
        },
        otherCall: {
          iteration, tool: 'find_unusual_periods', args: callArgs, ok: false,
          resultSummary: 'no fingerprint',
          errorMessage: 'no p5/p95',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });
    const samples = await this.influxService.queryMetricSamples(
      orgName,
      { bucket: item.bucket, measurement: item.measurement, field: item.field },
      start, stop, every,
    );

    // Group consecutive out-of-band samples into intervals.
    type Interval = {
      start: string;
      end: string;
      side: 'above' | 'below';
      peak: number;
      sum: number;
      n: number;
    };
    const intervals: Interval[] = [];
    let current: Interval | null = null;
    for (const s of samples) {
      const above = s.value > (item.typicalP95 as number);
      const below = s.value < (item.typicalP5 as number);
      if (!above && !below) {
        if (current) {
          intervals.push(current);
          current = null;
        }
        continue;
      }
      const side: 'above' | 'below' = above ? 'above' : 'below';
      if (!current || current.side !== side) {
        if (current) intervals.push(current);
        current = { start: s.timestamp, end: s.timestamp, side, peak: s.value, sum: s.value, n: 1 };
      } else {
        current.end = s.timestamp;
        current.sum += s.value;
        current.n += 1;
        if (side === 'above' && s.value > current.peak) current.peak = s.value;
        if (side === 'below' && s.value < current.peak) current.peak = s.value;
      }
    }
    if (current) intervals.push(current);

    const finalized = intervals
      .map((iv) => {
        const startMs = new Date(iv.start).getTime();
        const endMs = new Date(iv.end).getTime();
        const durMin = Math.max(0, (endMs - startMs) / 60000);
        return {
          start: iv.start,
          end: iv.end,
          duration_min: Math.round(durMin),
          side: iv.side,
          peak_value: Math.round(iv.peak * 100) / 100,
          avg_value: Math.round((iv.sum / iv.n) * 100) / 100,
          sample_count: iv.n,
        };
      })
      .filter((iv) => iv.duration_min >= minDurationMin)
      .sort((a, b) => b.duration_min - a.duration_min)
      .slice(0, limit);

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_unusual_periods', args: callArgs, ok: true,
        resultSummary: `${finalized.length} unusual interval(s) ≥ ${minDurationMin} min`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        measurement: item.measurement,
        field: item.field,
        unit: item.unit,
        typical_p5: item.typicalP5,
        typical_p95: item.typicalP95,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        every,
        interval_count: finalized.length,
        intervals: finalized,
        caveat:
          'Intervals are flagged purely against this vessel\'s own historical p5..p95. Statistical-normal does not equal ' +
          'spec-normal; for spec compliance, look up the manufacturer manual range via lookup_manual_spec.',
      },
    };
  }

  private async toolLookupManualSpec(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const assetIdInternal = String(args.asset_id_internal ?? '');
    const parameter = String(args.parameter ?? '');
    const topK = typeof args.top_k === 'number' ? Math.max(1, Math.min(20, args.top_k)) : 5;
    const callArgs = { asset_id_internal: assetIdInternal, parameter, top_k: topK };

    if (!assetIdInternal || !parameter) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'asset_id_internal and parameter are required' },
        otherCall: {
          iteration, tool: 'lookup_manual_spec', args: callArgs, ok: false,
          resultSummary: 'missing args',
          errorMessage: 'missing args',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const asset = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal },
    });

    // Build a focused query for RAGFlow: asset brand+model+display + parameter.
    const queryParts: string[] = [];
    if (asset?.brand) queryParts.push(asset.brand);
    if (asset?.model) queryParts.push(asset.model);
    if (asset?.displayName) queryParts.push(asset.displayName);
    queryParts.push(parameter);
    const question = queryParts.join(' ');

    const datasetName = this.ragService.buildShipDatasetName(shipId);
    let datasetId: string | null;
    try {
      const dataset = await this.ragService.findAccessibleDatasetByExactName(datasetName);
      datasetId = dataset?.id ?? null;
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `RAG dataset lookup failed: ${msg}` },
        otherCall: {
          iteration, tool: 'lookup_manual_spec', args: callArgs, ok: false,
          resultSummary: 'rag dataset lookup failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }
    if (!datasetId) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `No RAG dataset found for this ship. Upload manuals via the documents pipeline first.`,
        },
        otherCall: {
          iteration, tool: 'lookup_manual_spec', args: callArgs, ok: true,
          resultSummary: 'no ship dataset',
          latencyMs: Date.now() - t0,
        },
      };
    }

    let chunks: Array<Record<string, unknown>>;
    try {
      const res = await this.ragService.retrieveChunks({
        question,
        datasetIds: [datasetId],
        topK,
        similarityThreshold: 0.2,
        keyword: true,
        highlight: true,
      });
      chunks = (res.chunks ?? []).map((c) => ({
        document_name: c.docnm_kwd ?? c.document_keyword ?? null,
        document_id: c.document_id ?? null,
        similarity: c.similarity ?? null,
        content: c.content ?? '',
        highlight: c.highlight ?? null,
      }));
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `RAG retrieval failed: ${msg}` },
        otherCall: {
          iteration, tool: 'lookup_manual_spec', args: callArgs, ok: false,
          resultSummary: 'rag retrieval failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'lookup_manual_spec', args: callArgs, ok: true,
        resultSummary: `${chunks.length} chunk(s) for ${assetIdInternal}: ${parameter}`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset_id_internal: assetIdInternal,
        asset_brand: asset?.brand ?? null,
        asset_model: asset?.model ?? null,
        parameter,
        retrieval_question: question,
        chunk_count: chunks.length,
        chunks,
        note:
          'Manual snippets are retrieved from the ship\'s document index via the same RAGFlow pipeline that backs the documents chat responder. ' +
          'Snippets are not summarized — feel free to quote the relevant lines verbatim and attribute the document by name.',
      },
    };
  }

  // ── Batch 1: alarms, thresholds, vessel state, running hours, power ───────

  private async toolFindActiveAlarms(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const includeResolved = args.include_resolved === true;
    const callArgs = {
      range: { start: range.start ?? '-7d', stop: range.stop },
      include_resolved: includeResolved,
    };

    const alarmRe = /\b(fault|warning|alarm|alm)\b/i;
    const alarmSelectors: Array<{
      measurement: string;
      field: string;
      bucket: string;
      boundAssetIdInternal: string | null;
      kindGuess: 'fault' | 'warning' | 'alarm' | 'unknown';
    }> = [];
    for (const [meas, fieldMap] of catalogIndex) {
      for (const [field, item] of fieldMap) {
        if (!alarmRe.test(field)) continue;
        const lower = field.toLowerCase();
        const kindGuess: 'fault' | 'warning' | 'alarm' | 'unknown' = lower.includes('fault')
          ? 'fault'
          : lower.includes('warning')
            ? 'warning'
            : lower.includes('alarm') || lower.includes('alm')
              ? 'alarm'
              : 'unknown';
        alarmSelectors.push({
          measurement: meas,
          field,
          bucket: item.bucket,
          boundAssetIdInternal: item.boundAssetIdInternal,
          kindGuess,
        });
      }
    }

    if (alarmSelectors.length === 0) {
      return {
        toolCallId: tc.id,
        payload: { ok: true, scanned: 0, active: [], note: 'No alarm/fault/warning fields in catalog.' },
        otherCall: {
          iteration, tool: 'find_active_alarms', args: callArgs, ok: true,
          resultSummary: 'no alarm-like fields in catalog',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    const samples = await Promise.all(
      alarmSelectors.map(async (sel) => {
        try {
          const [lastSample, firstNonZero, maxSample] = await Promise.all([
            this.influxService.queryMetricRange(
              orgName,
              { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
              start, stop, 'last',
            ),
            this.influxService.queryFirstThresholdCrossing(
              orgName,
              { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
              start, stop,
              { direction: 'nonzero' },
            ),
            this.influxService.queryMetricRange(
              orgName,
              { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
              start, stop, 'max',
            ),
          ]);
          const lastVal = typeof lastSample?.value === 'number' ? lastSample.value : null;
          const maxVal = typeof maxSample?.value === 'number' ? maxSample.value : null;
          return { sel, lastSample, lastVal, firstNonZero, maxVal };
        } catch {
          return { sel, lastSample: null, lastVal: null, firstNonZero: null, maxVal: null };
        }
      }),
    );

    const severityRank: Record<string, number> = { fault: 3, alarm: 2, warning: 1, unknown: 0 };
    const active: Array<Record<string, unknown>> = [];
    for (const s of samples) {
      const currentlyActive = s.lastVal !== null && s.lastVal !== 0;
      const everActive = s.maxVal !== null && s.maxVal !== 0;
      if (!currentlyActive && !(includeResolved && everActive)) continue;
      active.push({
        asset_id_internal: s.sel.boundAssetIdInternal,
        measurement: s.sel.measurement,
        field: s.sel.field,
        kind: s.sel.kindGuess,
        currently_active: currentlyActive,
        current_value: s.lastVal,
        max_in_window: s.maxVal,
        first_seen_in_window: s.firstNonZero?.timestamp ?? null,
        last_seen_timestamp: s.lastSample?.timestamp ?? null,
      });
    }
    active.sort((a, b) => {
      const sa = severityRank[(a.kind as string) || 'unknown'] ?? 0;
      const sb = severityRank[(b.kind as string) || 'unknown'] ?? 0;
      return sb - sa;
    });

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_active_alarms', args: callArgs, ok: true,
        resultSummary: `${active.length} active/recent alarm(s) across ${alarmSelectors.length} scanned fields`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        scanned_fields: alarmSelectors.length,
        active_count: active.filter((a) => a.currently_active).length,
        resolved_in_window: active.filter((a) => !a.currently_active).length,
        range: { start: range.start ?? '-7d', stop: range.stop ?? 'now()' },
        active,
        note: 'Numeric fault/warning codes are reported as-is. Decoding code meanings (e.g. "0x42 = DC bus over-voltage") requires the equipment manufacturer manual; ask via documents responder for that.',
      },
    };
  }

  private async toolFindThresholdCrossings(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const measurement = String(args.measurement ?? '');
    const field = String(args.field ?? '');
    const dirRaw = String(args.direction ?? 'above');
    const direction: 'above' | 'below' = dirRaw === 'below' ? 'below' : 'above';
    const threshold = typeof args.threshold === 'number' ? args.threshold : NaN;
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const every = typeof args.every === 'string' ? args.every : '1m';
    const limit = typeof args.limit === 'number' ? args.limit : 50;
    const callArgs = {
      measurement, field, direction, threshold,
      range: { start: range.start ?? '-7d', stop: range.stop },
      every, limit,
    };

    if (!measurement || !field || !Number.isFinite(threshold)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'measurement, field, and threshold are required' },
        otherCall: {
          iteration, tool: 'find_threshold_crossings', args: callArgs, ok: false,
          resultSummary: 'missing required arg',
          errorMessage: 'measurement / field / threshold required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const item = this.findCatalogItem(catalogIndex, measurement, field);
    if (!item) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: `Metric ${measurement}::${field} not in catalog (try find_metrics_by_intent)`,
        },
        otherCall: {
          iteration, tool: 'find_threshold_crossings', args: callArgs, ok: false,
          resultSummary: 'metric not in catalog',
          errorMessage: 'metric not in catalog',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const resolvedField = item.field;

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });

    try {
      const crossings = await this.influxService.queryThresholdCrossings(
        orgName,
        { bucket: item.bucket, measurement: item.measurement, field: item.field },
        start, stop,
        { direction, threshold, every, limit },
      );
      return {
        toolCallId: tc.id,
        otherCall: {
          iteration, tool: 'find_threshold_crossings', args: callArgs, ok: true,
          resultSummary: `${crossings.length} crossing(s) of ${threshold} (${direction}) on ${measurement}::${field}`,
          latencyMs: Date.now() - t0,
        },
        payload: {
          ok: true,
          measurement: item.measurement,
          field: resolvedField,
          unit: item.unit,
          direction, threshold,
          range: { start: range.start, stop: range.stop ?? 'now()' },
          crossing_count: crossings.length,
          crossings,
        },
      };
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: msg },
        otherCall: {
          iteration, tool: 'find_threshold_crossings', args: callArgs, ok: false,
          resultSummary: 'influx query failed',
          errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }
  }

  private async toolGetVesselState(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const atTimeStr = typeof args.at_time === 'string' ? args.at_time : 'now()';
    const callArgs = { at_time: atTimeStr };

    // Look up at_time = a 10-minute window ending at the requested moment.
    const stop = parseFluxTime(atTimeStr, new Date());
    const start = new Date(stop.getTime() - 10 * 60 * 1000);

    // Discover the metrics we need.
    const sog = this.findCatalogItem(catalogIndex, 'navigation.speedOverGround', 'value');
    const heading = this.findCatalogItem(catalogIndex, 'navigation.headingTrue', 'value');
    const lat = this.findCatalogItem(catalogIndex, 'navigation.position', 'lat');
    const lon = this.findCatalogItem(catalogIndex, 'navigation.position', 'lon');
    const propItems = this.findPropulsionPowerItems(catalogIndex);
    const gensetItems = this.findGensetPowerItems(catalogIndex);

    const lastOf = async (
      sel: AnalyzedCatalogItem | null,
    ): Promise<number | null> => {
      if (!sel) return null;
      try {
        const s = await this.influxService.queryMetricRange(
          orgName,
          { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
          start, stop, 'last',
        );
        return typeof s?.value === 'number' && Number.isFinite(s.value) ? s.value : null;
      } catch {
        return null;
      }
    };

    // Position-specific progressive lookup: a yacht alongside for days/weeks
    // still has a valid "last known GPS" — just stale. We try 10min first
    // (gets fresh fix when underway), then widen progressively. Returns
    // value + timestamp so the LLM can quote staleness in the answer.
    const lastWithTimestamp = async (
      sel: AnalyzedCatalogItem | null,
      from: Date,
      to: Date,
    ): Promise<{ value: number; timestamp: string } | null> => {
      if (!sel) return null;
      try {
        const s = await this.influxService.queryMetricRange(
          orgName,
          { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
          from, to, 'last',
        );
        if (typeof s?.value !== 'number' || !Number.isFinite(s.value)) return null;
        return { value: s.value, timestamp: s.timestamp };
      } catch {
        return null;
      }
    };
    const lastOfProgressive = async (
      sel: AnalyzedCatalogItem | null,
    ): Promise<{ value: number; timestamp: string } | null> => {
      if (!sel) return null;
      // Widening fallback windows. Each `to` is the requested moment (`stop`),
      // each `from` reaches further back if no sample is found.
      const windowsHours = [10 / 60, 24, 24 * 7, 24 * 30];
      for (const h of windowsHours) {
        const from = new Date(stop.getTime() - h * 3600 * 1000);
        const hit = await lastWithTimestamp(sel, from, stop);
        if (hit) return hit;
      }
      return null;
    };

    const [sogV, headingV, latHit, lonHit] = await Promise.all([
      lastOf(sog),
      lastOf(heading),
      lastOfProgressive(lat),
      lastOfProgressive(lon),
    ]);
    const propVals = await Promise.all(propItems.map((it) => lastOf(it)));
    const gensetVals = await Promise.all(gensetItems.map((it) => lastOf(it)));
    const latV = latHit?.value ?? null;
    const lonV = lonHit?.value ?? null;
    // Use the older of lat/lon timestamps — both are written together, so
    // they SHOULD match, but defensively pick the older one if they don't.
    const positionTimestamp = (() => {
      const a = latHit?.timestamp, b = lonHit?.timestamp;
      if (a && b) return a < b ? a : b;
      return a ?? b ?? null;
    })();
    const positionAgeHours = positionTimestamp
      ? Math.round(
          ((stop.getTime() - new Date(positionTimestamp).getTime()) / 3600000) *
            10,
        ) / 10
      : null;

    // SOG is in knots if catalog says so; SignalK raw is m/s. We compare in
    // the same unit the catalog reports; thresholds below are interpreted as
    // "knots-ish" — for SignalK m/s 0.5 means barely moving, so treat
    // values < 0.5 as "not moving" regardless of unit (covers both).
    const sogNum = sogV ?? 0;
    const propPower = propVals.reduce<number>((s, v) => s + (v ?? 0), 0);
    // Any nonzero genset output means we are NOT on shore (shore power and
    // gensets are mutually exclusive sources).
    const totalGensetPower = gensetVals.reduce<number>((s, v) => s + (v ?? 0), 0);

    let state: 'underway' | 'at_anchor' | 'alongside_on_shore';
    const reasons: string[] = [];
    if (sogNum > 0.5 || Math.abs(propPower) > 5) {
      state = 'underway';
      reasons.push(`SOG=${sogNum} and/or propulsion power=${Math.round(propPower)} kW > idle threshold.`);
    } else if (totalGensetPower > 1) {
      state = 'at_anchor';
      reasons.push(
        `vessel not moving (SOG≈0) and gensets active (${Math.round(totalGensetPower)} kW total) — running off own gensets, so NOT on shore power (shore and gensets are mutually exclusive sources).`,
      );
    } else {
      state = 'alongside_on_shore';
      reasons.push(
        `vessel idle (SOG≈0, propulsion=0), AND all gensets at zero — by exclusion, the bus is fed from shore power (or pure battery operation if no shore tie). Shore-power input is not directly telemetered.`,
      );
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'get_vessel_state', args: callArgs, ok: true,
        resultSummary: `state=${state}; SOG=${sogNum}, propulsion=${Math.round(propPower)}kW, gensets=${Math.round(totalGensetPower)}kW`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        at_time: atTimeStr,
        state,
        position: latV !== null && lonV !== null
          ? {
              lat: latV,
              lon: lonV,
              timestamp: positionTimestamp,
              age_hours: positionAgeHours,
              freshness:
                positionAgeHours === null
                  ? 'unknown'
                  : positionAgeHours <= 0.25
                    ? 'fresh'
                    : positionAgeHours <= 24
                      ? 'recent'
                      : 'stale',
            }
          : null,
        supporting_metrics: {
          'navigation.speedOverGround': sogV,
          'navigation.headingTrue': headingV,
          'navigation.position.lat': latV,
          'navigation.position.lon': lonV,
          ...Object.fromEntries(
            propItems.map((it, i) => [`${it.measurement}.${it.field}`, propVals[i]]),
          ),
          ...Object.fromEntries(
            gensetItems.map((it, i) => [`${it.measurement}.${it.field}`, gensetVals[i]]),
          ),
        },
        rationale: reasons,
        note:
          'Shore power and gensets are mutually exclusive sources — at any moment ONE feeds the bus, never both. ' +
          'Pure-batteries operation is theoretically possible but uncommon for sustained periods. ' +
          'A direct shore-tie sensor is typically not telemetered, so `alongside_on_shore` is inferred from "all gensets at zero".',
      },
    };
  }

  /**
   * Discover instantaneous electrical-power catalog items (kW) whose bound
   * asset (or measurement name) matches a predicate. Replaces hard-coded
   * per-vessel genset/propulsion measurement names so the power & state tools
   * work on ANY vessel (the binding/asset register identifies the equipment).
   */
  private findPowerItems(
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    predicate: (assetName: string, measurement: string) => boolean,
  ): AnalyzedCatalogItem[] {
    const out: AnalyzedCatalogItem[] = [];
    for (const byField of catalogIndex.values()) {
      for (const item of byField.values()) {
        const f = item.field.toLowerCase();
        if (!(f.includes('power') && f.includes('kw'))) continue;
        const asset = (item.boundAssetName ?? '').toLowerCase();
        const meas = item.measurement.toLowerCase();
        if (predicate(asset, meas)) out.push(item);
      }
    }
    return out;
  }

  /** Genset electrical-power items (kW), discovered from the catalog/register. */
  private findGensetPowerItems(
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
  ): AnalyzedCatalogItem[] {
    return this.findPowerItems(
      catalogIndex,
      (a, m) => /gen.?set|generator|genny/.test(a) || /gen.?set|generator/.test(m),
    );
  }

  /** Main-propulsion electrical-power items (kW), discovered from the catalog. */
  private findPropulsionPowerItems(
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
  ): AnalyzedCatalogItem[] {
    return this.findPowerItems(
      catalogIndex,
      (a, m) => /propuls|propeller/.test(a) || /propuls|propeller/.test(m),
    );
  }

  private findCatalogItem(
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    measurement: string,
    field: string,
  ): AnalyzedCatalogItem | null {
    const byField = catalogIndex.get(measurement);
    if (!byField) return null;
    const item = byField.get(field);
    if (item) return item;
    for (const [f, candidate] of byField) {
      if (f.startsWith(`${field} `) || f.startsWith(`${field}(`)) return candidate;
    }
    return null;
  }

  private async toolFindRunningHours(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const assetIdInternal =
      typeof args.asset_id_internal === 'string' ? args.asset_id_internal : null;
    const assetIdInternalPrefix =
      typeof args.asset_id_internal_prefix === 'string'
        ? args.asset_id_internal_prefix
        : null;
    const sfiSub = typeof args.sfi_sub === 'string' ? args.sfi_sub : null;
    const assetQuery =
      typeof args.asset_query === 'string' ? args.asset_query.trim() : null;
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const callArgs = {
      asset_id_internal: assetIdInternal,
      asset_id_internal_prefix: assetIdInternalPrefix,
      sfi_sub: sfiSub,
      asset_query: assetQuery,
      range: { start: range.start ?? '-30d', stop: range.stop },
    };

    if (!assetIdInternal && !assetIdInternalPrefix && !sfiSub && !assetQuery) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'Pass asset_id_internal, asset_id_internal_prefix, sfi_sub, or asset_query' },
        otherCall: {
          iteration, tool: 'find_running_hours', args: callArgs, ok: false,
          resultSummary: 'no asset filter',
          errorMessage: 'one of asset filters required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Resolve target assets.
    let assets: AssetEntity[];
    if (assetIdInternal) {
      const a = await this.assetRepository.findOne({
        where: { shipId, assetIdInternal },
      });
      assets = a ? [a] : [];
    } else if (assetIdInternalPrefix) {
      assets = await this.assetRepository
        .createQueryBuilder('a')
        .where('a.ship_id = :shipId', { shipId })
        .andWhere('a.asset_id_internal LIKE :prefix', {
          prefix: `${assetIdInternalPrefix}%`,
        })
        .getMany();
    } else if (assetQuery) {
      // Free-text resolution: tokenize the query, score every asset, take
      // the top N (default 10) by overlap.
      const candidates = await this.assetRepository.find({
        where: { shipId },
      });
      const { hits } = scoreAssetsByQuery(candidates, assetQuery, {
        topN: 10, includeLocation: true,
      });
      assets = hits.map((h) => h.asset);
    } else {
      assets = await this.assetRepository.find({
        where: { shipId, sfiSub: sfiSub! },
      });
    }

    if (assets.length === 0) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'No matching assets on this ship' },
        otherCall: {
          iteration, tool: 'find_running_hours', args: callArgs, ok: false,
          resultSummary: 'no matching assets',
          errorMessage: 'asset filter returned nothing',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // For each asset, find Running Hours (h) metric directly bound to it via
    // the catalog's bound_asset_id. (We deliberately do NOT use a side-suffix
    // heuristic — it incorrectly attaches every -PS measurement's Running
    // Hours to the asset. If a measurement's Running Hours isn't bound, the
    // catalog needs re-analyze.)
    const targets: Array<{
      asset: AssetEntity;
      measurement: string;
      item: AnalyzedCatalogItem;
    }> = [];
    const unboundFieldsForReporting: Array<{ measurement: string; field: string }> = [];
    const byAssetIndex = this.buildByAssetIndex(catalogIndex);
    // Iterate the asset list (small) and look up its Running Hours items in
    // O(1). Was O(catalog × assets) — now O(catalog + assets).
    for (const asset of assets) {
      const boundItems = byAssetIndex.get(asset.assetIdInternal) ?? [];
      for (const item of boundItems) {
        if (!/Running Hours/i.test(item.field)) continue;
        targets.push({ asset, measurement: item.measurement, item });
      }
    }
    // Separately, list Running Hours fields with no asset binding so the
    // caller can see them and trigger a re-analyze.
    for (const [meas, fieldMap] of catalogIndex) {
      for (const [field, item] of fieldMap) {
        if (!/Running Hours/i.test(field)) continue;
        if (!item.boundAssetIdInternal) {
          unboundFieldsForReporting.push({ measurement: meas, field });
        }
      }
    }

    if (targets.length === 0) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: true,
          results: [],
          assets_matched: assets.map((a) => a.assetIdInternal),
          running_hours_fields_in_catalog_but_unbound: unboundFieldsForReporting,
          note:
            'No `Running Hours (h)` counter is currently bound to the requested asset(s). ' +
            (unboundFieldsForReporting.length > 0
              ? `There ARE ${unboundFieldsForReporting.length} Running Hours fields in the catalog without an asset binding — they were probably bootstrapped before the asset register was loaded. Re-analyze those metrics to fix.`
              : 'No Running Hours fields exist in the catalog for matching measurements.'),
        },
        otherCall: {
          iteration, tool: 'find_running_hours', args: callArgs, ok: true,
          resultSummary: `no Running Hours bound to ${assets.length} matched asset(s); ${unboundFieldsForReporting.length} unbound RH fields in catalog`,
          latencyMs: Date.now() - t0,
        },
      };
    }

    const { start, stop } = parseRange({
      start: range.start ?? '-30d',
      stop: range.stop,
    });
    const windowDays =
      Math.max(1, (stop.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));

    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          const sample = await this.influxService.queryMetricRange(
            orgName,
            { bucket: target.item.bucket, measurement: target.item.measurement, field: target.item.field },
            start, stop, 'delta',
          );
          const v = typeof sample?.value === 'number' && Number.isFinite(sample.value)
            ? sample.value
            : null;
          const hoursRun = v !== null ? Math.round(v * 10) / 10 : null;
          const ratePerDay = hoursRun !== null ? Math.round((hoursRun / windowDays) * 10) / 10 : null;
          return {
            asset_id_internal: target.asset.assetIdInternal,
            display_name: target.asset.displayName,
            measurement: target.item.measurement,
            field: target.item.field,
            hours_run: hoursRun,
            window_days: Math.round(windowDays * 10) / 10,
            hours_per_day_avg: ratePerDay,
            utilization_pct:
              ratePerDay !== null ? Math.round((ratePerDay / 24) * 100 * 10) / 10 : null,
          };
        } catch (err) {
          return {
            asset_id_internal: target.asset.assetIdInternal,
            display_name: target.asset.displayName,
            measurement: target.item.measurement,
            field: target.item.field,
            hours_run: null,
            error: formatError(err),
          };
        }
      }),
    );

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_running_hours', args: callArgs, ok: true,
        resultSummary: `${targets.length} engine(s) over ${Math.round(windowDays)}d`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        window_days: Math.round(windowDays * 10) / 10,
        results,
      },
    };
  }

  private async toolFindPowerConsumptionTotal(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    orgName: string,
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const range = (args.range ?? {}) as { start?: string; stop?: string };
    const topN = typeof args.top_n === 'number' ? Math.max(1, Math.min(50, args.top_n)) : 10;
    const callArgs = {
      range: { start: range.start ?? '-7d', stop: range.stop },
      top_n: topN,
    };

    const { start, stop } = parseRange({
      start: range.start ?? '-7d',
      stop: range.stop,
    });
    const windowHours =
      Math.max(1, (stop.getTime() - start.getTime()) / (60 * 60 * 1000));

    // ── PRIMARY method: integrate genset power (kW) on every genset ──
    // The vessel's gensets are the only power sources we can meter directly
    // (a shore-power input meter is usually not published). They are mutually
    // exclusive with shore power — at any moment the bus is fed by either the
    // gensets OR shore power, never both. So during genset operation,
    // ∫(genset kW) over time is the entire ship energy in that interval; any
    // time on shore power is INVISIBLE to telemetry. Gensets are discovered
    // dynamically from the catalog/asset register (not hard-coded names).
    const genSelectors = this.findGensetPowerItems(catalogIndex).map((item) => ({
      measurement: item.measurement,
      field: item.field,
      bucket: item.bucket,
      label: item.boundAssetName ?? item.measurement,
    }));

    const perGenset = await Promise.all(
      genSelectors.map(async (sel) => {
        try {
          const sample = await this.influxService.queryMetricRange(
            orgName,
            { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
            start, stop, 'integral',
          );
          // Influx integral with unit:1h returns value-hours = kW·h = kWh directly.
          const v = typeof sample?.value === 'number' && Number.isFinite(sample.value)
            ? sample.value
            : null;
          return {
            measurement: sel.measurement,
            field: sel.field,
            kwh: v !== null ? Math.round(v * 10) / 10 : null,
            ok: v !== null,
          };
        } catch (err) {
          return {
            measurement: sel.measurement,
            field: sel.field,
            kwh: null,
            ok: false,
            errorMessage: formatError(err),
          };
        }
      }),
    );
    const gensetTotalKwh = Math.round(
      perGenset.filter((g) => g.ok && g.kwh !== null)
        .reduce((a, g) => a + (g.kwh as number), 0) * 10,
    ) / 10;

    // Approximate "hours on shore power" = window hours where ALL gensets
    // reported zero power. We don't have a positive shore-power signal, so
    // this is an inference: zero genset output during the window implies the
    // ship was fed from shore (or running on batteries only).
    const meanKwPerGenset = await Promise.all(
      genSelectors.map(async (sel) => {
        try {
          const sample = await this.influxService.queryMetricRange(
            orgName,
            { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
            start, stop, 'mean',
          );
          return typeof sample?.value === 'number' ? sample.value : 0;
        } catch {
          return 0;
        }
      }),
    );
    const meanShipGensetKw = meanKwPerGenset.reduce((a, b) => a + b, 0);
    const inferredHoursOnShorePowerOrBatteries =
      meanShipGensetKw < 1
        ? Math.round(windowHours * 10) / 10
        : Math.round(((1 - meanShipGensetKw / Math.max(meanShipGensetKw, 50)) * windowHours) * 10) / 10;

    // ── SECONDARY method: existing load-counter delta sum (kept for cross-check) ──
    const energySelectors: Array<{
      measurement: string; field: string; bucket: string; unit: string | null;
    }> = [];
    for (const [meas, fieldMap] of catalogIndex) {
      for (const [field, item] of fieldMap) {
        if (/Total active energy delivered \+ received/i.test(field)) {
          energySelectors.push({
            measurement: meas, field, bucket: item.bucket, unit: item.unit,
          });
        }
      }
    }
    const perLoad = await Promise.all(
      energySelectors.map(async (sel) => {
        try {
          const sample = await this.influxService.queryMetricRange(
            orgName,
            { bucket: sel.bucket, measurement: sel.measurement, field: sel.field },
            start, stop, 'delta',
          );
          const v = typeof sample?.value === 'number' && Number.isFinite(sample.value)
            ? sample.value
            : null;
          let kwh: number | null = null;
          if (v !== null) {
            if ((sel.unit ?? '').toLowerCase() === 'kwh') kwh = v;
            else kwh = v / 1000;
            kwh = Math.round(kwh * 10) / 10;
          }
          return { measurement: sel.measurement, field: sel.field, unit_raw: sel.unit, kwh, ok: kwh !== null };
        } catch (err) {
          return {
            measurement: sel.measurement, field: sel.field, unit_raw: sel.unit,
            kwh: null, ok: false,
            errorMessage: formatError(err),
          };
        }
      }),
    );
    const okLoads = perLoad.filter((l) => l.ok && l.kwh !== null);
    const loadCounterDeltaKwh = Math.round(
      okLoads.reduce((a, l) => a + (l.kwh as number), 0) * 10,
    ) / 10;
    const top = okLoads
      .slice()
      .sort((a, b) => (b.kwh as number) - (a.kwh as number))
      .slice(0, topN);

    // ── Anomaly detection ──
    const anomalies: Array<{
      code: string;
      severity: 'high' | 'medium' | 'low' | 'info';
      observation: string;
      possible_causes: string[];
    }> = [];

    const impliedKwFromLoads = loadCounterDeltaKwh / windowHours;
    if (impliedKwFromLoads > 1000) {
      anomalies.push({
        code: 'load_counter_sum_implausible',
        severity: 'high',
        observation:
          `The secondary load-counter-sum method shows ${loadCounterDeltaKwh} kWh, implying an average ship draw ` +
          `of ~${Math.round(impliedKwFromLoads)} kW — far above a 50m yacht's ~100-300 kW envelope. ` +
          `The PRIMARY genset-integration figure (${gensetTotalKwh} kWh, implied ${Math.round(gensetTotalKwh / windowHours)} kW avg) is the trustworthy one.`,
        possible_causes: [
          'Many `Total active energy delivered + received` counters are non-monotonic on this vessel — flagged as `counter_not_monotonic` in the catalog detector. `delta = last − first` over a window with a reset returns a nonsense value.',
          'The "+ received" term in the field name means counts are BIDIRECTIONAL — energy in and energy out are summed instead of netted. For loads on a battery bus this double-counts.',
          'Same electrical path is metered at multiple points (per-feeder AND per-bus). Naively summing all loads double-counts the upstream.',
          'Mixed units across counters (Wh vs kWh) — auto-conversion may be wrong on a subset.',
        ],
      });
    }

    if (
      gensetTotalKwh < 100 &&
      windowHours > 24
    ) {
      anomalies.push({
        code: 'no_genset_output_in_window',
        severity: 'info',
        observation:
          `Genset alternators produced essentially zero kWh over the window (${gensetTotalKwh} kWh across ~${Math.round(windowHours)} h). ` +
          `On this vessel that means the ship was on SHORE POWER or running on batteries for the entire window. ` +
          `Shore-power input is NOT telemetered, so the actual kWh consumed during that time is invisible to this tool.`,
        possible_causes: [
          'Vessel was alongside / moored to shore power; gensets off.',
          'Vessel was running on house batteries only (rare for sustained periods on a 50m yacht).',
          'Genset measurement gap (sensors offline).',
        ],
      });
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_power_consumption_total', args: callArgs, ok: true,
        resultSummary:
          `Genset-integration: ${gensetTotalKwh} kWh (${Math.round(gensetTotalKwh / windowHours)} kW avg). ` +
          `Load-counter-sum (secondary): ${loadCounterDeltaKwh} kWh.` +
          (anomalies.length ? ` ${anomalies.length} anomaly(s).` : ''),
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        range: { start: range.start, stop: range.stop ?? 'now()' },
        primary_method: 'genset_power_integration',
        genset_kwh_total: gensetTotalKwh,
        genset_kwh_per_unit: perGenset,
        implied_avg_genset_kw: Math.round((gensetTotalKwh / windowHours) * 10) / 10,
        inferred_hours_on_shore_or_batteries: inferredHoursOnShorePowerOrBatteries,
        secondary_method: 'load_counter_delta_sum',
        load_counter_kwh_total: loadCounterDeltaKwh,
        loads_discovered: energySelectors.length,
        loads_with_data: okLoads.length,
        top_consumers_by_counter_delta: top,
        anomalies,
        caveat:
          'Total energy comes from integrating each genset\'s Actual motor power (kW) over the window — the only ' +
          'reliable source-side measurement on this vessel. Shore-power input is NOT telemetered here, so any time ' +
          'the vessel was on shore power is excluded from the total (it would also be ~0 from the genset-integration ' +
          'perspective). Shore power and gensets are mutually exclusive sources — at any moment the bus is fed by ' +
          'one or the other, never both. The secondary load-counter delta is given for comparison only and is ' +
          'frequently unreliable on this vessel due to non-monotonic / bidirectional counters (see anomalies).',
      },
    };
  }

  private async toolLookupAsset(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const aid = String(args.asset_id_internal ?? '');
    if (!aid) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'asset_id_internal is required' },
        otherCall: {
          iteration,
          tool: 'lookup_asset',
          args,
          ok: false,
          resultSummary: 'missing asset_id_internal',
          errorMessage: 'asset_id_internal is required',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const asset = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal: aid },
    });
    if (!asset) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Asset ${aid} not found on this ship` },
        otherCall: {
          iteration,
          tool: 'lookup_asset',
          args,
          ok: false,
          resultSummary: `asset ${aid} not found`,
          errorMessage: `Asset ${aid} not found`,
          latencyMs: Date.now() - t0,
        },
      };
    }
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration,
        tool: 'lookup_asset',
        args,
        ok: true,
        resultSummary: `${asset.assetIdInternal} ${asset.displayName} (${asset.brand ?? '?'} ${asset.model ?? '?'})`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset: {
          asset_id_internal: asset.assetIdInternal,
          display_name: asset.displayName,
          sfi_group: asset.sfiGroup,
          sfi_sub: asset.sfiSub,
          sfi_sub_name: asset.sfiSubName,
          brand: asset.brand,
          model: asset.model,
          serial_no: asset.serialNo,
          location: asset.location,
          criticality: asset.criticality,
          commissioned_date: asset.commissionedDate,
          parent_asset_id: asset.parentAssetId,
          rina_ref: asset.rinaRef,
          notes: asset.notes,
          // v14.6 location schema — exposed so AI can answer spatial Qs
          // off a single lookup_asset call without follow-up tools.
          zone: asset.zone,
          deck_role: asset.deckRole,
          deck_level: asset.deckLevel,
          space_instance: asset.spaceInstance,
          space_label: asset.spaceLabel,
          full_locator: buildAssetFullLocator({
            assetIdInternal: asset.assetIdInternal,
            zone: asset.zone,
            deckRole: asset.deckRole,
            spaceInstance: asset.spaceInstance,
          }),
          // Maintenance / drawings
          drawing_ref: asset.drawingRef,
          inspection_obligation: asset.inspectionObligation,
        },
      },
    };
  }

  private async toolFindAssetMetrics(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const aid = String(args.asset_id_internal ?? '');
    if (!aid) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'asset_id_internal is required' },
        otherCall: {
          iteration, tool: 'find_asset_metrics', args, ok: false,
          resultSummary: 'missing asset_id_internal',
          errorMessage: 'asset_id_internal is required',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const asset = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal: aid },
    });
    if (!asset) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Asset ${aid} not found` },
        otherCall: {
          iteration, tool: 'find_asset_metrics', args, ok: false,
          resultSummary: `asset ${aid} not found`,
          errorMessage: `Asset ${aid} not found`,
          latencyMs: Date.now() - t0,
        },
      };
    }
    const metrics = await this.metricRepository.find({
      where: { shipId, boundAssetId: asset.id, aiGeneratedAt: Not(IsNull()) },
      order: { id: 'ASC' },
    });
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_asset_metrics', args, ok: true,
        resultSummary: `${aid} → ${metrics.length} metrics`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset_id_internal: aid,
        metric_count: metrics.length,
        metrics: metrics.map((m) => {
          const parts = m.key.split('::');
          return {
            measurement: parts[1] ?? m.bucket,
            field: parts[2] ?? m.field,
            description: m.aiDescription,
            kind: m.aiKind,
            unit: m.aiUnit,
            typical_p50: m.aiTypicalP50,
            non_zero_share_pct: m.aiNonZeroSharePct,
            is_monotonic: m.aiIsMonotonic,
          };
        }),
      },
    };
  }

  private async toolListAssetsBySfi(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const sfiSub = String(args.sfi_sub ?? '');
    if (!sfiSub) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'sfi_sub is required' },
        otherCall: {
          iteration, tool: 'list_assets_by_sfi', args, ok: false,
          resultSummary: 'missing sfi_sub',
          errorMessage: 'sfi_sub is required',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const assets = await this.assetRepository.find({
      where: { shipId, sfiSub },
      order: { assetIdInternal: 'ASC' },
      take: 100,
    });
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'list_assets_by_sfi', args, ok: true,
        resultSummary: `sfi_sub=${sfiSub} → ${assets.length} assets`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        sfi_sub: sfiSub,
        asset_count: assets.length,
        assets: assets.map((a) => ({
          asset_id_internal: a.assetIdInternal,
          display_name: a.displayName,
          sfi_sub_name: a.sfiSubName,
          brand: a.brand,
          model: a.model,
          location: a.location,
          criticality: a.criticality,
        })),
      },
    };
  }

  // ── v14.6 location / maintenance tools ───────────────────────────────────

  private async toolFindAssetsByLocation(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const zone =
      typeof args.zone === 'string' ? args.zone.trim().toUpperCase() : null;
    const deckRole =
      typeof args.deck_role === 'string'
        ? args.deck_role.trim().toUpperCase()
        : null;
    const deckLevel =
      typeof args.deck_level === 'number' ? Math.round(args.deck_level) : null;
    const sfiSubPrefix =
      typeof args.sfi_sub_prefix === 'string'
        ? args.sfi_sub_prefix.trim()
        : null;

    if (!zone && !deckRole && deckLevel === null && !sfiSubPrefix) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'At least one of zone / deck_role / deck_level / sfi_sub_prefix is required',
        },
        otherCall: {
          iteration, tool: 'find_assets_by_location', args, ok: false,
          resultSummary: 'no filter supplied',
          errorMessage: 'At least one filter required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    const qb = this.assetRepository
      .createQueryBuilder('a')
      .where('a.ship_id = :shipId', { shipId });
    if (zone) qb.andWhere('a.zone = :zone', { zone });
    if (deckRole) qb.andWhere('a.deck_role = :deckRole', { deckRole });
    if (deckLevel !== null) qb.andWhere('a.deck_level = :deckLevel', { deckLevel });
    if (sfiSubPrefix) {
      qb.andWhere('a.sfi_sub LIKE :sfiPrefix', { sfiPrefix: `${sfiSubPrefix}%` });
    }
    qb.orderBy('a.asset_id_internal', 'ASC').take(100);

    const assets = await qb.getMany();
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'find_assets_by_location', args, ok: true,
        resultSummary: `zone=${zone ?? '*'} deck=${deckRole ?? '*'} level=${deckLevel ?? '*'} → ${assets.length} assets`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        filter: {
          zone,
          deck_role: deckRole,
          deck_level: deckLevel,
          sfi_sub_prefix: sfiSubPrefix,
        },
        asset_count: assets.length,
        assets: assets.map((a) => ({
          asset_id_internal: a.assetIdInternal,
          display_name: a.displayName,
          sfi_sub_name: a.sfiSubName,
          brand: a.brand,
          model: a.model,
          zone: a.zone,
          deck_role: a.deckRole,
          deck_level: a.deckLevel,
          space_instance: a.spaceInstance,
          space_label: a.spaceLabel,
          criticality: a.criticality,
          full_locator: buildAssetFullLocator({
            assetIdInternal: a.assetIdInternal,
            zone: a.zone,
            deckRole: a.deckRole,
            spaceInstance: a.spaceInstance,
          }),
        })),
      },
    };
  }

  private async toolGetInspectionSchedule(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const aid = String(args.asset_id_internal ?? '').trim();
    if (!aid) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'asset_id_internal is required' },
        otherCall: {
          iteration, tool: 'get_inspection_schedule', args, ok: false,
          resultSummary: 'missing asset_id_internal',
          errorMessage: 'asset_id_internal is required',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const asset = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal: aid },
    });
    if (!asset) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Asset ${aid} not found on this ship` },
        otherCall: {
          iteration, tool: 'get_inspection_schedule', args, ok: false,
          resultSummary: `asset ${aid} not found`,
          errorMessage: `Asset ${aid} not found`,
          latencyMs: Date.now() - t0,
        },
      };
    }
    const hasText = Boolean(
      asset.inspectionObligation && asset.inspectionObligation.trim(),
    );
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'get_inspection_schedule', args, ok: true,
        resultSummary: hasText
          ? `${aid}: ${asset.inspectionObligation!.length} chars`
          : `${aid}: no inspection_obligation set`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset_id_internal: aid,
        display_name: asset.displayName,
        sfi_sub_name: asset.sfiSubName,
        brand: asset.brand,
        model: asset.model,
        rina_ref: asset.rinaRef,
        inspection_obligation: asset.inspectionObligation,
        has_inspection_text: hasText,
      },
    };
  }

  private async toolGetDrawingRef(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const aid = String(args.asset_id_internal ?? '').trim();
    if (!aid) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'asset_id_internal is required' },
        otherCall: {
          iteration, tool: 'get_drawing_ref', args, ok: false,
          resultSummary: 'missing asset_id_internal',
          errorMessage: 'asset_id_internal is required',
          latencyMs: Date.now() - t0,
        },
      };
    }
    const asset = await this.assetRepository.findOne({
      where: { shipId, assetIdInternal: aid },
    });
    if (!asset) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Asset ${aid} not found on this ship` },
        otherCall: {
          iteration, tool: 'get_drawing_ref', args, ok: false,
          resultSummary: `asset ${aid} not found`,
          errorMessage: `Asset ${aid} not found`,
          latencyMs: Date.now() - t0,
        },
      };
    }
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'get_drawing_ref', args, ok: true,
        resultSummary: asset.drawingRef
          ? `${aid}: ${asset.drawingRef}`
          : `${aid}: no drawing_ref`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        asset_id_internal: aid,
        display_name: asset.displayName,
        brand: asset.brand,
        model: asset.model,
        drawing_ref: asset.drawingRef,
        rina_ref: asset.rinaRef,
        has_drawing: Boolean(asset.drawingRef && asset.drawingRef.trim()),
      },
    };
  }

  // ── Functional dependency graph (served_by) ──────────────────────────────

  private async toolTraceDependencies(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    shipId: string,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const aid = String(args.asset_id_internal ?? '').trim();
    const direction =
      args.direction === 'upstream' || args.direction === 'downstream'
        ? (args.direction as 'upstream' | 'downstream')
        : 'both';
    const maxDepth = Math.max(
      1,
      Math.min(6, typeof args.max_depth === 'number' ? args.max_depth : 3),
    );
    if (!aid) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'asset_id_internal is required' },
        otherCall: {
          iteration, tool: 'trace_dependencies', args, ok: false,
          resultSummary: 'missing asset_id_internal',
          errorMessage: 'asset_id_internal is required',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // One query, in-memory graph. ~1900 rows is trivially cheap and lets
    // us BFS both directions without N round-trips.
    const all = await this.assetRepository.find({ where: { shipId } });
    const byCode = new Map(all.map((a) => [a.assetIdInternal, a]));
    const root = byCode.get(aid);
    if (!root) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Asset ${aid} not found on this ship` },
        otherCall: {
          iteration, tool: 'trace_dependencies', args, ok: false,
          resultSummary: `asset ${aid} not found`,
          errorMessage: `Asset ${aid} not found`,
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Reverse index: provider code → assets it serves.
    const servesIndex = new Map<string, AssetEntity[]>();
    for (const a of all) {
      if (!a.servedByAssetId) continue;
      const list = servesIndex.get(a.servedByAssetId) ?? [];
      list.push(a);
      servesIndex.set(a.servedByAssetId, list);
    }

    const nodeOut = (a: AssetEntity, depth: number) => ({
      asset_id_internal: a.assetIdInternal,
      display_name: a.displayName,
      depth,
      criticality: a.criticality,
      zone: a.zone,
      served_by: a.servedByAssetId,
      emergency_feed:
        typeof (a.extras as Record<string, unknown> | null)?.[
          'served_by_emergency'
        ] === 'string'
          ? ((a.extras as Record<string, unknown>)[
              'served_by_emergency'
            ] as string)
          : null,
    });

    // Upstream: follow the served_by chain from root (linear, cycle-safe).
    const upstream: ReturnType<typeof nodeOut>[] = [];
    if (direction !== 'downstream') {
      const seen = new Set<string>([root.assetIdInternal]);
      let cur = root.servedByAssetId;
      let depth = 1;
      while (cur && depth <= maxDepth && !seen.has(cur)) {
        seen.add(cur);
        const a = byCode.get(cur);
        if (!a) break;
        upstream.push(nodeOut(a, depth));
        cur = a.servedByAssetId;
        depth += 1;
      }
    }

    // Downstream: BFS over reverse edges.
    const downstream: ReturnType<typeof nodeOut>[] = [];
    if (direction !== 'upstream') {
      const seen = new Set<string>([root.assetIdInternal]);
      let frontier = [root.assetIdInternal];
      for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const code of frontier) {
          for (const child of servesIndex.get(code) ?? []) {
            if (seen.has(child.assetIdInternal)) continue;
            seen.add(child.assetIdInternal);
            downstream.push(nodeOut(child, depth));
            next.push(child.assetIdInternal);
          }
        }
        frontier = next;
      }
    }

    const critical = downstream.filter((n) => n.criticality === 1).length;
    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'trace_dependencies', args, ok: true,
        resultSummary: `${aid}: upstream=${upstream.length}, downstream=${downstream.length} (${critical} criticality-1)`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        root: nodeOut(root, 0),
        direction,
        max_depth: maxDepth,
        upstream_chain: upstream,
        downstream_assets: downstream,
        counts: {
          upstream: upstream.length,
          downstream: downstream.length,
          downstream_criticality_1: critical,
        },
        note:
          'served_by = functional dependency (power/cooling/fluid/data provider). emergency_feed non-null means the asset has a documented emergency-bus fallback (survives main feed loss).',
      },
    };
  }

  // ── Marine weather forecast ──────────────────────────────────────────────

  private async toolGetMarineForecast(
    tc: OpenAiToolCall,
    args: Record<string, unknown>,
    iteration: number,
  ): Promise<{
    toolCallId: string;
    payload: Record<string, unknown>;
    otherCall: OtherToolCallAudit;
  }> {
    const t0 = Date.now();
    const lat = typeof args.lat === 'number' ? args.lat : Number(args.lat);
    const lon = typeof args.lon === 'number' ? args.lon : Number(args.lon);
    const hoursAhead = Math.max(
      1,
      Math.min(
        240,
        typeof args.hours_ahead === 'number' ? args.hours_ahead : 48,
      ),
    );
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: 'lat/lon are required numeric coords' },
        otherCall: {
          iteration, tool: 'get_marine_forecast', args, ok: false,
          resultSummary: 'bad coords', errorMessage: 'lat/lon invalid',
          latencyMs: Date.now() - t0,
        },
      };
    }

    if (!this.windyClient.isConfigured()) {
      return {
        toolCallId: tc.id,
        payload: {
          ok: false,
          error: 'Marine forecast unavailable — WINDY_API_KEY is not set on the backend.',
        },
        otherCall: {
          iteration, tool: 'get_marine_forecast', args, ok: false,
          resultSummary: 'windy key missing',
          errorMessage: 'WINDY_API_KEY missing',
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Windy splits parameters by model class. `gfsWave` only accepts wave
    // parameters; wind/temp/pressure/precip live in plain `gfs`. We fire
    // both in parallel and merge by timestamp index — the two GFS-family
    // models share the same hourly grid, so a positional merge is safe.
    let atmRaw, waveRaw;
    try {
      [atmRaw, waveRaw] = await Promise.all([
        this.windyClient.pointForecast({
          lat, lon, model: 'gfs',
          parameters: ['wind', 'windGust', 'temp', 'pressure', 'precip', 'rh'],
        }),
        this.windyClient.pointForecast({
          lat, lon, model: 'gfsWave',
          parameters: ['waves', 'swell1'],
        }),
      ]);
    } catch (err) {
      const msg = formatError(err);
      return {
        toolCallId: tc.id,
        payload: { ok: false, error: `Windy request failed: ${msg}` },
        otherCall: {
          iteration, tool: 'get_marine_forecast', args, ok: false,
          resultSummary: 'windy error', errorMessage: msg,
          latencyMs: Date.now() - t0,
        },
      };
    }

    // Normalize: ts array is the same shape for both responses. Wind / gust
    // come as u/v components which we scalarize. Wave heights come as
    // surface scalars. The temp/pressure live only in the gfs response.
    const tsAll: number[] = Array.isArray(atmRaw.ts) ? atmRaw.ts.map(Number) : [];
    const getFrom = (
      src: typeof atmRaw,
      k: string,
    ): number[] =>
      Array.isArray(src[k]) ? (src[k] as unknown[]).map((x) => Number(x)) : [];
    const u = getFrom(atmRaw, 'wind_u-surface');
    const v = getFrom(atmRaw, 'wind_v-surface');
    const gustU = getFrom(atmRaw, 'gust_u-surface');
    const gustV = getFrom(atmRaw, 'gust_v-surface');
    const waveH = getFrom(waveRaw, 'waves_height-surface');
    const swellH = getFrom(waveRaw, 'swell1_height-surface');
    const precip = getFrom(atmRaw, 'past3hprecip-surface');
    const pressure = getFrom(atmRaw, 'pressure-surface');
    const temp = getFrom(atmRaw, 'temp-surface');
    const rh = getFrom(atmRaw, 'rh-surface');

    // ms/s → knots
    const MS_TO_KN = 1.94384;
    const speed = (a: number, b: number): number =>
      Math.round(Math.sqrt(a * a + b * b) * MS_TO_KN * 10) / 10;
    const dir = (a: number, b: number): number => {
      // Compass bearing the wind is coming FROM, deg true.
      const deg = (Math.atan2(-a, -b) * 180) / Math.PI;
      return Math.round((deg + 360) % 360);
    };
    const tempC = (k: number): number => Math.round((k - 273.15) * 10) / 10;

    const horizonMs = Date.now() + hoursAhead * 3600 * 1000;
    const hourly: Array<{
      t: string;
      wind_kn: number;
      wind_dir_deg: number;
      gust_kn: number;
      wave_m: number;
      swell_m: number;
      precip_mm: number;
      pressure_hpa: number;
      temp_c: number;
      rh_pct: number;
    }> = [];

    for (let i = 0; i < tsAll.length; i++) {
      if (tsAll[i] > horizonMs) break;
      hourly.push({
        t: new Date(tsAll[i]).toISOString().slice(0, 16) + 'Z',
        wind_kn: speed(u[i] ?? 0, v[i] ?? 0),
        wind_dir_deg: dir(u[i] ?? 0, v[i] ?? 0),
        gust_kn: speed(gustU[i] ?? 0, gustV[i] ?? 0),
        wave_m: Math.round((waveH[i] ?? 0) * 10) / 10,
        swell_m: Math.round((swellH[i] ?? 0) * 10) / 10,
        precip_mm: Math.round((precip[i] ?? 0) * 10) / 10,
        pressure_hpa: Math.round(((pressure[i] ?? 0) / 100) * 10) / 10,
        temp_c: tempC(temp[i] ?? 273.15),
        rh_pct: Math.round(rh[i] ?? 0),
      });
    }

    const max = (arr: number[]): number =>
      arr.length === 0 ? 0 : Math.max(...arr);

    const summary = {
      window_h: hoursAhead,
      max_wind_kn: Math.round(max(hourly.map((h) => h.wind_kn)) * 10) / 10,
      max_gust_kn: Math.round(max(hourly.map((h) => h.gust_kn)) * 10) / 10,
      max_wave_m: Math.round(max(hourly.map((h) => h.wave_m)) * 10) / 10,
      max_swell_m: Math.round(max(hourly.map((h) => h.swell_m)) * 10) / 10,
      total_precip_mm:
        Math.round(hourly.reduce((s, h) => s + h.precip_mm, 0) * 10) / 10,
    };

    // Yacht-relevant warnings. Thresholds are conservative — captain can
    // override. Surfaced separately so the LLM can quote them without
    // inventing numbers.
    const warnings: string[] = [];
    if (summary.max_wind_kn >= 25) {
      warnings.push(
        `Sustained wind reaches ${summary.max_wind_kn} kn — outside comfortable cruising envelope (>25 kn).`,
      );
    }
    if (summary.max_gust_kn >= 35) {
      warnings.push(
        `Gusts up to ${summary.max_gust_kn} kn — handling becomes risky (>35 kn).`,
      );
    }
    if (summary.max_wave_m >= 2.5) {
      warnings.push(
        `Significant wave height reaches ${summary.max_wave_m} m — uncomfortable for guests (>2.5 m).`,
      );
    }
    if (summary.total_precip_mm >= 10) {
      warnings.push(
        `${summary.total_precip_mm} mm of rain over the window — visibility may suffer.`,
      );
    }

    return {
      toolCallId: tc.id,
      otherCall: {
        iteration, tool: 'get_marine_forecast', args, ok: true,
        resultSummary: `${hourly.length}h forecast: wind ≤${summary.max_wind_kn}kn, gust ≤${summary.max_gust_kn}kn, waves ≤${summary.max_wave_m}m`,
        latencyMs: Date.now() - t0,
      },
      payload: {
        ok: true,
        location: { lat, lon },
        models: ['gfs', 'gfsWave'],
        summary,
        warnings,
        hourly,
      },
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private splitKey(
    key: string,
    fallbackField: string,
  ): { measurement: string; field: string } {
    const parts = key.split('::');
    if (parts.length === 3) {
      return { measurement: parts[1], field: parts[2] };
    }
    return { measurement: '?', field: fallbackField };
  }

  private buildCatalogIndex(
    catalog: AnalyzedCatalogItem[],
  ): Map<string, Map<string, AnalyzedCatalogItem>> {
    const out = new Map<string, Map<string, AnalyzedCatalogItem>>();
    for (const m of catalog) {
      let byField = out.get(m.measurement);
      if (!byField) {
        byField = new Map();
        out.set(m.measurement, byField);
      }
      byField.set(m.field, m);
    }
    return out;
  }

  /**
   * Reverse index: `boundAssetIdInternal → AnalyzedCatalogItem[]`. Avoids
   * O(catalog × assets) loops in tools that resolve per-asset metrics
   * (find_pms_due, find_running_hours). Built once per catalog snapshot.
   */
  private buildByAssetIndex(
    catalogIndex: Map<string, Map<string, AnalyzedCatalogItem>>,
  ): Map<string, AnalyzedCatalogItem[]> {
    const out = new Map<string, AnalyzedCatalogItem[]>();
    for (const fieldMap of catalogIndex.values()) {
      for (const item of fieldMap.values()) {
        if (!item.boundAssetIdInternal) continue;
        let list = out.get(item.boundAssetIdInternal);
        if (!list) {
          list = [];
          out.set(item.boundAssetIdInternal, list);
        }
        list.push(item);
      }
    }
    return out;
  }

  /**
   * Slim, token-efficient catalog overview. Groups metrics by measurement,
   * shows up to 8 sample field names per measurement (~5-10k tokens total
   * for a 2000-metric vessel, vs ~80-100k for the verbose full dump).
   * For exhaustive details on any specific metric, the LLM is told to call
   * `find_metrics_by_intent` (token-bounded retrieval).
   */
  private renderCatalogDigest(catalog: AnalyzedCatalogItem[]): string {
    const byMeasurement = new Map<
      string,
      {
        boundAssets: Map<string, string>;
        fields: AnalyzedCatalogItem[];
      }
    >();
    for (const m of catalog) {
      let entry = byMeasurement.get(m.measurement);
      if (!entry) {
        entry = { boundAssets: new Map(), fields: [] };
        byMeasurement.set(m.measurement, entry);
      }
      entry.fields.push(m);
      if (m.boundAssetIdInternal) {
        entry.boundAssets.set(
          m.boundAssetIdInternal,
          m.boundAssetName ?? m.boundAssetIdInternal,
        );
      }
    }
    const lines: string[] = [
      `Catalog has ${catalog.length} analyzed metrics across ${byMeasurement.size} measurements.`,
      `For exhaustive search, call find_metrics_by_intent(query) — it returns the top-matching metrics with full field detail. The grouped overview below shows up to 8 sample fields per measurement; if a measurement has more, the "+N hidden" hint tells you how many were truncated, and find_metrics_by_intent(query, kind_filter?) will surface them.`,
      '',
    ];
    const sortedMeasurements = Array.from(byMeasurement.keys()).sort();
    for (const meas of sortedMeasurements) {
      const entry = byMeasurement.get(meas)!;
      const assetSummary =
        entry.boundAssets.size > 0
          ? Array.from(entry.boundAssets.entries())
              .slice(0, 3)
              .map(([id, name]) => `${id} (${name})`)
              .join(', ') +
            (entry.boundAssets.size > 3
              ? `, +${entry.boundAssets.size - 3} more`
              : '')
          : 'unbound';
      const sampleFields = entry.fields
        .slice(0, 8)
        .map((f) => `'${f.field}'(${f.kind ?? '?'}/${f.unit ?? '?'})`)
        .join(', ');
      // When fields are truncated, explicitly point to the retrieval tool so
      // the LLM doesn't assume the listed 8 are all that exist.
      const moreFields =
        entry.fields.length > 8
          ? ` (+${entry.fields.length - 8} hidden — call find_metrics_by_intent with "${meas}" to surface them)`
          : '';
      lines.push(
        `[${meas}] assets=${assetSummary} | fields(${entry.fields.length}): ${sampleFields}${moreFields}`,
      );
    }
    return lines.join('\n');
  }

}
