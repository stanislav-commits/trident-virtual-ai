import {
  SEMANTIC_ANSWER_FORMATS,
  SEMANTIC_CONCEPT_FAMILIES,
  SEMANTIC_INTENTS,
  SEMANTIC_PROFILE_SCHEMA_VERSION,
  SEMANTIC_SOURCE_CATEGORIES,
} from './semantic.constants';

const nullableString = { type: ['string', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;
const stringArray = {
  type: 'array',
  items: { type: 'string' },
} as const;

export const DOCUMENTATION_SEMANTIC_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'intent',
    'conceptFamily',
    'selectedConceptIds',
    'candidateConceptIds',
    'equipment',
    'systems',
    'vendor',
    'model',
    'sourcePreferences',
    'explicitSource',
    'pageHint',
    'sectionHint',
    'answerFormat',
    'needsClarification',
    'clarificationReason',
    'confidence',
  ],
  properties: {
    schemaVersion: {
      type: 'string',
      enum: [SEMANTIC_PROFILE_SCHEMA_VERSION],
    },
    intent: { type: 'string', enum: SEMANTIC_INTENTS },
    conceptFamily: { type: 'string', enum: SEMANTIC_CONCEPT_FAMILIES },
    selectedConceptIds: stringArray,
    candidateConceptIds: stringArray,
    equipment: stringArray,
    systems: stringArray,
    vendor: nullableString,
    model: nullableString,
    sourcePreferences: {
      type: 'array',
      items: { type: 'string', enum: SEMANTIC_SOURCE_CATEGORIES },
    },
    explicitSource: nullableString,
    pageHint: nullableInteger,
    sectionHint: nullableString,
    answerFormat: { type: 'string', enum: SEMANTIC_ANSWER_FORMATS },
    needsClarification: { type: 'boolean' },
    clarificationReason: nullableString,
    confidence: { type: 'number' },
  },
} as const;

const manualSemanticSectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'pageStart',
    'pageEnd',
    'conceptIds',
    'sectionType',
    'summary',
  ],
  properties: {
    title: { type: 'string' },
    pageStart: nullableInteger,
    pageEnd: nullableInteger,
    conceptIds: stringArray,
    sectionType: {
      type: 'string',
      enum: [
        'procedure',
        'checklist',
        'warning',
        'overview',
        'specification',
        'reference',
      ],
    },
    summary: { type: 'string' },
  },
} as const;

const manualSemanticPageTopicSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['page', 'conceptIds', 'summary'],
  properties: {
    page: { type: 'integer' },
    conceptIds: stringArray,
    summary: { type: 'string' },
  },
} as const;

export const MANUAL_SEMANTIC_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'documentType',
    'sourceCategory',
    'primaryConceptIds',
    'secondaryConceptIds',
    'systems',
    'equipment',
    'vendor',
    'model',
    'aliases',
    'summary',
    'sections',
    'pageTopics',
  ],
  properties: {
    schemaVersion: {
      type: 'string',
      enum: [SEMANTIC_PROFILE_SCHEMA_VERSION],
    },
    documentType: { type: 'string', enum: SEMANTIC_INTENTS },
    sourceCategory: {
      type: ['string', 'null'],
      enum: [...SEMANTIC_SOURCE_CATEGORIES, null],
    },
    primaryConceptIds: stringArray,
    secondaryConceptIds: stringArray,
    systems: stringArray,
    equipment: stringArray,
    vendor: nullableString,
    model: nullableString,
    aliases: stringArray,
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: manualSemanticSectionSchema,
    },
    pageTopics: {
      type: 'array',
      items: manualSemanticPageTopicSchema,
    },
  },
} as const;
