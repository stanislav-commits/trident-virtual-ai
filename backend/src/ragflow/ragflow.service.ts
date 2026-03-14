import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

const RAGFLOW_BASE_URL = process.env.RAGFLOW_BASE_URL ?? '';
const RAGFLOW_API_KEY = process.env.RAGFLOW_API_KEY ?? '';

export interface RagflowUploadFile {
  buffer: Buffer;
  originalname?: string;
}

export type RagflowChunkMethod =
  | 'manual'
  | 'naive'
  | 'table'
  | 'picture'
  | 'presentation';

interface RagflowManualParserConfig {
  auto_keywords?: number;
  auto_questions?: number;
  chunk_token_num?: number;
  delimiter?: string;
  graphrag?: { use_graphrag: false };
  image_context_size?: number;
  layout_recognize?: string;
  pages?: number[][];
  raptor?: { use_raptor: false };
  table_context_size?: number;
  task_page_size?: number;
}

interface RagflowConfigPayload {
  chunk_method: RagflowChunkMethod;
  parser_config: RagflowManualParserConfig | Record<string, never>;
}

interface RagflowDocumentUpdatePayload extends RagflowConfigPayload {}

/** Optional retrieval / reranker settings built from environment variables. */
interface RagflowRetrievalConfig {
  similarity_threshold?: number;
  top_n?: number;
  rerank_model?: string;
  vector_similarity_weight?: number;
}

@Injectable()
export class RagflowService implements OnModuleInit {
  private readonly logger = new Logger(RagflowService.name);
  private get baseUrl(): string {
    const url = RAGFLOW_BASE_URL.replace(/\/$/, '');
    if (!url) throw new Error('RAGFLOW_BASE_URL is not set');
    return url;
  }

  private get headers(): Record<string, string> {
    if (!RAGFLOW_API_KEY) throw new Error('RAGFLOW_API_KEY is not set');
    return {
      Authorization: `Bearer ${RAGFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  isConfigured(): boolean {
    return Boolean(RAGFLOW_BASE_URL && RAGFLOW_API_KEY);
  }

  /** Called by NestJS once the module is fully initialised. */
  onModuleInit(): void {
    const cfg = this.buildRetrievalConfig();
    const pdfCfg = this.buildPdfParserConfig();

    if (cfg.rerank_model) {
      this.logger.log(
        `RAGFlow retrieval config: rerank enabled (model: ${cfg.rerank_model}), top_n=${cfg.top_n ?? 'default'}`,
      );
    } else {
      this.logger.log(
        `RAGFlow retrieval config: rerank disabled (set RAGFLOW_RERANK_MODEL to enable)`,
      );
    }

    this.logger.log(
      `RAGFlow PDF parser config: layout=${pdfCfg.layout_recognize ?? 'default'}, chunk_token_num=${pdfCfg.chunk_token_num ?? 'default'}, table_context_size=${pdfCfg.table_context_size ?? 0}, image_context_size=${pdfCfg.image_context_size ?? 0}`,
    );
  }

  /**
   * Reads optional retrieval / reranker env vars and returns only the
   * fields that are actually configured.  When nothing is set the
   * returned object is empty, so current behaviour is preserved.
   */
  private buildRetrievalConfig(): RagflowRetrievalConfig {
    const cfg: RagflowRetrievalConfig = {};

    const rerank = process.env.RAGFLOW_RERANK_MODEL?.trim();
    if (rerank) cfg.rerank_model = rerank;

    // Accept both naming conventions: RAGFLOW_RETRIEVAL_TOP_N and RAGFLOW_RETRIEVAL_TOP_K
    const topN =
      this.safeParseInt(process.env.RAGFLOW_RETRIEVAL_TOP_N) ??
      this.safeParseInt(process.env.RAGFLOW_RETRIEVAL_TOP_K);
    if (topN !== undefined && topN > 0) cfg.top_n = topN;

    const simThresh = this.safeParseFloat(
      process.env.RAGFLOW_RETRIEVAL_SIMILARITY_THRESHOLD,
    );
    if (simThresh !== undefined && simThresh >= 0 && simThresh <= 1)
      cfg.similarity_threshold = simThresh;

    const vecWeight = this.safeParseFloat(
      process.env.RAGFLOW_RETRIEVAL_VECTOR_WEIGHT,
    );
    if (vecWeight !== undefined && vecWeight >= 0 && vecWeight <= 1)
      cfg.vector_similarity_weight = vecWeight;

    return cfg;
  }

  private safeParseInt(val: string | undefined): number | undefined {
    if (!val) return undefined;
    const n = parseInt(val, 10);
    return Number.isFinite(n) ? n : undefined;
  }

  private safeParseFloat(val: string | undefined): number | undefined {
    if (!val) return undefined;
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : undefined;
  }

  private getStringEnv(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value ? value : fallback;
  }

  private getIntEnv(
    name: string,
    fallback: number,
    constraints?: { min?: number; max?: number },
  ): number {
    const parsed = this.safeParseInt(process.env[name]);
    if (parsed === undefined) return fallback;
    if (constraints?.min !== undefined && parsed < constraints.min)
      return fallback;
    if (constraints?.max !== undefined && parsed > constraints.max)
      return fallback;
    return parsed;
  }

  private buildManualParserConfig(): RagflowManualParserConfig {
    return {
      layout_recognize: this.getStringEnv(
        'RAGFLOW_MANUAL_LAYOUT_RECOGNIZE',
        'DeepDOC',
      ),
      chunk_token_num: this.getIntEnv('RAGFLOW_MANUAL_CHUNK_TOKEN_NUM', 384, {
        min: 1,
        max: 2048,
      }),
      delimiter: this.getStringEnv('RAGFLOW_MANUAL_DELIMITER', '\n'),
      auto_keywords: this.getIntEnv('RAGFLOW_MANUAL_AUTO_KEYWORDS', 6, {
        min: 0,
        max: 32,
      }),
      auto_questions: this.getIntEnv('RAGFLOW_MANUAL_AUTO_QUESTIONS', 0, {
        min: 0,
        max: 10,
      }),
      task_page_size: this.getIntEnv('RAGFLOW_MANUAL_TASK_PAGE_SIZE', 6, {
        min: 1,
      }),
      raptor: { use_raptor: false },
      graphrag: { use_graphrag: false },
    };
  }

  private buildPdfParserConfig(): RagflowManualParserConfig {
    const base = this.buildManualParserConfig();

    return {
      ...base,
      layout_recognize: this.getStringEnv(
        'RAGFLOW_PDF_LAYOUT_RECOGNIZE',
        base.layout_recognize ?? 'DeepDOC',
      ),
      chunk_token_num: this.getIntEnv(
        'RAGFLOW_PDF_CHUNK_TOKEN_NUM',
        base.chunk_token_num ?? 384,
        {
          min: 1,
          max: 2048,
        },
      ),
      auto_keywords: this.getIntEnv(
        'RAGFLOW_PDF_AUTO_KEYWORDS',
        base.auto_keywords ?? 6,
        {
          min: 0,
          max: 32,
        },
      ),
      auto_questions: this.getIntEnv(
        'RAGFLOW_PDF_AUTO_QUESTIONS',
        base.auto_questions ?? 0,
        {
          min: 0,
          max: 10,
        },
      ),
      task_page_size: this.getIntEnv(
        'RAGFLOW_PDF_TASK_PAGE_SIZE',
        base.task_page_size ?? 6,
        {
          min: 1,
        },
      ),
      table_context_size: this.getIntEnv(
        'RAGFLOW_PDF_TABLE_CONTEXT_SIZE',
        192,
        {
          min: 0,
        },
      ),
      image_context_size: this.getIntEnv(
        'RAGFLOW_PDF_IMAGE_CONTEXT_SIZE',
        96,
        {
          min: 0,
        },
      ),
    };
  }

  private buildDatasetDefaultConfig(): RagflowConfigPayload {
    return {
      chunk_method: 'manual',
      parser_config: this.buildManualParserConfig(),
    };
  }

  private getFileExtension(filename: string): string {
    const trimmed = filename.trim();
    if (!trimmed) return '';
    const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx < 0 || dotIdx === base.length - 1) return '';
    return base
      .slice(dotIdx + 1)
      .toLowerCase()
      .replace(/^\.+/, '');
  }

  private buildDocumentConfigForFilename(
    filename: string,
  ): RagflowDocumentUpdatePayload {
    const ext = this.getFileExtension(filename);

    if (['pdf', 'docx'].includes(ext)) {
      return {
        chunk_method: 'manual',
        parser_config:
          ext === 'pdf'
            ? this.buildPdfParserConfig()
            : this.buildManualParserConfig(),
      };
    }

    if (['md', 'mdx', 'txt', 'html', 'json'].includes(ext)) {
      return {
        chunk_method: 'naive',
        parser_config: { raptor: { use_raptor: false } },
      };
    }

    if (['csv', 'xls', 'xlsx'].includes(ext)) {
      return { chunk_method: 'table', parser_config: {} };
    }

    if (['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'webp'].includes(ext)) {
      return { chunk_method: 'picture', parser_config: {} };
    }

    if (['ppt', 'pptx'].includes(ext)) {
      return {
        chunk_method: 'presentation',
        parser_config: { raptor: { use_raptor: false } },
      };
    }

    return {
      chunk_method: 'naive',
      parser_config: { raptor: { use_raptor: false } },
    };
  }

  async createDataset(name: string): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const res = await fetch(`${this.baseUrl}/api/v1/datasets`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name,
        ...this.buildDatasetDefaultConfig(),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow createDataset failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { code?: number; data?: { id: string } };
    if (data.code !== 0 || !data.data?.id)
      throw new Error('RAGFlow createDataset invalid response');
    return data.data.id;
  }

  async updateDatasetConfig(datasetId: string): Promise<void> {
    if (!this.isConfigured()) return;
    const res = await fetch(`${this.baseUrl}/api/v1/datasets/${datasetId}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(this.buildDatasetDefaultConfig()),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(
        `RAGFlow updateDatasetConfig failed: ${res.status} ${err}`,
      );
    }
    const data = (await res.json()) as { code?: number };
    if (data.code !== 0) throw new Error('RAGFlow updateDatasetConfig failed');
  }

  async updateDocumentConfig(
    datasetId: string,
    documentId: string,
    filename: string,
  ): Promise<void> {
    const payload = this.buildDocumentConfigForFilename(filename);
    const res = await fetch(
      `${this.baseUrl}/api/v1/datasets/${datasetId}/documents/${documentId}`,
      {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(
        `RAGFlow updateDocumentConfig failed: ${res.status} ${err}`,
      );
    }
    const data = (await res.json()) as { code?: number };
    if (data.code !== 0) throw new Error('RAGFlow updateDocumentConfig failed');
  }

  async deleteDataset(datasetId: string): Promise<void> {
    if (!this.isConfigured()) return;
    const res = await fetch(`${this.baseUrl}/api/v1/datasets`, {
      method: 'DELETE',
      headers: this.headers,
      body: JSON.stringify({ ids: [datasetId] }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow deleteDataset failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { code?: number };
    if (data.code !== 0) throw new Error('RAGFlow deleteDataset failed');
  }

  async uploadDocument(
    datasetId: string,
    file: RagflowUploadFile,
  ): Promise<{ id: string; name: string }[]> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)]),
      file.originalname || 'document.pdf',
    );
    const res = await fetch(
      `${this.baseUrl}/api/v1/datasets/${datasetId}/documents`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${RAGFLOW_API_KEY}` },
        body: form,
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow uploadDocument failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as {
      code?: number;
      data?: { id: string; name?: string }[];
    };
    if (data.code !== 0 || !Array.isArray(data.data))
      throw new Error('RAGFlow uploadDocument invalid response');
    return data.data.map((d) => ({
      id: d.id,
      name: d.name ?? file.originalname ?? 'document',
    }));
  }

  async parseDocuments(
    datasetId: string,
    documentIds: string[],
  ): Promise<void> {
    if (!documentIds.length) return;
    const res = await fetch(
      `${this.baseUrl}/api/v1/datasets/${datasetId}/chunks`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ document_ids: documentIds }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow parseDocuments failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { code?: number };
    if (data.code !== 0) throw new Error('RAGFlow parseDocuments failed');
  }

  async deleteDocument(datasetId: string, documentId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/datasets/${datasetId}/documents`,
      {
        method: 'DELETE',
        headers: this.headers,
        body: JSON.stringify({ ids: [documentId] }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow deleteDocument failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { code?: number };
    if (data.code !== 0) throw new Error('RAGFlow deleteDocument failed');
  }

  async listDocuments(
    datasetId: string,
    documentIds?: string[],
  ): Promise<
    Array<{
      id: string;
      name: string;
      run: string;
      progress: number;
      progress_msg: string;
      chunk_count: number;
      token_count: number;
    }>
  > {
    if (!this.isConfigured()) return [];
    const params = new URLSearchParams();
    if (documentIds?.length) params.set('id', documentIds.join(','));
    const res = await fetch(
      `${this.baseUrl}/api/v1/datasets/${datasetId}/documents?${params}`,
      { headers: this.headers },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow listDocuments failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as {
      code?: number;
      data?: {
        docs?: Array<{
          id: string;
          name: string;
          run: string;
          progress: number;
          progress_msg: string;
          chunk_count: number;
          token_count: number;
        }>;
        total?: number;
      };
    };
    if (data.code !== 0) throw new Error('RAGFlow listDocuments failed');
    return data.data?.docs ?? [];
  }

  async downloadDocument(
    _datasetId: string,
    documentId: string,
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const res = await fetch(`${this.baseUrl}/v1/document/get/${documentId}`, {
      headers: { Authorization: `Bearer ${RAGFLOW_API_KEY}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow downloadDocument failed: ${res.status} ${err}`);
    }
    const contentType =
      res.headers.get('content-type') ?? 'application/octet-stream';
    const disposition = res.headers.get('content-disposition') ?? '';
    const filenameMatch = disposition.match(
      /filename\*?=['"]?(?:UTF-8'')?([^'"\s;]+)/i,
    );
    const filename = filenameMatch
      ? decodeURIComponent(filenameMatch[1])
      : 'document.pdf';
    const arrayBuf = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuf), filename, contentType };
  }

  async searchDataset(
    datasetId: string,
    query: string,
    topK: number = 5,
  ): Promise<
    Array<{
      id: string;
      doc_id: string;
      doc_name: string;
      content: string;
      similarity?: number;
      meta?: Record<string, unknown>;
    }>
  > {
    if (!this.isConfigured()) return [];

    const config = this.buildRetrievalConfig();

    // When a broader pool is configured (config.top_n > caller's topK),
    // use it as top_k so RAGFlow has more candidates to rerank.
    // The caller's topK is still enforced via a top_n cap when reranking.
    const poolSize = config.top_n && config.top_n > topK ? config.top_n : topK;

    const body: Record<string, unknown> = {
      question: query,
      dataset_ids: [datasetId],
      top_k: poolSize,
    };

    if (config.similarity_threshold !== undefined)
      body.similarity_threshold = config.similarity_threshold;
    if (config.vector_similarity_weight !== undefined)
      body.vector_similarity_weight = config.vector_similarity_weight;

    if (config.rerank_model) {
      body.rerank_model = config.rerank_model;
      // When pool is broader than desired output, cap final results
      if (poolSize > topK) body.top_n = topK;
    }

    this.logger.debug(
      `RAGFlow retrieval: top_k=${poolSize}, rerank=${config.rerank_model ?? 'off'}`,
    );
    this.logger.debug(
      `RAGFlow retrieval REQUEST body: ${JSON.stringify(body)}`,
    );

    const res = await fetch(`${this.baseUrl}/api/v1/retrieval`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`RAGFlow retrieval HTTP error ${res.status}: ${err}`);
      throw new Error(`RAGFlow retrieval failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as {
      code?: number;
      data?: {
        chunks?: Array<Record<string, unknown>>;
      };
    };

    this.logger.debug(
      `RAGFlow retrieval RESPONSE code=${data.code}, chunks=${data.data?.chunks?.length ?? 0}`,
    );

    if (data.code !== 0) throw new Error('RAGFlow retrieval failed');

    const chunks = data.data?.chunks ?? [];

    if (chunks.length === 0) {
      this.logger.debug(
        `RAGFlow retrieval: no chunks returned for query="${query}"`,
      );
    } else {
      this.logger.debug(
        `RAGFlow retrieval chunk keys: ${Object.keys(chunks[0]).join(', ')}`,
      );
      chunks.forEach((chunk, i) => {
        this.logger.debug(
          `  chunk[${i}] doc="${String(chunk.document_name ?? chunk.doc_name ?? chunk.docnm_kwd ?? '')}" ` +
            `similarity=${typeof chunk.similarity === 'number' ? chunk.similarity.toFixed(4) : 'n/a'} ` +
            `content="${String(chunk.content ?? chunk.content_with_weight ?? '')
              .slice(0, 120)
              .replace(/\n/g, ' ')}"`,
        );
      });
    }

    return chunks.map((chunk) => ({
      id: String(chunk.id ?? ''),
      doc_id: String(chunk.document_id ?? chunk.doc_id ?? ''),
      doc_name: String(
        chunk.document_name ?? chunk.doc_name ?? chunk.docnm_kwd ?? '',
      ),
      content: String(chunk.content ?? chunk.content_with_weight ?? ''),
      similarity:
        typeof chunk.similarity === 'number' ? chunk.similarity : undefined,
      meta: (chunk.metadata ?? chunk.meta ?? {}) as Record<string, unknown>,
    }));
  }
}
