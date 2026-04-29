import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import {
  RagflowCreateDatasetInput,
  RagflowDataset,
  RagflowDocument,
  RagflowDocumentDownload,
  RagflowDocumentUploadFile,
  RagflowListDatasetsInput,
  RagflowRemoteDocumentConfigInput,
  RagflowRetrievalInput,
  RagflowRetrievalResponse,
} from './ragflow.types';
import { RagflowClient } from './ragflow.client';

@Injectable()
export class RagService {
  private readonly datasetLookupPageSize = 100;
  private readonly datasetLookupMaxPages = 100;

  constructor(
    private readonly configService: ConfigService,
    private readonly ragflowClient: RagflowClient,
  ) {}

  getStatus(): IntegrationStatusDto {
    const provider = this.configService.get<string>('integrations.rag.provider', 'local');
    const indexName = this.configService.get<string>('integrations.rag.indexName');
    const configured = this.ragflowClient.isConfigured();

    return {
      name: 'rag',
      configured,
      reachable: false,
      details: configured
        ? `RAG provider "${provider}" is configured for RAGFlow ingestion.`
        : `RAG provider "${provider}" selected, but RAGFlow base URL/API key is not configured.${indexName ? ` Legacy index "${indexName}" is present.` : ''}`,
    };
  }

  buildShipDatasetName(shipId: string): string {
    const prefix = this.configService
      .get<string>('integrations.rag.datasetNamePrefix', 'trident-ship')
      .trim()
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '');

    return `${prefix || 'trident-ship'}-${shipId}`;
  }

  listDatasetsByName(name: string): Promise<RagflowDataset[]> {
    return this.ragflowClient.listDatasetsByName(name);
  }

  listDatasets(input?: RagflowListDatasetsInput): Promise<RagflowDataset[]> {
    return this.ragflowClient.listDatasets(input);
  }

  findAccessibleDatasetById(id: string): Promise<RagflowDataset | null> {
    return this.findAccessibleDataset((dataset) => dataset.id === id);
  }

  findAccessibleDatasetByExactName(name: string): Promise<RagflowDataset | null> {
    return this.findAccessibleDataset((dataset) => dataset.name === name);
  }

  createDataset(input: RagflowCreateDatasetInput): Promise<RagflowDataset> {
    return this.ragflowClient.createDataset(input);
  }

  uploadDocumentToDataset(
    datasetId: string,
    file: RagflowDocumentUploadFile,
  ): Promise<RagflowDocument> {
    return this.ragflowClient.uploadDocumentToDataset(datasetId, file);
  }

  updateRemoteDocumentConfig(
    datasetId: string,
    documentId: string,
    input: RagflowRemoteDocumentConfigInput,
  ): Promise<RagflowDocument> {
    return this.ragflowClient.updateRemoteDocumentConfig(
      datasetId,
      documentId,
      input,
    );
  }

  triggerRemoteParse(datasetId: string, documentId: string): Promise<void> {
    return this.ragflowClient.triggerRemoteParse(datasetId, documentId);
  }

  fetchRemoteDocumentStatus(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowDocument | null> {
    return this.ragflowClient.fetchRemoteDocumentStatus(datasetId, documentId);
  }

  getDocumentParseProgressPercent(
    document: Pick<RagflowDocument, 'progress'>,
  ): number | null {
    return this.normalizeProgressPercent(document.progress);
  }

  deleteDocumentsFromDataset(
    datasetId: string,
    documentIds: string[],
  ): Promise<void> {
    return this.ragflowClient.deleteDocumentsFromDataset(datasetId, documentIds);
  }

  downloadDocumentFromDataset(
    datasetId: string,
    documentId: string,
  ): Promise<RagflowDocumentDownload> {
    return this.ragflowClient.downloadDocumentFromDataset(datasetId, documentId);
  }

  retrieveChunks(input: RagflowRetrievalInput): Promise<RagflowRetrievalResponse> {
    return this.ragflowClient.retrieveChunks(input);
  }

  private async findAccessibleDataset(
    predicate: (dataset: RagflowDataset) => boolean,
  ): Promise<RagflowDataset | null> {
    for (let page = 1; page <= this.datasetLookupMaxPages; page += 1) {
      const datasets = await this.listDatasets({
        page,
        pageSize: this.datasetLookupPageSize,
      });
      const matchedDataset = datasets.find(predicate);

      if (matchedDataset) {
        return matchedDataset;
      }

      if (datasets.length < this.datasetLookupPageSize) {
        return null;
      }
    }

    return null;
  }

  private normalizeProgressPercent(progress: number | undefined): number | null {
    if (typeof progress !== 'number' || !Number.isFinite(progress)) {
      return null;
    }

    const percent = progress <= 1 ? progress * 100 : progress;
    const boundedPercent = Math.max(0, Math.min(100, percent));
    return Math.round((boundedPercent + Number.EPSILON) * 100) / 100;
  }
}
