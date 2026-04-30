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
    chat: {
      documentsResponderEnabled: parseBoolean(
        process.env.CHAT_DOCUMENTS_RESPONDER_ENABLED,
        false,
      ),
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
        model: process.env.WEB_SEARCH_MODEL ?? 'gpt-5.2',
      },
      llm: {
        provider: process.env.LLM_PROVIDER ?? 'openai',
        baseUrl: process.env.LLM_BASE_URL ?? '',
        model: process.env.LLM_MODEL ?? 'gpt-4.1-mini',
        apiKey: process.env.LLM_API_KEY ?? '',
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
    },
  };
}
