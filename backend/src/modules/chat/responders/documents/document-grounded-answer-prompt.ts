import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../documents/dto/document-retrieval-response.dto';

interface BuildGroundedAnswerUserPromptInput {
  userQuestion: string;
  answerLanguage: string | null;
  retrieval: DocumentRetrievalResponseDto;
  contextFacts?: {
    maintenanceScheduleQuestion: boolean;
    runningHours: string | null;
  };
  answerStyle?: {
    structuredMaintenanceRecord: boolean;
  };
}

export function buildGroundedAnswerSystemPrompt(
  evidenceQuality: DocumentRetrievalEvidenceQuality,
): string {
  const weakInstruction =
    evidenceQuality === 'weak'
      ? 'The evidence is weak. Be cautious, state that the evidence is limited, and do not present uncertain details as confirmed facts.'
      : 'The evidence is strong enough to answer, but you must still stay strictly grounded.';

  return [
    'You answer Trident document questions using only retrieved ship-document evidence.',
    'Do not use public web knowledge, generic maritime knowledge, or assumptions.',
    'Do not invent page numbers, section names, values, procedures, or requirements.',
    'Use citation markers like [1] or [2] for facts that come from the evidence.',
    'If you use retrieved evidence to answer, the final answer must include at least one citation marker.',
    'Every factual sentence grounded in retrieved evidence should carry a citation marker.',
    'Cite only evidence items that directly support the sentence or value you are writing.',
    'Do not cite generally related snippets, candidate chunks, document titles, or metadata as proof.',
    'If the evidence does not support part of the question, say that plainly.',
    'For numeric, table, specification, threshold, interval, capacity, voltage, pressure, power, model, alarm-code, or fault-code answers, report a value only when the exact value and unit appear in the cited evidence snippet.',
    'When evidence is tabular, preserve the row and column relationship exactly as shown in one cited evidence item.',
    'Do not infer from adjacent rows, combine unrelated rows or tables, add values together, convert units, or guess missing cells.',
    'If the row, model, column, value, or unit relationship is unclear, say the evidence is insufficient or ambiguous instead of giving a concrete value.',
    'BE CONCISE: answer exactly what was asked and stop. Do not add unrequested sections — no extra background, no invented troubleshooting or recommendations, no restating the question, no summary of what evidence was retrieved.',
    weakInstruction,
  ].join(' ');
}

export function buildGroundedAnswerUserPrompt(
  input: BuildGroundedAnswerUserPromptInput,
): string {
  return [
    `User question: ${input.userQuestion}`,
    `Preferred response language: ${input.answerLanguage ?? 'infer from the user question'}`,
    'Answer in the preferred response language unless the user explicitly requested another language.',
    'Do not mention or reveal internal retrieval-query normalization.',
    ...formatContextFacts(input.contextFacts, input.answerStyle),
    ...formatAnswerStyle(input.answerStyle, input.userQuestion),
    `Evidence quality: ${input.retrieval.evidenceQuality}`,
    `Answerability note: ${input.retrieval.answerability.reason}`,
    '',
    'Retrieved evidence:',
    ...input.retrieval.results.map((result) => formatEvidenceItem(result)),
    '',
    'Citation rule:',
    'Use [n] only when evidence item [n] directly supports the claim.',
    'If no evidence item directly supports the requested value, procedure, or fact, answer that the uploaded document evidence is insufficient and do not include citation markers.',
  ].join('\n');
}

function formatContextFacts(
  contextFacts: BuildGroundedAnswerUserPromptInput['contextFacts'],
  answerStyle: BuildGroundedAnswerUserPromptInput['answerStyle'],
): string[] {
  if (answerStyle?.structuredMaintenanceRecord) {
    return [];
  }

  if (!contextFacts?.maintenanceScheduleQuestion) {
    return [];
  }

  return [
    '',
    'Relevant chat context:',
    contextFacts.runningHours
      ? `- Current running hours from the conversation: ${contextFacts.runningHours} running hours.`
      : '- The user is asking a running-hour/interval based maintenance follow-up, but no current running-hours value was found in the conversation.',
    '',
    'Maintenance schedule answer rules:',
    '- Manuals usually list recurring intervals, not the exact current running-hours value. Do not reject the question merely because the exact current-hour number is absent from the manual.',
    '- Use the current running-hours value only as conversation context for interpreting retrieved schedule evidence; it does not need a document citation.',
    '- Cite the manual evidence for interval/table claims.',
    '- If the retrieved table text does not preserve row/column mapping well enough to list exact due tasks, say that clearly.',
    '- Mention that the exact next work also depends on what service was last completed.',
  ];
}

function formatAnswerStyle(
  answerStyle: BuildGroundedAnswerUserPromptInput['answerStyle'],
  userQuestion: string,
): string[] {
  if (!answerStyle?.structuredMaintenanceRecord) {
    return [];
  }

  const maintenanceTaskSelectionRules = isMaintenanceTaskSelectionQuestion(
    userQuestion,
  )
      ? [
        '',
        'PMS maintenance-record task selection rules:',
        '- For a generic next-maintenance or next scheduled-maintenance question, mention supported OVERDUE task evidence separately as an important warning, then make the primary answer the next non-overdue scheduled task: prefer DUE_SOON, otherwise the earliest UPCOMING task by due date or due hours.',
        '- For overdue, due-now, needs-attention, or current-due questions, choose the primary task in this order when supported evidence is available: OVERDUE first, then DUE_SOON.',
        '- Do not choose a later UPCOMING task as the primary answer when earlier DUE_SOON or earlier UPCOMING task evidence is available.',
        '- If the user explicitly asks for next upcoming, future scheduled, or not overdue maintenance, choose the next non-overdue scheduled task: prefer DUE_SOON, otherwise the earliest UPCOMING task by due date or due hours.',
        '- For an upcoming or future request, present a task as the next non-overdue task only when cited evidence gives enough coverage to establish that no earlier non-overdue task is available. A single later UPCOMING record alone is not enough; say the uploaded evidence is insufficient or limited instead of presenting it as certain.',
        '- If overdue evidence is present for an upcoming or future request, mention it only as a separate important note, not as the upcoming task.',
        '- If cited equipment-summary evidence lists all tasks or names a Next upcoming task, use that to support the non-overdue task selection and any overdue warning.',
      ]
    : [];

  return [
    '',
    'PMS maintenance-record answer style:',
    '- Start with one short summary sentence that directly answers the user.',
    '- Then use compact Markdown bullet lines for supported fields such as Task, Status, Last completed, Next due, Current hours, Remaining hours, Overdue days, Responsible, or Work scope.',
    '- For next, due, overdue, or upcoming PMS questions, keep the bullet list focused on task-selection fields; do not add equipment specifications, make/model fields, side, reference IDs, or total task counts unless the user specifically asks for them.',
    '- Include only fields that are explicitly present in the cited maintenance-record evidence.',
    '- Do not copy task-specific fields such as Responsible, Last completed, Work scope, remaining hours, or overdue days from one PMS task to another; use those fields only when the cited evidence ties them to the same selected task.',
    '- If the selected task is supported only by an equipment-summary task list, limit that task\'s bullet lines to the fields visible in that summary, such as Task, Status, Next due, and current equipment hours.',
    '- Do not invent missing fields or calculate derived values; include remaining hours or overdue days only when the exact value appears in the cited evidence.',
    '- Put a citation marker at the end of every factual bullet line; do not use a single citation after an entire bullet block.',
    '- Include a Work scope bullet only when concrete work-scope text for the same selected task is visible in cited evidence.',
    '- Add a short final note only when the cited evidence directly supports it.',
    ...maintenanceTaskSelectionRules,
  ];
}

function isMaintenanceTaskSelectionQuestion(value: string): boolean {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const hasMaintenanceRecordContext =
    /\b(?:maintenance|service|tasks?|pms|tests?|inspections?|checks?|overhauls?)\b/u.test(
      normalized,
    );
  const hasSelectionSignal =
    /\b(?:next|due|overdue|scheduled|planned|upcoming|current|status)\b/u.test(
      normalized,
    );

  return hasMaintenanceRecordContext && hasSelectionSignal;
}

export function formatEvidenceItem(
  result: DocumentRetrievalResultDto,
): string {
  return [
    `[${result.rank}] ${result.filename}`,
    `docClass: ${result.docClass}`,
    result.page ? `page: ${result.page}` : 'page: unknown',
    result.section ? `section: ${result.section}` : null,
    `snippet: ${result.snippet}`,
  ]
    .filter(Boolean)
    .join('\n');
}
