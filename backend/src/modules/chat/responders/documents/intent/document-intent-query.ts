import { DocumentIntentPlan } from './document-intent-plan.types';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';

const MAX_PLANNED_SEARCH_QUESTION_LENGTH = 360;
const MIN_PLANNER_CONFIDENCE_FOR_QUERY = 0.2;

export function buildDocumentIntentSearchQuestion(input: {
  baseSearchQuestion: string;
  intentPlan?: DocumentIntentPlan | null;
}): string {
  const plan = input.intentPlan;

  if (!plan || plan.confidence < MIN_PLANNER_CONFIDENCE_FOR_QUERY) {
    return normalizeWhitespace(input.baseSearchQuestion);
  }

  const parts = [
    input.baseSearchQuestion,
    ...plan.retrievalQueries.map((query) => query.query),
    ...buildComponentOperationQueries(plan),
    ...buildTechnicalReferenceQueries(plan),
    ...buildMaintenanceRecordQueries(plan),
  ];

  return limitSearchQuestionLength(appendUniqueSearchParts(parts));
}

export function hasUsablePlannedRetrievalQuery(
  intentPlan: DocumentIntentPlan | null | undefined,
): boolean {
  return Boolean(
    intentPlan &&
      intentPlan.confidence >= MIN_PLANNER_CONFIDENCE_FOR_QUERY &&
      (intentPlan.retrievalQueries.length > 0 ||
        intentPlan.componentMentioned ||
        intentPlan.operationMentioned),
  );
}

function buildComponentOperationQueries(plan: DocumentIntentPlan): string[] {
  if (
    plan.answerMode !== 'procedure' &&
    !plan.asksForSteps &&
    plan.evidenceNeed !== 'procedure_steps'
  ) {
    return [];
  }

  const equipment = plan.equipmentMentioned;
  const component = plan.componentMentioned;
  const operation = plan.operationMentioned;

  if (!component && !operation) {
    return [];
  }

  const subject = joinTerms([equipment, component]);
  const operationSubject = joinTerms([operation, component, equipment]);
  const queries = [
    joinTerms([subject, operation, 'procedure']),
    operationSubject,
  ];

  if (hasExplicitMaintenanceProcedureContext(plan)) {
    queries.push(
      joinTerms(['service', component, equipment]),
      joinTerms(['maintenance', component, operation]),
    );
  }

  return queries.filter(Boolean);
}

function hasExplicitMaintenanceProcedureContext(plan: DocumentIntentPlan): boolean {
  const text = normalizeComparableText(
    [
      plan.equipmentMentioned,
      plan.componentMentioned,
      plan.operationMentioned,
      ...plan.retrievalQueries.map((query) => query.query),
    ]
      .filter(Boolean)
      .join(' '),
  );

  return (
    !['none', 'unknown'].includes(plan.maintenanceIntent) ||
    ['schedule_due', 'task_list', 'work_scope'].includes(plan.evidenceNeed) ||
    /\b(?:maintenance|pms|service|servicing|inspection|overhaul)\b/u.test(text)
  );
}

function buildTechnicalReferenceQueries(plan: DocumentIntentPlan): string[] {
  if (
    plan.evidenceNeed !== 'technical_reference' &&
    plan.answerMode !== 'factual' &&
    plan.answerMode !== 'troubleshooting'
  ) {
    return [];
  }

  const equipment = plan.equipmentMentioned;
  const component = plan.componentMentioned;
  const operation = plan.operationMentioned;
  const subject = joinTerms([equipment, component]);

  if (!subject && !operation) {
    return [];
  }

  const queries = [
    joinTerms([subject, operation, 'manual']),
    joinTerms([subject, operation, 'technical reference']),
    joinTerms([subject, operation, 'safety warning caution']),
    joinTerms([subject, operation, 'check inspect verify before']),
  ];

  if (plan.answerMode === 'troubleshooting') {
    queries.push(joinTerms([subject, operation, 'troubleshooting fault finding section']));
  }

  if (isMaintenanceSectionLookup(plan)) {
    queries.push(joinTerms([subject, operation, 'maintenance section manual table']));
  }

  return queries.filter(Boolean);
}

function isMaintenanceSectionLookup(plan: DocumentIntentPlan): boolean {
  const text = normalizeComparableText(
    [
      plan.componentMentioned,
      plan.operationMentioned,
      ...plan.retrievalQueries.map((query) => query.query),
    ]
      .filter(Boolean)
      .join(' '),
  );

  return /\bmaintenance\s+(?:section|chapter|table)\b/u.test(text);
}

function buildMaintenanceRecordQueries(plan: DocumentIntentPlan): string[] {
  if (isManualProcedureIntent(plan)) {
    return [];
  }

  const hasMaintenanceIntent =
    plan.answerFormattingHints.structuredPms ||
    !['none', 'unknown'].includes(plan.maintenanceIntent) ||
    ['schedule_due', 'task_list', 'work_scope'].includes(plan.evidenceNeed);

  if (!hasMaintenanceIntent) {
    return [];
  }

  const equipment = plan.equipmentMentioned;
  const base = joinTerms([equipment, 'maintenance record PMS']);

  if (plan.asksForWorkScope || plan.maintenanceIntent === 'work_scope') {
    return [
      joinTerms([base, 'work scope tasks included']),
      joinTerms([base, 'task scope due schedule']),
    ].filter(Boolean);
  }

  if (plan.asksForDueTasks || plan.maintenanceIntent === 'due_tasks') {
    return [
      joinTerms([base, 'due tasks status schedule']),
      joinTerms([base, 'task list current hours next due']),
    ].filter(Boolean);
  }

  return [
    joinTerms([base, 'next due schedule status']),
    joinTerms([base, 'current hours next due remaining']),
  ].filter(Boolean);
}

function isManualProcedureIntent(plan: DocumentIntentPlan): boolean {
  return (
    plan.targetDocClasses.includes(DocumentDocClass.MANUAL) &&
    !plan.targetDocClasses.includes(DocumentDocClass.HISTORICAL_PROCEDURE) &&
    (plan.asksForSteps ||
      plan.answerMode === 'procedure' ||
      plan.evidenceNeed === 'procedure_steps')
  );
}

function appendUniqueSearchParts(parts: string[]): string {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const normalized = normalizeWhitespace(part);
    const comparable = normalizeComparableText(normalized);

    if (!normalized || !comparable || seen.has(comparable)) {
      continue;
    }

    kept.push(normalized);
    seen.add(comparable);
  }

  return normalizeWhitespace(kept.join(' '));
}

function limitSearchQuestionLength(value: string): string {
  if (value.length <= MAX_PLANNED_SEARCH_QUESTION_LENGTH) {
    return value;
  }

  const words = value.split(/\s+/u);
  const kept: string[] = [];
  let length = 0;

  for (const word of words) {
    const nextLength = length + (kept.length ? 1 : 0) + word.length;

    if (nextLength > MAX_PLANNED_SEARCH_QUESTION_LENGTH) {
      break;
    }

    kept.push(word);
    length = nextLength;
  }

  return kept.join(' ');
}

function joinTerms(values: Array<string | null | undefined>): string {
  return normalizeWhitespace(values.filter(Boolean).join(' '));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeComparableText(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ');
}
