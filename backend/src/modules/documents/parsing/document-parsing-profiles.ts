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
  table_context_size?: number;
  image_context_size?: number;
  tag_kb_ids?: string[];
  enable_metadata?: false;
}

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
}

const BASE_PROFILE_FLAGS = {
  pdfParser: 'DeepDOC',
  overlapPercent: null,
  pageIndexEnabled: false,
  childChunksEnabled: false,
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
    chunkMethod: DocumentChunkMethod.MANUAL,
    ragflowChunkMethod: 'manual',
    ...BASE_PROFILE_FLAGS,
    autoKeywords: 3,
    autoQuestions: 2,
    chunkSize: null,
    delimiter: null,
    imageTableContextWindow: null,
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
  },
};

const DOC_CLASS_PROFILE_MAP: Record<DocumentDocClass, DocumentParseProfile> = {
  [DocumentDocClass.MANUAL]: DocumentParseProfile.MANUAL_LONG,
  [DocumentDocClass.HISTORICAL_PROCEDURE]:
    DocumentParseProfile.PROCEDURE_BUNKERING,
  [DocumentDocClass.CERTIFICATE]: DocumentParseProfile.SAFETY_HARD_PARSE,
  [DocumentDocClass.REGULATION]: DocumentParseProfile.REGULATION_BASELINE,
};

export function getParsingProfileForDocClass(
  docClass: DocumentDocClass,
): DocumentParsingProfileDefinition {
  return PROFILE_DEFINITIONS[DOC_CLASS_PROFILE_MAP[docClass]];
}

export function buildRagflowParserConfig(
  profile: DocumentParsingProfileDefinition,
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

  if (profile.imageTableContextWindow !== null) {
    payload.table_context_size = profile.imageTableContextWindow;
    payload.image_context_size = profile.imageTableContextWindow;
  }

  return payload;
}

export function buildEffectiveParserConfig(
  profile: DocumentParsingProfileDefinition,
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
    ragflowParserConfig: buildRagflowParserConfig(profile),
  };
}
