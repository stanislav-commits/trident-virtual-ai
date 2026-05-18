import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';

export const DOCUMENT_INTENT_PLANNER_VERSION = 'document-intent-v1';

export type DocumentIntentAnswerMode =
  | 'procedure'
  | 'schedule'
  | 'scope'
  | 'summary'
  | 'comparison'
  | 'troubleshooting'
  | 'factual'
  | 'unknown';

export type DocumentIntentMaintenanceIntent =
  | 'none'
  | 'next_due'
  | 'due_tasks'
  | 'work_scope'
  | 'history'
  | 'interval'
  | 'unknown';

export type DocumentIntentRetrievalPurpose =
  | 'primary'
  | 'procedure'
  | 'schedule'
  | 'scope'
  | 'history'
  | 'fallback';

export type DocumentIntentEvidenceType =
  | 'procedure_steps'
  | 'schedule_item'
  | 'pms_record'
  | 'technical_spec'
  | 'definition'
  | 'unknown';

export type DocumentIntentEvidenceNeed =
  | 'procedure_steps'
  | 'schedule_due'
  | 'task_list'
  | 'work_scope'
  | 'technical_reference'
  | 'summary'
  | 'unknown';

export interface DocumentIntentRetrievalQuery {
  purpose: DocumentIntentRetrievalPurpose;
  query: string;
  candidateDocClasses: DocumentDocClass[];
  mustContainEvidenceType: DocumentIntentEvidenceType;
}

export interface DocumentIntentAnswerFormattingHints {
  structuredPms: boolean;
  showWorkScope: boolean;
  summarizeLongLists: boolean;
  separateTaskExistsFromProcedureSteps: boolean;
}

export interface DocumentIntentPlan {
  plannerVersion: string;
  answerMode: DocumentIntentAnswerMode;
  maintenanceIntent: DocumentIntentMaintenanceIntent;
  asksForSteps: boolean;
  asksForNextDueMaintenance: boolean;
  asksForDueTasks: boolean;
  asksForWorkScope: boolean;
  asksForHistory: boolean;
  equipmentMentioned: string | null;
  componentMentioned: string | null;
  operationMentioned: string | null;
  documentTitleHint: string | null;
  requireDocumentTitleMatch: boolean;
  targetDocClasses: DocumentDocClass[];
  retrievalQueries: DocumentIntentRetrievalQuery[];
  evidenceNeed: DocumentIntentEvidenceNeed;
  answerFormattingHints: DocumentIntentAnswerFormattingHints;
  confidence: number;
  fallbackReason: string | null;
  reasoningSummary: string;
}
