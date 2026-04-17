export const SEMANTIC_PROFILE_SCHEMA_VERSION = '2026-04-06.semantic-v2';

export const SEMANTIC_INTENTS = [
  'manual_lookup',
  'maintenance_procedure',
  'operational_procedure',
  'troubleshooting',
  'parts_lookup',
  'regulation_compliance',
  'certificate_lookup',
  'general_information',
] as const;

export const SEMANTIC_CONCEPT_FAMILIES = [
  'asset_system',
  'maintenance_topic',
  'operational_topic',
  'regulation_topic',
  'certificate_topic',
  'general_reference',
] as const;

export const SEMANTIC_SOURCE_CATEGORIES = [
  'MANUALS',
  'HISTORY_PROCEDURES',
  'REGULATION',
  'CERTIFICATES',
] as const;

export const SEMANTIC_ANSWER_FORMATS = [
  'direct_answer',
  'summary',
  'step_by_step',
  'checklist',
  'comparison',
  'table',
] as const;

export const MANUAL_SEMANTIC_PROFILE_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
] as const;

export const SEMANTIC_QUERY_CLARIFICATION_THRESHOLD = 0.62;
export const SEMANTIC_QUERY_SOURCE_LOCK_THRESHOLD = 0.84;
export const MANUAL_SEMANTIC_ENRICHMENT_MAX_CHUNKS = 120;
export const MANUAL_SEMANTIC_ENRICHMENT_MAX_CHARS = 28_000;
export const MANUAL_SEMANTIC_ENRICHMENT_CONCEPT_MIN_SCORE = 8;
export const MANUAL_SEMANTIC_PROFILE_MAX_SECTIONS = 12;
export const MANUAL_SEMANTIC_PROFILE_MAX_PAGE_TOPICS = 16;
export const MANUAL_SEMANTIC_PROFILE_MAX_LIST_ITEMS = 16;
