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

export interface RagflowRetrievalInput {
  question: string;
  datasetIds?: string[];
  documentIds?: string[];
  page?: number;
  pageSize?: number;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  topK?: number;
  rerankId?: string;
  keyword?: boolean;
  highlight?: boolean;
  crossLanguages?: string[];
}

export interface RagflowRetrievalChunk {
  id: string;
  content?: string;
  content_ltks?: string;
  document_id?: string;
  document_keyword?: string;
  docnm_kwd?: string;
  highlight?: string;
  image_id?: string;
  important_keywords?: string[] | string;
  kb_id?: string;
  positions?: unknown[];
  similarity?: number;
  term_similarity?: number;
  vector_similarity?: number;
}

export interface RagflowRetrievalDocumentAggregation {
  count: number;
  doc_id: string;
  doc_name: string;
}

export interface RagflowRetrievalResponse {
  chunks: RagflowRetrievalChunk[];
  doc_aggs?: RagflowRetrievalDocumentAggregation[];
  total?: number;
}
