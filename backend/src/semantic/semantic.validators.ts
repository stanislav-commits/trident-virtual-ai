import {
  MANUAL_SEMANTIC_PROFILE_STATUSES,
  SEMANTIC_ANSWER_FORMATS,
  SEMANTIC_CONCEPT_FAMILIES,
  SEMANTIC_INTENTS,
  SEMANTIC_PROFILE_SCHEMA_VERSION,
  SEMANTIC_SOURCE_CATEGORIES,
} from './semantic.constants';
import type {
  ConceptDefinition,
  DocumentationFollowUpState,
  DocumentationSemanticQuery,
  ManualSemanticProfile,
  ManualSemanticProfileStatus,
  ManualSemanticSectionProfile,
  ManualSemanticPageTopic,
} from './semantic.types';

const MAX_SECTION_ITEMS = 16;
const MAX_PAGE_TOPIC_ITEMS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown, maxItems = 24): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: string[] = [];
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized || items.includes(normalized)) {
      continue;
    }
    items.push(normalized);
    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return 0;
}

function normalizeEnumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }

  return (allowed.find((entry) => entry === normalized) ??
    fallback) as T[number];
}

function normalizeSourceCategories(value: unknown) {
  const items = normalizeStringArray(value, 8);
  return items.filter(
    (item): item is (typeof SEMANTIC_SOURCE_CATEGORIES)[number] =>
      (SEMANTIC_SOURCE_CATEGORIES as readonly string[]).includes(item),
  );
}

function normalizeSectionProfile(
  value: unknown,
): ManualSemanticSectionProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const title = normalizeString(value.title);
  const summary = normalizeString(value.summary);
  if (!title || !summary) {
    return null;
  }

  return {
    title,
    summary,
    pageStart: normalizeNumber(value.pageStart),
    pageEnd: normalizeNumber(value.pageEnd),
    conceptIds: normalizeStringArray(value.conceptIds, 12),
    sectionType: normalizeEnumValue(
      value.sectionType,
      [
        'procedure',
        'checklist',
        'warning',
        'overview',
        'specification',
        'reference',
      ] as const,
      'overview',
    ),
  };
}

function normalizePageTopic(value: unknown): ManualSemanticPageTopic | null {
  if (!isRecord(value)) {
    return null;
  }

  const page = normalizeNumber(value.page);
  const summary = normalizeString(value.summary);
  if (page == null || !summary) {
    return null;
  }

  return {
    page,
    summary,
    conceptIds: normalizeStringArray(value.conceptIds, 12),
  };
}

export function parseDocumentationSemanticQuery(
  value: unknown,
): DocumentationSemanticQuery | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    schemaVersion:
      normalizeString(value.schemaVersion) ?? SEMANTIC_PROFILE_SCHEMA_VERSION,
    intent: normalizeEnumValue(
      value.intent,
      SEMANTIC_INTENTS,
      'general_information',
    ),
    conceptFamily: normalizeEnumValue(
      value.conceptFamily,
      SEMANTIC_CONCEPT_FAMILIES,
      'general_reference',
    ),
    selectedConceptIds: normalizeStringArray(value.selectedConceptIds, 8),
    candidateConceptIds: normalizeStringArray(value.candidateConceptIds, 16),
    equipment: normalizeStringArray(value.equipment, 12),
    systems: normalizeStringArray(value.systems, 12),
    vendor: normalizeString(value.vendor),
    model: normalizeString(value.model),
    sourcePreferences: normalizeSourceCategories(value.sourcePreferences),
    explicitSource: normalizeString(value.explicitSource),
    pageHint: normalizeNumber(value.pageHint),
    sectionHint: normalizeString(value.sectionHint),
    answerFormat: normalizeEnumValue(
      value.answerFormat,
      SEMANTIC_ANSWER_FORMATS,
      'direct_answer',
    ),
    needsClarification: value.needsClarification === true,
    clarificationReason: normalizeString(value.clarificationReason),
    confidence: normalizeConfidence(value.confidence),
  };
}

export function parseManualSemanticProfile(
  value: unknown,
): ManualSemanticProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const summary = normalizeString(value.summary);
  if (!summary) {
    return null;
  }

  return {
    schemaVersion:
      normalizeString(value.schemaVersion) ?? SEMANTIC_PROFILE_SCHEMA_VERSION,
    documentType: normalizeEnumValue(
      value.documentType,
      SEMANTIC_INTENTS,
      'manual_lookup',
    ),
    sourceCategory:
      normalizeSourceCategories([value.sourceCategory])[0] ?? null,
    primaryConceptIds: normalizeStringArray(value.primaryConceptIds, 8),
    secondaryConceptIds: normalizeStringArray(value.secondaryConceptIds, 12),
    systems: normalizeStringArray(value.systems, 12),
    equipment: normalizeStringArray(value.equipment, 12),
    vendor: normalizeString(value.vendor),
    model: normalizeString(value.model),
    aliases: normalizeStringArray(value.aliases, 24),
    summary,
    sections: (Array.isArray(value.sections) ? value.sections : [])
      .map((section) => normalizeSectionProfile(section))
      .filter((section): section is ManualSemanticSectionProfile =>
        Boolean(section),
      )
      .slice(0, MAX_SECTION_ITEMS),
    pageTopics: (Array.isArray(value.pageTopics) ? value.pageTopics : [])
      .map((entry) => normalizePageTopic(entry))
      .filter((entry): entry is ManualSemanticPageTopic => Boolean(entry))
      .slice(0, MAX_PAGE_TOPIC_ITEMS),
  };
}

export function parseDocumentationFollowUpState(
  value: unknown,
): DocumentationFollowUpState | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    schemaVersion:
      normalizeString(value.schemaVersion) ?? SEMANTIC_PROFILE_SCHEMA_VERSION,
    intent: normalizeEnumValue(
      value.intent,
      SEMANTIC_INTENTS,
      'general_information',
    ),
    conceptIds: normalizeStringArray(value.conceptIds, 8),
    sourcePreferences: normalizeSourceCategories(value.sourcePreferences),
    sourceLock: value.sourceLock === true,
    lockedManualId: normalizeString(value.lockedManualId),
    lockedManualTitle: normalizeString(value.lockedManualTitle),
    lockedDocumentId: normalizeString(value.lockedDocumentId),
    pageHint: normalizeNumber(value.pageHint),
    sectionHint: normalizeString(value.sectionHint),
    vendor: normalizeString(value.vendor),
    model: normalizeString(value.model),
    systems: normalizeStringArray(value.systems, 12),
    equipment: normalizeStringArray(value.equipment, 12),
  };
}

export function normalizeManualSemanticProfileStatus(
  value: unknown,
): ManualSemanticProfileStatus {
  return normalizeEnumValue(value, MANUAL_SEMANTIC_PROFILE_STATUSES, 'pending');
}

export function serializeConceptCatalogEntry(
  concept: ConceptDefinition,
): string {
  const aliases =
    concept.aliases.length > 0
      ? ` aliases=[${concept.aliases.join(', ')}]`
      : '';
  const sources =
    concept.sourcePreferences.length > 0
      ? ` sources=[${concept.sourcePreferences.join(', ')}]`
      : '';
  return `${concept.id} (${concept.family}) - ${concept.label}: ${concept.description}${aliases}${sources}`;
}
