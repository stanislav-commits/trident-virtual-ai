import { DocumentParsingProfileDefinition } from '../../modules/documents/parsing/document-parsing-profiles';

export interface RagflowDataset {
  id: string;
  name: string;
  description?: string | null;
  document_count?: number;
  chunk_count?: number;
}

export interface RagflowDocument {
  id: string;
  name: string;
  dataset_id?: string;
  chunk_method?: string;
  parser_config?: Record<string, unknown>;
  size?: number;
  token_count?: number;
  chunk_count?: number;
  progress?: number;
  progress_msg?: string;
  run?: string;
  status?: string;
}

export interface RagflowDocumentUploadFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

export interface RagflowDocumentDownload {
  buffer: Buffer;
  contentType: string | null;
}

export interface RagflowCreateDatasetInput {
  name: string;
  description?: string;
}

export interface RagflowListDatasetsInput {
  page?: number;
  pageSize?: number;
}

export interface RagflowRemoteDocumentConfigInput {
  metadata: Record<string, unknown>;
  parsingProfile: DocumentParsingProfileDefinition;
}

export interface RagflowDocumentListResponse {
  total: number;
  docs: RagflowDocument[];
}
