import { DocumentRetrievalResponseDto } from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';
import { DocumentIntentPlan } from '../intent/document-intent-plan.types';
import { shouldRequireProcedureStepEvidence } from '../grounding/document-procedure-evidence';
import { DocumentGroundedAnswerStyle } from './document-grounded-answer-prompt';

export function shouldUseStructuredMaintenanceRecordAnswer(input: {
  userQuestion: string;
  retrieval: DocumentRetrievalResponseDto;
  intentPlan: DocumentIntentPlan | null;
  legacyMaintenanceIntent: boolean;
}): boolean {
  const effectiveIntentPlan = getEffectiveIntentPlan(input.intentPlan);
  const hasPlannerMaintenanceIntent = Boolean(
    effectiveIntentPlan &&
      (effectiveIntentPlan.answerFormattingHints.structuredPms ||
        effectiveIntentPlan.maintenanceIntent !== 'none' ||
        effectiveIntentPlan.targetDocClasses.includes(
          DocumentDocClass.HISTORICAL_PROCEDURE,
        )),
  );
  const hasMaintenanceIntent = effectiveIntentPlan
    ? hasPlannerMaintenanceIntent
    : input.legacyMaintenanceIntent;

  return (
    hasMaintenanceIntent &&
    input.retrieval.results.some(
      (result) =>
        result.docClass === DocumentDocClass.HISTORICAL_PROCEDURE &&
        isMaintenanceRecordEvidence(result.snippet),
    )
  );
}

export function buildDocumentAnswerStyle(input: {
  structuredMaintenanceRecord: boolean;
  intentPlan: DocumentIntentPlan | null;
}): DocumentGroundedAnswerStyle {
  const effectiveIntentPlan = getEffectiveIntentPlan(input.intentPlan);
  const procedureEvidenceRequired =
    shouldRequireProcedureStepEvidence(effectiveIntentPlan);
  const maintenanceTaskSelection = effectiveIntentPlan
    ? effectiveIntentPlan.asksForNextDueMaintenance ||
      effectiveIntentPlan.asksForDueTasks ||
      effectiveIntentPlan.maintenanceIntent === 'next_due' ||
      effectiveIntentPlan.maintenanceIntent === 'due_tasks'
    : undefined;
  const showWorkScope = effectiveIntentPlan
    ? maintenanceTaskSelection ||
      effectiveIntentPlan.asksForWorkScope ||
      effectiveIntentPlan.answerMode === 'scope' ||
      effectiveIntentPlan.maintenanceIntent === 'work_scope' ||
      effectiveIntentPlan.answerFormattingHints.showWorkScope
    : true;

  return {
    structuredMaintenanceRecord: input.structuredMaintenanceRecord,
    showWorkScope,
    summarizeLongLists:
      effectiveIntentPlan?.answerFormattingHints.summarizeLongLists ?? true,
    separateTaskExistsFromProcedureSteps:
      effectiveIntentPlan?.answerFormattingHints
        .separateTaskExistsFromProcedureSteps ?? true,
    maintenanceIntent: effectiveIntentPlan?.maintenanceIntent ?? 'unknown',
    procedureEvidenceRequired,
    maintenanceTaskSelection,
  };
}

function getEffectiveIntentPlan(
  intentPlan: DocumentIntentPlan | null,
): DocumentIntentPlan | null {
  return intentPlan && intentPlan.confidence >= 0.2 ? intentPlan : null;
}

function isMaintenanceRecordEvidence(snippet: string): boolean {
  const normalized = snippet.toLocaleLowerCase();
  const structuredFieldCount = [
    'task_name:',
    'last_completed_date:',
    'last_completed_hours:',
    'next_due_date:',
    'next_due_hours:',
    'current_equipment_hours:',
    'status:',
    'responsible:',
    'work_scope:',
  ].filter((field) => normalized.includes(field)).length;

  return (
    normalized.includes('doc_type: maintenance_record') ||
    normalized.includes('maintenance record for') ||
    structuredFieldCount >= 2
  );
}
