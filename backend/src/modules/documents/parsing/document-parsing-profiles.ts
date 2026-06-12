import { DocumentChunkMethod } from '../enums/document-chunk-method.enum';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentParseProfile } from '../enums/document-parse-profile.enum';

export interface RagflowParserConfigPayload {
  layout_recognize: string;
  auto_keywords: number;
  auto_questions: number;
  raptor: {
    use_raptor: false;
  };
  graphrag: {
    use_graphrag: false;
  };
  chunk_token_num?: number;
  delimiter?: string;
  task_page_size?: number;
  table_context_size?: number;
  image_context_size?: number;
  tag_kb_ids?: string[];
  enable_metadata?: false;
}

export const MANUAL_STABLE_FALLBACK_PROFILE = 'manual_stable' as const;

export type DocumentFallbackParseProfile =
  typeof MANUAL_STABLE_FALLBACK_PROFILE;

export interface DocumentParsingProfileDefinition {
  parseProfile: DocumentParseProfile;
  chunkMethod: DocumentChunkMethod;
  ragflowChunkMethod: 'manual' | 'naive';
  pdfParser: 'DeepDOC';
  autoKeywords: number;
  autoQuestions: number;
  chunkSize: number | null;
  delimiter: string | null;
  overlapPercent: number | null;
  pageIndexEnabled: boolean;
  childChunksEnabled: boolean;
  imageTableContextWindow: number | null;
  taskPageSize: number | null;
  tableContextSize: number | null;
  imageContextSize: number | null;
}

export interface DocumentFallbackParsingProfileDefinition
  extends Omit<DocumentParsingProfileDefinition, 'parseProfile'> {
  parseProfile: DocumentFallbackParseProfile;
}

export type RagflowParsingProfileDefinition =
  | DocumentParsingProfileDefinition
  | DocumentFallbackParsingProfileDefinition;

const BASE_PROFILE_FLAGS = {
  pdfParser: 'DeepDOC',
  overlapPercent: null,
  pageIndexEnabled: false,
  childChunksEnabled: false,
  taskPageSize: null,
  tableContextSize: null,
  imageContextSize: null,
} as const;

const PROFILE_DEFINITIONS: Record<
  DocumentParseProfile,
  DocumentParsingProfileDefinition
> = {
  [DocumentParseProfile.MANUAL_LONG]: {
    parseProfile: DocumentParseProfile.MANUAL_LONG,
    chunkMethod: DocumentChunkMethod.MANUAL,
    ragflowChunkMethod: 'manual',
    ...BASE_PROFILE_FLAGS,
    autoKeywords: 4,
    autoQuestions: 1,
    chunkSize: null,
    delimiter: null,
    imageTableContextWindow: null,
  },
  [DocumentParseProfile.PROCEDURE_BUNKERING]: {
    parseProfile: DocumentParseProfile.PROCEDURE_BUNKERING,
    chunkMethod: DocumentChunkMethod.GENERAL,
    ragflowChunkMethod: 'naive',
    ...BASE_PROFILE_FLAGS,
    autoKeywords: 3,
    autoQuestions: 2,
    chunkSize: 768,
    delimiter: '\n',
    overlapPercent: 0,
    imageTableContextWindow: 0,
    tableContextSize: 0,
    imageContextSize: 0,
  },
  [DocumentParseProfile.SAFETY_HARD_PARSE]: {
    parseProfile: DocumentParseProfile.SAFETY_HARD_PARSE,
    chunkMethod: DocumentChunkMethod.GENERAL,
    ragflowChunkMethod: 'naive',
    ...BASE_PROFILE_FLAGS,
    autoKeywords: 2,
    autoQuestions: 1,
    chunkSize: 384,
    delimiter: '\n',
    overlapPercent: 0,
    imageTableContextWindow: 0,
    tableContextSize: 0,
    imageContextSize: 0,
  },
  [DocumentParseProfile.REGULATION_BASELINE]: {
    parseProfile: DocumentParseProfile.REGULATION_BASELINE,
    chunkMethod: DocumentChunkMethod.GENERAL,
    ragflowChunkMethod: 'naive',
    ...BASE_PROFILE_FLAGS,
    autoKeywords: 2,
    autoQuestions: 0,
    chunkSize: 512,
    delimiter: '\n',
    overlapPercent: 0,
    imageTableContextWindow: 0,
    tableContextSize: 0,
    imageContextSize: 0,
  },
};

const MANUAL_STABLE_PROFILE_DEFINITION: DocumentFallbackParsingProfileDefinition =
  {
    parseProfile: MANUAL_STABLE_FALLBACK_PROFILE,
    chunkMethod: DocumentChunkMethod.MANUAL,
    ragflowChunkMethod: 'manual',
    ...BASE_PROFILE_FLAGS,
    autoKeywords: 6,
    autoQuestions: 0,
    chunkSize: 384,
    delimiter: '\n',
    imageTableContextWindow: null,
    taskPageSize: 6,
    tableContextSize: 256,
    imageContextSize: 128,
  };

const DOC_CLASS_PROFILE_MAP: Record<DocumentDocClass, DocumentParseProfile> = {
  [DocumentDocClass.MANUAL]: DocumentParseProfile.MANUAL_LONG,
  [DocumentDocClass.HISTORICAL_PROCEDURE]:
    DocumentParseProfile.PROCEDURE_BUNKERING,
  [DocumentDocClass.CERTIFICATE]: DocumentParseProfile.SAFETY_HARD_PARSE,
  [DocumentDocClass.REGULATION]: DocumentParseProfile.REGULATION_BASELINE,
};

/**
 * Vision-extracted markdown: RAGFlow's 'manual' chunker only accepts
 * pdf/docx, so extracts parse with the naive text chunker. Keyword/
 * question enrichment mirrors MANUAL_LONG since the content IS a manual.
 */
const EXTRACTED_MARKDOWN_PROFILE: DocumentParsingProfileDefinition = {
  parseProfile: DocumentParseProfile.MANUAL_LONG,
  chunkMethod: DocumentChunkMethod.GENERAL,
  ragflowChunkMethod: 'naive',
  ...BASE_PROFILE_FLAGS,
  autoKeywords: 4,
  autoQuestions: 1,
  chunkSize: 1024,
  delimiter: '\n',
  overlapPercent: 0,
  imageTableContextWindow: 0,
};

export function getParsingProfileForExtractedMarkdown(): DocumentParsingProfileDefinition {
  return EXTRACTED_MARKDOWN_PROFILE;
}

export function getParsingProfileForDocClass(
  docClass: DocumentDocClass,
): DocumentParsingProfileDefinition {
  return PROFILE_DEFINITIONS[DOC_CLASS_PROFILE_MAP[docClass]];
}

export function getManualStableFallbackProfile(): DocumentFallbackParsingProfileDefinition {
  return MANUAL_STABLE_PROFILE_DEFINITION;
}

export function buildRagflowParserConfig(
  profile: RagflowParsingProfileDefinition,
): RagflowParserConfigPayload {
  const payload: RagflowParserConfigPayload = {
    layout_recognize: profile.pdfParser,
    auto_keywords: profile.autoKeywords,
    auto_questions: profile.autoQuestions,
    raptor: { use_raptor: false },
    graphrag: { use_graphrag: false },
    tag_kb_ids: [],
    enable_metadata: false,
  };

  if (profile.chunkSize !== null) {
    payload.chunk_token_num = profile.chunkSize;
  }

  if (profile.delimiter !== null) {
    payload.delimiter = profile.delimiter;
  }

  if (profile.taskPageSize !== null) {
    payload.task_page_size = profile.taskPageSize;
  }

  const tableContextSize =
    profile.tableContextSize ?? profile.imageTableContextWindow;
  const imageContextSize =
    profile.imageContextSize ?? profile.imageTableContextWindow;

  if (tableContextSize !== null) {
    payload.table_context_size = tableContextSize;
  }

  if (imageContextSize !== null) {
    payload.image_context_size = imageContextSize;
  }

  return payload;
}

export function buildEffectiveParserConfig(
  profile: RagflowParsingProfileDefinition,
): Record<string, unknown> {
  return {
    parseProfile: profile.parseProfile,
    chunkMethod: profile.chunkMethod,
    ragflowChunkMethod: profile.ragflowChunkMethod,
    pdfParser: profile.pdfParser,
    autoKeywords: profile.autoKeywords,
    autoQuestions: profile.autoQuestions,
    chunkSize: profile.chunkSize,
    delimiter: profile.delimiter,
    overlapPercent: profile.overlapPercent,
    pageIndexEnabled: profile.pageIndexEnabled,
    childChunksEnabled: profile.childChunksEnabled,
    imageTableContextWindow: profile.imageTableContextWindow,
    taskPageSize: profile.taskPageSize,
    tableContextSize: profile.tableContextSize,
    imageContextSize: profile.imageContextSize,
    ragflowParserConfig: buildRagflowParserConfig(profile),
  };
}
