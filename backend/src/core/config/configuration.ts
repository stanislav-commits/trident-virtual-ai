import { getDatabaseEnv } from '../database/database.config';

function splitCsv(value?: string): string[] {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

export default function configuration() {
  const db = getDatabaseEnv();

  return {
    app: {
      name: process.env.APP_NAME ?? 'trident-virtual-ai-backend',
      environment: process.env.NODE_ENV ?? 'development',
      port: Number.parseInt(process.env.PORT ?? '3000', 10),
      corsOrigins: splitCsv(process.env.CORS_ORIGINS).length
        ? splitCsv(process.env.CORS_ORIGINS)
        : ['http://localhost:3000', 'http://localhost:5173'],
    },
    auth: {
      jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    },
    alerts: {
      autoAnalyzeSeverity: process.env.ALERT_AUTO_ANALYZE_SEVERITY ?? 'critical,high',
      // Max characters kept for the auto-analysis text — the Notifications
      // panel needs a short, factual annotation, not a full report; the
      // prompt asks for that but the cut is enforced deterministically too.
      autoAnalyzeMaxChars: 420,
      // Daily deterministic trend scan → Notifications (off by default).
      trendWarningsEnabled: parseBoolean(process.env.TREND_WARNINGS_ENABLED, false),
    },
    chat: {
      documentsResponderEnabled: parseBoolean(
        process.env.CHAT_DOCUMENTS_RESPONDER_ENABLED,
        false,
      ),
      metricAnalyzerEnabled: parseBoolean(
        process.env.CHAT_METRIC_ANALYZER_ENABLED,
        true,
      ),
      // Proactive morning brief (off by default — one analyzer run per ship
      // per day; enable deliberately on prod).
      dailyBriefEnabled: parseBoolean(process.env.DAILY_BRIEF_ENABLED, false),
      dailyBriefLanguage: process.env.DAILY_BRIEF_LANGUAGE ?? 'en',
      voice: {
        maxUploadBytes: parsePositiveInteger(
          process.env.CHAT_VOICE_MAX_UPLOAD_BYTES,
          10 * 1024 * 1024,
        ),
        maxDurationMs: parsePositiveInteger(
          process.env.CHAT_VOICE_MAX_DURATION_MS,
          120_000,
        ),
      },
    },
    documents: {
      uploadSpoolDir: process.env.DOCUMENT_UPLOAD_SPOOL_DIR ?? '',
      // 'local' = keep originals on the backend disk spool (legacy);
      // 'spaces' = persist originals + extracted markdown in DO Spaces (S3).
      storageProvider: (
        process.env.DOCUMENTS_STORAGE_PROVIDER ?? 'local'
      ).trim(),
      spaces: {
        endpoint: process.env.DOCUMENTS_SPACES_ENDPOINT ?? '',
        region: process.env.DOCUMENTS_SPACES_REGION ?? 'us-east-1',
        bucket: process.env.DOCUMENTS_SPACES_BUCKET ?? '',
        accessKeyId: process.env.DOCUMENTS_SPACES_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.DOCUMENTS_SPACES_SECRET_ACCESS_KEY ?? '',
      },
      parseDrainEnabled: parseBoolean(
        process.env.DOCUMENTS_PARSE_DRAIN_ENABLED,
        true,
      ),
      parseDrainIntervalMs: parsePositiveInteger(
        process.env.DOCUMENTS_PARSE_DRAIN_INTERVAL_MS,
        15_000,
      ),
    },
    database: {
      host: db.host,
      port: db.port,
      name: db.name,
      user: db.user,
      password: db.password,
      ssl: db.ssl,
      sslRejectUnauthorized: db.sslRejectUnauthorized,
    },
    integrations: {
      postgres: {
        host: db.host,
        port: db.port,
        name: db.name,
        user: db.user,
      },
      influx: {
        url: process.env.INFLUX_URL ?? '',
        org: process.env.INFLUX_ORG ?? '',
        token: process.env.INFLUX_TOKEN ?? '',
        schemaLookback: process.env.INFLUX_SCHEMA_LOOKBACK ?? '-365d',
        queryLookback:
          process.env.INFLUX_QUERY_LOOKBACK ??
          process.env.INFLUX_SCHEMA_LOOKBACK ??
          '-365d',
      },
      rag: {
        provider: process.env.RAG_PROVIDER ?? 'local',
        indexName: process.env.RAG_INDEX_NAME ?? '',
        baseUrl: process.env.RAGFLOW_BASE_URL ?? process.env.RAG_BASE_URL ?? '',
        apiKey: process.env.RAGFLOW_API_KEY ?? process.env.RAG_API_KEY ?? '',
        datasetNamePrefix:
          process.env.RAGFLOW_DATASET_NAME_PREFIX ?? 'trident-ship',
        parseConcurrencyLimit: parsePositiveInteger(
          process.env.RAGFLOW_PARSE_CONCURRENCY_LIMIT,
          2,
        ),
        remoteIngestionConcurrencyLimit: parsePositiveInteger(
          process.env.RAGFLOW_REMOTE_INGESTION_CONCURRENCY_LIMIT,
          1,
        ),
        remoteIngestionRecoveryIntervalMs: parsePositiveInteger(
          process.env.RAGFLOW_REMOTE_INGESTION_RECOVERY_INTERVAL_MS,
          60_000,
        ),
        remoteIngestionStaleMs: parsePositiveInteger(
          process.env.RAGFLOW_REMOTE_INGESTION_STALE_MS,
          120_000,
        ),
      },
      webSearch: {
        baseUrl: process.env.WEB_SEARCH_BASE_URL ?? '',
        apiKey: process.env.WEB_SEARCH_API_KEY ?? '',
        model: process.env.WEB_SEARCH_MODEL ?? 'gpt-5-mini',
      },
      llm: {
        provider: process.env.LLM_PROVIDER ?? 'openai',
        baseUrl: process.env.LLM_BASE_URL ?? '',
        model: process.env.LLM_MODEL ?? 'gpt-4.1-mini',
        // Routing-critical sub-tasks (classifier / decomposer / resolver)
        // when LLM_MODEL is a Claude alias. Keep at gpt-5-mini or better —
        // see LlmService.subLlmModel for the misrouting failure mode.
        subModel: process.env.LLM_SUB_MODEL ?? 'gpt-5-mini',
        apiKey: process.env.LLM_API_KEY ?? '',
        // Anthropic Claude — auto-routed when model starts with "claude-".
        // Set ANTHROPIC_API_KEY in .env + LLM_MODEL=claude-sonnet-4-6 (etc.)
        // to switch the heavy metric-responder reasoning over to Claude.
        anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
        anthropicBaseUrl:
          process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
      },
      transcription: {
        provider: process.env.TRANSCRIPTION_PROVIDER ?? 'openai',
        baseUrl: process.env.TRANSCRIPTION_BASE_URL ?? '',
        model: process.env.TRANSCRIPTION_MODEL ?? 'whisper-1',
        apiKey: process.env.TRANSCRIPTION_API_KEY ?? '',
      },
      grafanaLlm: {
        baseUrl: process.env.GRAFANA_LLM_BASE_URL ?? '',
        apiKey:
          process.env.GRAFANA_LLM_API_KEY ?? process.env.GRAFANA_SA_TOKEN ?? '',
        model: process.env.GRAFANA_LLM_MODEL ?? 'gpt-4o',
      },
      // Grafana alerting webhook -> Trident. Shared secret authenticates the
      // webhook (no JWT). autoTaskSeverity: at/above this severity a firing
      // alert spawns an unplanned PMS task. Default 'off' — alerts do NOT
      // create tasks (set ALERT_AUTO_TASK_SEVERITY=critical to re-enable).
      grafanaAlerts: {
        webhookSecret: process.env.GRAFANA_WEBHOOK_SECRET ?? '',
        autoTaskSeverity: process.env.ALERT_AUTO_TASK_SEVERITY ?? 'off',
        // Read-only rule-list sync for the admin Rules panel (see
        // GrafanaRulesService). SA token needs alerting read.
        apiUrl:
          process.env.GRAFANA_API_URL ?? 'https://tridentvirtual.grafana.net',
        saToken:
          process.env.GRAFANA_ALERTS_SA_TOKEN ??
          process.env.GRAFANA_SA_TOKEN ??
          '',
      },
      visionExtractor: {
      dir: process.env.VISION_EXTRACTOR_DIR ?? '',
      // PDFs above this size are "oversized": they yield the extraction
      // queue to smaller files and then run SLICED (see VisionExtraction-
      // Service). 0 disables the special handling entirely.
      maxFileMb: Number(process.env.VISION_EXTRACTOR_MAX_FILE_MB ?? 20),
      // Pages per slice for oversized files — bounds extractor memory.
      slicePages: Number(process.env.VISION_EXTRACTOR_SLICE_PAGES ?? 40),
    },
    windy: {
        // Windy Point Forecast API — used by the `get_marine_forecast`
        // chat tool to answer voyage / passage / route weather questions.
        // Get a free key (500 req/day) at windy.com/api-keys.
        baseUrl: process.env.WINDY_BASE_URL ?? 'https://api.windy.com',
        apiKey: process.env.WINDY_API_KEY ?? '',
      },
    },
  };
}
