import { SourceReferenceDto } from '../../../common/dto/source-reference.dto';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentParseProfile } from '../enums/document-parse-profile.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';

export type DocumentRetrievalEvidenceQuality = 'strong' | 'weak' | 'none';

export type DocumentRetrievalMetadataMode =
  | 'document_ids_from_local_metadata'
  | 'local_rerank_only'
  | 'not_requested';

export class DocumentRetrievalAppliedFiltersDto {
  shipDatasetId!: string | null;
  parseStatus!: 'parsed';
  candidateDocClasses!: DocumentDocClass[];
  questionType!: DocumentRetrievalQuestionType | null;
  ragflowDocumentIds!: string[];
  metadataMode!: DocumentRetrievalMetadataMode;
  metadataFiltering!: 'local_only';
  hints!: {
    equipmentOrSystem: string[];
    manufacturer: string[];
    model: string[];
    contentFocus: string[];
    language: string | null;
  };
  topK!: number;
  candidateK!: number;
  allowMultiDocument!: boolean;
  allowWeakEvidence!: boolean;
}

export class DocumentRetrievalMetadataSummaryDto {
  equipmentOrSystem!: string | null;
  manufacturer!: string | null;
  model!: string | null;
  revision!: string | null;
  language!: string | null;
  timeScope!: string;
  sourcePriority!: number;
  contentFocus!: string | null;
}

export class DocumentRetrievalResultDto {
  rank!: number;
  documentId!: string;
  ragflowDocumentId!: string;
  chunkId!: string;
  filename!: string;
  docClass!: DocumentDocClass;
  parseProfile!: DocumentParseProfile;
  page!: number | null;
  section!: string | null;
  snippet!: string;
  highlightedSnippet!: string | null;
  retrievalScore!: number | null;
  vectorSimilarity!: number | null;
  termSimilarity!: number | null;
  rerankScore!: number;
  metadataSummary!: DocumentRetrievalMetadataSummaryDto;
}

export class DocumentRetrievalResponseDto {
  normalizedQuestion!: string;
  shipId!: string;
  appliedFilters!: DocumentRetrievalAppliedFiltersDto;
  evidenceQuality!: DocumentRetrievalEvidenceQuality;
  answerability!: {
    status: DocumentRetrievalEvidenceQuality;
    reason: string;
  };
  results!: DocumentRetrievalResultDto[];
  references!: SourceReferenceDto[];
  diagnostics!: {
    usableDocumentCount: number;
    retrievedCandidateCount: number;
    enrichedCandidateCount: number;
    ragflowTotal: number | null;
    metadataFilteringSupported: 'api_available_but_not_enabled_in_trident';
  };
  summary!: string;
  data!: Record<string, unknown>;
}
