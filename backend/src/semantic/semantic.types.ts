import type {
  MANUAL_SEMANTIC_PROFILE_STATUSES,
  SEMANTIC_ANSWER_FORMATS,
  SEMANTIC_CONCEPT_FAMILIES,
  SEMANTIC_INTENTS,
  SEMANTIC_SOURCE_CATEGORIES,
} from './semantic.constants';

export type SemanticIntent = (typeof SEMANTIC_INTENTS)[number];
export type SemanticConceptFamily = (typeof SEMANTIC_CONCEPT_FAMILIES)[number];
export type SemanticSourceCategory =
  (typeof SEMANTIC_SOURCE_CATEGORIES)[number];
export type SemanticAnswerFormat = (typeof SEMANTIC_ANSWER_FORMATS)[number];
export type ManualSemanticProfileStatus =
  (typeof MANUAL_SEMANTIC_PROFILE_STATUSES)[number];

export interface ConceptDefinition {
  id: string;
  family: SemanticConceptFamily;
  label: string;
  description: string;
  aliases: string[];
  sourcePreferences: SemanticSourceCategory[];
  relatedSystems?: string[];
  relatedEquipment?: string[];
  relatedTags?: string[];
}

export interface ConceptCandidate {
  conceptId: string;
  label: string;
  family: SemanticConceptFamily;
  score: number;
}

export interface DocumentationSemanticQuery {
  schemaVersion: string;
  intent: SemanticIntent;
  conceptFamily: SemanticConceptFamily;
  selectedConceptIds: string[];
  candidateConceptIds: string[];
  equipment: string[];
  systems: string[];
  vendor: string | null;
  model: string | null;
  sourcePreferences: SemanticSourceCategory[];
  explicitSource: string | null;
  pageHint: number | null;
  sectionHint: string | null;
  answerFormat: SemanticAnswerFormat;
  needsClarification: boolean;
  clarificationReason: string | null;
  confidence: number;
}

export interface ManualSemanticSectionProfile {
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  conceptIds: string[];
  sectionType:
    | 'procedure'
    | 'checklist'
    | 'warning'
    | 'overview'
    | 'specification'
    | 'reference';
  summary: string;
}

export interface ManualSemanticPageTopic {
  page: number;
  conceptIds: string[];
  summary: string;
}

export interface ManualSemanticProfile {
  schemaVersion: string;
  documentType: SemanticIntent;
  sourceCategory: SemanticSourceCategory | null;
  primaryConceptIds: string[];
  secondaryConceptIds: string[];
  systems: string[];
  equipment: string[];
  vendor: string | null;
  model: string | null;
  aliases: string[];
  summary: string;
  sections: ManualSemanticSectionProfile[];
  pageTopics: ManualSemanticPageTopic[];
}

export interface DocumentationFollowUpState {
  schemaVersion: string;
  intent: SemanticIntent;
  conceptIds: string[];
  sourcePreferences: SemanticSourceCategory[];
  sourceLock: boolean;
  lockedManualId: string | null;
  lockedManualTitle: string | null;
  lockedDocumentId: string | null;
  pageHint: number | null;
  sectionHint: string | null;
  vendor: string | null;
  model: string | null;
  systems: string[];
  equipment: string[];
}

export interface DocumentationSemanticCandidate {
  manualId: string;
  documentId: string;
  filename: string;
  category: string | null;
  score: number;
  reasons: string[];
  semanticProfile?: ManualSemanticProfile | null;
}

export interface DocumentationRetrievalTrace {
  rawQuery: string;
  retrievalQuery: string;
  semanticIntent?: SemanticIntent;
  semanticConceptIds?: string[];
  semanticConfidence?: number;
  candidateConceptIds?: string[];
  sourcePreferences?: SemanticSourceCategory[];
  explicitSource?: string | null;
  lockedManualId?: string | null;
  lockedManualTitle?: string | null;
  sourceLockActive?: boolean;
  pageHint?: number | null;
  sectionHint?: string | null;
  shortlistedManualIds?: string[];
  shortlistedManualTitles?: string[];
  fallbackWideningUsed?: boolean;
}
