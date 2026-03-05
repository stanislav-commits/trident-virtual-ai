import { Injectable, Logger } from '@nestjs/common';

const RAGFLOW_BASE_URL = process.env.RAGFLOW_BASE_URL ?? '';
const RAGFLOW_API_KEY = process.env.RAGFLOW_API_KEY ?? '';

export interface RagflowUploadFile {
  buffer: Buffer;
  originalname?: string;
}

@Injectable()
export class RagflowService {
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

  async createDataset(name: string): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const res = await fetch(`${this.baseUrl}/api/v1/datasets`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name }),
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
    const res = await fetch(`${this.baseUrl}/api/v1/retrieval`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        question: query,
        dataset_ids: [datasetId],
        top_k: topK,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RAGFlow retrieval failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as {
      code?: number;
      data?: {
        chunks?: Array<Record<string, unknown>>;
      };
    };
    if (data.code !== 0) throw new Error('RAGFlow retrieval failed');

    const chunks = data.data?.chunks ?? [];
    if (chunks.length > 0) {
      this.logger.debug(
        `RAGFlow retrieval chunk keys: ${Object.keys(chunks[0]).join(', ')}`,
      );
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
