import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';
import {
  DOCUMENT_INTENT_PLANNER_VERSION,
  DocumentIntentAnswerMode,
  DocumentIntentEvidenceNeed,
  DocumentIntentEvidenceType,
  DocumentIntentMaintenanceIntent,
  DocumentIntentPlan,
  DocumentIntentRetrievalPurpose,
  DocumentIntentRetrievalQuery,
} from './document-intent-plan.types';

const ANSWER_MODES: readonly DocumentIntentAnswerMode[] = [
  'procedure',
  'schedule',
  'scope',
  'summary',
  'comparison',
  'troubleshooting',
  'factual',
  'unknown',
];
const MAINTENANCE_INTENTS: readonly DocumentIntentMaintenanceIntent[] = [
  'none',
  'next_due',
  'due_tasks',
  'work_scope',
  'history',
  'interval',
  'unknown',
];
const RETRIEVAL_PURPOSES: readonly DocumentIntentRetrievalPurpose[] = [
  'primary',
  'procedure',
  'schedule',
  'scope',
  'history',
  'fallback',
];
const EVIDENCE_TYPES: readonly DocumentIntentEvidenceType[] = [
  'procedure_steps',
  'schedule_item',
  'pms_record',
  'technical_spec',
  'definition',
  'unknown',
];
const EVIDENCE_NEEDS: readonly DocumentIntentEvidenceNeed[] = [
  'procedure_steps',
  'schedule_due',
  'task_list',
  'work_scope',
  'technical_reference',
  'summary',
  'unknown',
];
const DOCUMENT_CLASSES = Object.values(DocumentDocClass);
const MAX_TEXT_LENGTH = 180;
const MAX_REASONING_LENGTH = 500;
const MAX_RETRIEVAL_QUERY_LENGTH = 240;
const MAX_RETRIEVAL_QUERY_COUNT = 6;
const DEFAULT_CONFIDENCE = 0.5;

export function buildDefaultDocumentIntentPlan(
  fallbackReason: string | null = null,
): DocumentIntentPlan {
  return {
    plannerVersion: DOCUMENT_INTENT_PLANNER_VERSION,
    answerMode: 'unknown',
    maintenanceIntent: 'none',
    asksForSteps: false,
    asksForNextDueMaintenance: false,
    asksForDueTasks: false,
    asksForWorkScope: false,
    asksForHistory: false,
    equipmentMentioned: null,
    componentMentioned: null,
    operationMentioned: null,
    documentTitleHint: null,
    requireDocumentTitleMatch: false,
    targetDocClasses: [],
    retrievalQueries: [],
    evidenceNeed: 'unknown',
    answerFormattingHints: {
      structuredPms: false,
      showWorkScope: false,
      summarizeLongLists: true,
      separateTaskExistsFromProcedureSteps: true,
    },
    confidence: DEFAULT_CONFIDENCE,
    fallbackReason,
    reasoningSummary: '',
  };
}

export function normalizeDocumentIntentPlan(
  value: unknown,
  fallbackReason: string | null = null,
): DocumentIntentPlan {
  const entry =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const defaults = buildDefaultDocumentIntentPlan(fallbackReason);
  const formattingHints = normalizeFormattingHints(
    entry.answerFormattingHints,
    defaults.answerFormattingHints,
  );
  const hasMeaningfulContent = hasMeaningfulPlannerContent(entry);

  return {
    plannerVersion:
      normalizeText(entry.plannerVersion, 80) ??
      DOCUMENT_INTENT_PLANNER_VERSION,
    answerMode: normalizeEnum(entry.answerMode, ANSWER_MODES, 'unknown'),
    maintenanceIntent: normalizeEnum(
      entry.maintenanceIntent,
      MAINTENANCE_INTENTS,
      'none',
    ),
    asksForSteps: entry.asksForSteps === true,
    asksForNextDueMaintenance: entry.asksForNextDueMaintenance === true,
    asksForDueTasks: entry.asksForDueTasks === true,
    asksForWorkScope: entry.asksForWorkScope === true,
    asksForHistory: entry.asksForHistory === true,
    equipmentMentioned: normalizeText(entry.equipmentMentioned, MAX_TEXT_LENGTH),
    componentMentioned: normalizeText(entry.componentMentioned, MAX_TEXT_LENGTH),
    operationMentioned: normalizeText(entry.operationMentioned, MAX_TEXT_LENGTH),
    documentTitleHint: normalizeText(entry.documentTitleHint, MAX_TEXT_LENGTH),
    requireDocumentTitleMatch: entry.requireDocumentTitleMatch === true,
    targetDocClasses: normalizeDocumentClasses(entry.targetDocClasses),
    retrievalQueries: normalizeRetrievalQueries(entry.retrievalQueries),
    evidenceNeed: normalizeEnum(entry.evidenceNeed, EVIDENCE_NEEDS, 'unknown'),
    answerFormattingHints: formattingHints,
    confidence: normalizeConfidence(entry.confidence, hasMeaningfulContent),
    fallbackReason:
      normalizeText(entry.fallbackReason, MAX_REASONING_LENGTH) ?? fallbackReason,
    reasoningSummary:
      normalizeText(entry.reasoningSummary, MAX_REASONING_LENGTH) ?? '',
  };
}

function normalizeFormattingHints(
  value: unknown,
  defaults: DocumentIntentPlan['answerFormattingHints'],
): DocumentIntentPlan['answerFormattingHints'] {
  const entry =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    structuredPms:
      typeof entry.structuredPms === 'boolean'
        ? entry.structuredPms
        : defaults.structuredPms,
    showWorkScope:
      typeof entry.showWorkScope === 'boolean'
        ? entry.showWorkScope
        : defaults.showWorkScope,
    summarizeLongLists:
      typeof entry.summarizeLongLists === 'boolean'
        ? entry.summarizeLongLists
        : defaults.summarizeLongLists,
    separateTaskExistsFromProcedureSteps:
      typeof entry.separateTaskExistsFromProcedureSteps === 'boolean'
        ? entry.separateTaskExistsFromProcedureSteps
        : defaults.separateTaskExistsFromProcedureSteps,
  };
}

function normalizeRetrievalQueries(value: unknown): DocumentIntentRetrievalQuery[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const queries: DocumentIntentRetrievalQuery[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (queries.length >= MAX_RETRIEVAL_QUERY_COUNT) {
      break;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const query = normalizeText(entry.query, MAX_RETRIEVAL_QUERY_LENGTH);

    if (!query || query.length < 3) {
      continue;
    }

    const comparableQuery = query.toLocaleLowerCase();
    if (seen.has(comparableQuery)) {
      continue;
    }

    seen.add(comparableQuery);
    queries.push({
      purpose: normalizeEnum(entry.purpose, RETRIEVAL_PURPOSES, 'fallback'),
      query,
      candidateDocClasses: normalizeDocumentClasses(entry.candidateDocClasses),
      mustContainEvidenceType: normalizeEnum(
        entry.mustContainEvidenceType,
        EVIDENCE_TYPES,
        'unknown',
      ),
    });
  }

  return queries;
}

function normalizeDocumentClasses(value: unknown): DocumentDocClass[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.filter(
        (item): item is DocumentDocClass =>
          typeof item === 'string' &&
          DOCUMENT_CLASSES.includes(item as DocumentDocClass),
      ),
    ),
  );
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\s+/gu, ' ').trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

function normalizeConfidence(value: unknown, hasMeaningfulContent: boolean): number {
  if (value === null || value === undefined) {
    return hasMeaningfulContent ? DEFAULT_CONFIDENCE : 0;
  }

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.trim())
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return hasMeaningfulContent ? DEFAULT_CONFIDENCE : 0;
  }

  if (parsed === 0 && hasMeaningfulContent) {
    return DEFAULT_CONFIDENCE;
  }

  if (parsed > 1 && parsed <= 100) {
    return parsed / 100;
  }

  return Math.max(0, Math.min(1, parsed));
}

function hasMeaningfulPlannerContent(entry: Record<string, unknown>): boolean {
  return (
    normalizeEnum(entry.answerMode, ANSWER_MODES, 'unknown') !== 'unknown' ||
    !['none', 'unknown'].includes(
      normalizeEnum(entry.maintenanceIntent, MAINTENANCE_INTENTS, 'none'),
    ) ||
    entry.asksForSteps === true ||
    entry.asksForNextDueMaintenance === true ||
    entry.asksForDueTasks === true ||
    entry.asksForWorkScope === true ||
    entry.asksForHistory === true ||
    Boolean(normalizeText(entry.equipmentMentioned, MAX_TEXT_LENGTH)) ||
    Boolean(normalizeText(entry.componentMentioned, MAX_TEXT_LENGTH)) ||
    Boolean(normalizeText(entry.operationMentioned, MAX_TEXT_LENGTH)) ||
    normalizeDocumentClasses(entry.targetDocClasses).length > 0 ||
    normalizeRetrievalQueries(entry.retrievalQueries).length > 0 ||
    normalizeEnum(entry.evidenceNeed, EVIDENCE_NEEDS, 'unknown') !== 'unknown'
  );
}
