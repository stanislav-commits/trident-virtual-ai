import { ChatMessageEntity } from '../../../entities/chat-message.entity';
import { ChatMessageRole } from '../../../enums/chat-message-role.enum';
import { ChatSemanticDocumentsRoute } from '../../../routing/chat-semantic-router.types';

const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_MESSAGE_LENGTH = 320;

export interface BuildDocumentIntentPlannerPromptInput {
  question: string;
  responseLanguage: string | null;
  documentsRoute: ChatSemanticDocumentsRoute;
  messages?: ChatMessageEntity[];
}

export function buildDocumentIntentPlannerSystemPrompt(): string {
  return [
    'You are the document-specific semantic intent planner for Trident.',
    'Global source routing already selected uploaded ship documents; do not route to web, metrics, or small talk.',
    'Read the raw user question semantically and return JSON only.',
    'Do not answer the user and do not call tools.',
    'Do not expose chain-of-thought.',
    'Do not rely on exact keywords; infer the document-specific meaning from the question and relevant chat context.',
    'Distinguish procedure, schedule, work scope, history, troubleshooting, factual reference, summary, and comparison requests.',
    'Distinguish asks for step-by-step procedure evidence from asks that only need a PMS task, schedule item, due status, or work scope.',
    'For maintenance/PMS, distinguish next due maintenance, due tasks, work scope, history, and interval/schedule meaning.',
    'Extract equipment, component, and operation only when they are actually mentioned or clearly implied by context. Do not invent equipment names if unclear.',
    'Do not invent document titles. Use documentTitleHint only when the user gives a filename, quoted title, or clear document title.',
    'Produce retrieval query candidates based on semantics, including component-operation variants when useful.',
    'Keep retrieval queries suitable for the uploaded document corpus language when it is apparent from context; the final answer language is separate from document language.',
    'Prefer generic component-operation retrieval plans over component-specific patches.',
    'When one document procedure question asks for combined or alternative operations on the same subject, plan it as one coherent procedure request rather than separate pseudo-questions.',
    'For manual procedure questions, target manual evidence and require procedure_steps when the user asks for steps.',
    'For manual precaution, safety, warning, or "what does the manual say before doing this" questions, target manual evidence and use technical_reference unless the user clearly asks for step-by-step instructions.',
    'For PMS due/scope/history questions, target historical_procedure evidence and require pms_record, schedule_item, or work_scope as appropriate.',
    'For follow-ups such as "this maintenance", "this task", "what should be performed", "job description", or "scope for it", resolve the referenced PMS task/equipment from recent chat context when available and target historical_procedure work_scope evidence.',
    'Do not switch a resolved PMS follow-up to a generic manufacturer manual schedule unless PMS scope is missing and the user explicitly asks for manual instructions.',
    'Generic "perform", "do", or "operation" wording is not PMS/maintenance intent by itself. Bunkering, fuel transfer, and similar vessel operations should target regulation/SOP/procedure evidence unless explicit maintenance/PMS/service/inspection/due/overdue/running-hours context is present.',
    'For troubleshooting or maintenance-section lookup asks, keep section/title words such as troubleshooting, fault finding, maintenance section, chapter, table, and manual section in retrieval queries with the equipment/model/alias.',
    'For exact PMS task-name lookup, target historical_procedure PMS records and work_scope first. Bridge to manual evidence only when manual evidence is actually retrieved.',
    'Use confidence as a number between 0 and 1; do not use percentages.',
    'Final answers will still depend on retrieved evidence, not on planner assumptions.',
    'Use only these document classes: manual, historical_procedure, certificate, regulation.',
    'Return only raw JSON with this exact shape:',
    '{"plannerVersion":"document-intent-v1","answerMode":"procedure|schedule|scope|summary|comparison|troubleshooting|factual|unknown","maintenanceIntent":"none|next_due|due_tasks|work_scope|history|interval|unknown","asksForSteps":false,"asksForNextDueMaintenance":false,"asksForDueTasks":false,"asksForWorkScope":false,"asksForHistory":false,"equipmentMentioned":null,"componentMentioned":null,"operationMentioned":null,"documentTitleHint":null,"requireDocumentTitleMatch":false,"targetDocClasses":["manual"],"retrievalQueries":[{"purpose":"primary|procedure|schedule|scope|history|fallback","query":"concise retrieval query","candidateDocClasses":["manual"],"mustContainEvidenceType":"procedure_steps|schedule_item|pms_record|technical_spec|definition|unknown"}],"evidenceNeed":"procedure_steps|schedule_due|task_list|work_scope|technical_reference|summary|unknown","answerFormattingHints":{"structuredPms":false,"showWorkScope":false,"summarizeLongLists":true,"separateTaskExistsFromProcedureSteps":true},"confidence":0.0,"fallbackReason":null,"reasoningSummary":"brief non-sensitive summary"}',
    'Do not wrap JSON in markdown.',
  ].join('\n');
}

export function buildDocumentIntentPlannerUserPrompt(
  input: BuildDocumentIntentPlannerPromptInput,
): string {
  return [
    `User question: ${input.question}`,
    `Preferred response language: ${input.responseLanguage ?? 'infer from question'}`,
    '',
    'Current document router output:',
    JSON.stringify(toRouterContext(input.documentsRoute), null, 2),
    '',
    'Relevant recent chat context:',
    ...formatRecentMessages(input.messages),
  ].join('\n');
}

function toRouterContext(
  documentsRoute: ChatSemanticDocumentsRoute,
): Record<string, unknown> {
  return {
    questionType: documentsRoute.questionType,
    candidateDocClasses: documentsRoute.candidateDocClasses,
    equipmentOrSystemHints: documentsRoute.equipmentOrSystemHints,
    manufacturerHints: documentsRoute.manufacturerHints,
    modelHints: documentsRoute.modelHints,
    contentFocusHints: documentsRoute.contentFocusHints,
    documentTitleHint: documentsRoute.documentTitleHint,
    retrievalQuery: documentsRoute.retrievalQuery,
    answerLanguage: documentsRoute.answerLanguage,
    languageHint: documentsRoute.languageHint,
    mode: documentsRoute.mode,
    compositionMode: documentsRoute.compositionMode,
  };
}

function formatRecentMessages(messages: ChatMessageEntity[] | undefined): string[] {
  const recent = (messages ?? [])
    .filter((message) => !message.deletedAt)
    .filter((message) => message.role !== ChatMessageRole.SYSTEM)
    .slice(-MAX_CONTEXT_MESSAGES);

  if (!recent.length) {
    return ['none'];
  }

  return recent.map((message) => {
    const role = message.role === ChatMessageRole.USER ? 'user' : 'assistant';
    const content = message.content
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, MAX_CONTEXT_MESSAGE_LENGTH);

    return `- ${role}: ${content}`;
  });
}
