import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildRagflowParserConfig,
} from '../../modules/documents/parsing/document-parsing-profiles';
import {
  RagflowCreateDatasetInput,
  RagflowDataset,
  RagflowDocument,
  RagflowDocumentDownload,
  RagflowDocumentListResponse,
  RagflowDocumentUploadFile,
  RagflowListDatasetsInput,
  RagflowRemoteDocumentConfigInput,
} from './ragflow.types';

interface RagflowEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
  total_datasets?: number;
}

@Injectable()
export class RagflowClient {
  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.getBaseUrl() && this.getApiKey());
  }

  async listDatasetsByName(name: string): Promise<RagflowDataset[]> {
    const data = await this.requestJson<RagflowDataset[]>('/datasets', {
      method: 'GET',
      query: { name },
    });

    return Array.isArray(data) ? data : [];
  }

  async listDatasets(
    input: RagflowListDatasetsInput = {},
  ): Promise<RagflowDataset[]> {
    const data = await this.requestJson<RagflowDataset[]>('/datasets', {
      method: 'GET',
      query: {
        page: String(input.page ?? 1),
        page_size: String(input.pageSize ?? 100),
      },
    });

    return Array.isArray(data) ? data : [];
  }

  async createDataset(input: RagflowCreateDatasetInput): Promise<RagflowDataset> {
    return this.requestJson<RagflowDataset>('/datasets', {
      method: 'POST',
      body: {
        name: input.name,
        description: input.description,
        permission: 'me',
        chunk_method: 'manual',
        parser_config: {
          layout_recognize: 'DeepDOC',
          auto_keywords: 0,
          auto_questions: 0,
          raptor: { use_raptor: false },
          graphrag: { use_graphrag: false },
          tag_kb_ids: [],
        },
      },
    });
  }

  async uploadDocumentToDataset(
    datasetId: string,
    file: RagflowDocumentUploadFile,
  ): Promise<RagflowDocument> {
    this.assertConfigured();

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], {
        type: file.mimeType || 'application/octet-stream',
      }),
      file.originalName,
    );

    const response = await fetch(this.buildUrl(`/datasets/${datasetId}/documents`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
      },
      body: formData,
    });

    const data = await this.readEnvelope<RagflowDocument[]>(response);
    const document = data[0];

    if (!document) {
      throw new Error('RAGFlow did not return an uploaded document.');
    }

    return document;
  }

  async updateRemoteDocumentConfig(
    datasetId: string,
    documentId: string,
    input: RagflowRemoteDocumentConfigInput,
  ): Promise<RagflowDocument> {
    return this.requestJson<RagflowDocument>(
      `/datasets/${datasetId}/documents/${documentId}`,
      {
        method: 'PUT',
        body: {
          chunk_method: input.parsingProfile.ragflowChunkMethod,
          parser_config: buildRagflowParserConfig(input.parsingProfile),
          meta_fields: input.metadata,
        },
      },
    );
  }

  async triggerRemoteParse(datasetId: string, documentId: string): Promise<void> {
    await this.requestJson<unknown>(`/datasets/${datasetId}/chunks`, {
      method: 'POST',
      body: {
        document_ids: [documentId],
      },
    });
  }

  async fetchRemoteDocumentStatus(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowDocument | null> {
    const data = await this.requestJson<RagflowDocumentListResponse>(
      `/datasets/${datasetId}/documents`,
      {
        method: 'GET',
        query: {
          id: documentId,
          page: '1',
          page_size: '1',
        },
      },
    );

    return data?.docs?.[0] ?? null;
  }

  async deleteDocumentsFromDataset(
    datasetId: string,
    documentIds: string[],
  ): Promise<void> {
    await this.requestJson<unknown>(`/datasets/${datasetId}/documents`, {
      method: 'DELETE',
      body: {
        ids: documentIds,
      },
    });
  }

  async downloadDocumentFromDataset(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowDocumentDownload> {
    this.assertConfigured();

    const response = await fetch(
      this.buildUrl(`/datasets/${datasetId}/documents/${documentId}`),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.getApiKey()}`,
        },
      },
    );
    const contentType = response.headers.get('content-type');
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      throw new Error(
        this.readRawErrorMessage(buffer, response) ||
          `RAGFlow document download failed: ${response.status} ${response.statusText}`,
      );
    }

    this.assertRawSuccess(buffer, contentType);

    return {
      buffer,
      contentType,
    };
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
      query?: Record<string, string>;
    },
  ): Promise<T> {
    this.assertConfigured();

    const response = await fetch(this.buildUrl(path, options.query), {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    return this.readEnvelope<T>(response);
  }

  private async readEnvelope<T>(response: Response): Promise<T> {
    const text = await response.text();
    const payload = this.parseEnvelope<T>(text, response);

    if (!response.ok) {
      throw new Error(
        payload.message ||
          `RAGFlow request failed: ${response.status} ${response.statusText}`,
      );
    }

    if (payload.code !== 0) {
      throw new Error(payload.message || 'RAGFlow request failed.');
    }

    return payload.data as T;
  }

  private parseEnvelope<T>(
    text: string,
    response: Response,
  ): RagflowEnvelope<T> {
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text) as RagflowEnvelope<T>;
    } catch {
      if (!response.ok) {
        throw new Error(
          text || `RAGFlow request failed: ${response.status} ${response.statusText}`,
        );
      }

      throw new Error('RAGFlow returned an invalid JSON response.');
    }
  }

  private assertRawSuccess(buffer: Buffer, contentType: string | null): void {
    if (!contentType?.toLowerCase().includes('application/json')) {
      return;
    }

    try {
      const payload = JSON.parse(buffer.toString('utf8')) as RagflowEnvelope<unknown>;

      if (payload.code !== undefined && payload.code !== 0) {
        throw new Error(payload.message || 'RAGFlow document download failed.');
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
    }
  }

  private readRawErrorMessage(buffer: Buffer, response: Response): string | null {
    const text = buffer.toString('utf8');

    if (!text) {
      return null;
    }

    try {
      const payload = JSON.parse(text) as RagflowEnvelope<unknown>;
      return payload.message ?? null;
    } catch {
      return text || `${response.status} ${response.statusText}`;
    }
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const baseUrl = this.getBaseUrl().replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${baseUrl}/api/v1${normalizedPath}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'RAGFlow integration is not configured.',
      );
    }
  }

  private getBaseUrl(): string {
    return this.configService.get<string>('integrations.rag.baseUrl', '').trim();
  }

  private getApiKey(): string {
    return this.configService.get<string>('integrations.rag.apiKey', '').trim();
  }
}
