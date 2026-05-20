import {
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';

const pmsOverduePrimarySelectionReason =
  'The answer selected a future PMS task before supported OVERDUE PMS evidence for a generic next/due maintenance question.';

interface PmsOverdueEvidence {
  rank: number;
  taskName: string | null;
  status: 'OVERDUE';
  nextDueDate: string | null;
  nextDueHours: string | null;
  currentHours: string | null;
  hoursRemaining: string | null;
  daysRemaining: string | null;
  responsible: string | null;
}

export function validatePmsOverduePrimarySelection(input: {
  reply: string;
  retrieval: DocumentRetrievalResponseDto;
  userQuestion?: string;
}): string | null {
  if (!input.userQuestion || !isGenericPmsTaskSelectionQuestion(input.userQuestion)) {
    return null;
  }

  const overdueEvidence = collectOverduePmsEvidence(input.retrieval);

  if (!overdueEvidence.length) {
    return null;
  }

  return answerMakesOverduePrimary(input.reply, overdueEvidence)
    ? null
    : pmsOverduePrimarySelectionReason;
}

export function isPmsOverduePrimarySelectionReason(reason: string): boolean {
  return reason === pmsOverduePrimarySelectionReason;
}

export function buildPmsOverduePrimaryFallbackSummary(
  retrieval: DocumentRetrievalResponseDto,
): string | null {
  const overdueEvidence = collectOverduePmsEvidence(retrieval);
  const primary = overdueEvidence[0];

  if (!primary) {
    return null;
  }

  const fields = [
    primary.taskName ? `- Task: ${primary.taskName} [${primary.rank}]` : null,
    `- Status: OVERDUE [${primary.rank}]`,
    primary.nextDueDate
      ? `- Next due date: ${primary.nextDueDate} [${primary.rank}]`
      : null,
    primary.nextDueHours
      ? `- Next due hours: ${primary.nextDueHours} hours [${primary.rank}]`
      : null,
    primary.currentHours
      ? `- Current equipment hours: ${primary.currentHours} hours [${primary.rank}]`
      : null,
    primary.hoursRemaining
      ? `- Hours remaining: ${primary.hoursRemaining} hours [${primary.rank}]`
      : null,
    primary.daysRemaining
      ? `- Days remaining: ${primary.daysRemaining} days [${primary.rank}]`
      : null,
    primary.responsible
      ? `- Responsible: ${primary.responsible} [${primary.rank}]`
      : null,
  ].filter((field): field is string => Boolean(field));

  return [
    'I found PMS evidence showing overdue maintenance, so that overdue task is the primary next maintenance before any future due-soon/upcoming task.',
    fields.length
      ? fields.join('\n')
      : `- PMS overdue evidence is present in the cited maintenance record [${primary.rank}]`,
    'Any future DUE SOON or UPCOMING task should be treated as the next upcoming non-overdue task, not as the primary next maintenance while overdue work exists.',
  ].join('\n');
}

function isGenericPmsTaskSelectionQuestion(question: string): boolean {
  const normalized = normalizeText(question);

  if (
    /\b(?:next upcoming|future scheduled|not overdue|due soon|upcoming)\b/u.test(
      normalized,
    )
  ) {
    return false;
  }

  const hasMaintenanceContext =
    /\b(?:pms|maintenance|service|task|tasks|inspection|scheduled)\b/u.test(
      normalized,
    );
  const hasSelectionContext =
    /\b(?:next|due|overdue|current|status|planned|scheduled)\b/u.test(
      normalized,
    );

  return hasMaintenanceContext && hasSelectionContext;
}

function answerMakesOverduePrimary(
  reply: string,
  overdueEvidence: PmsOverdueEvidence[],
): boolean {
  const primaryWindow = normalizeText(reply).slice(0, 1200);
  const overdueSignals = [
    'overdue',
    ...overdueEvidence
      .map((evidence) => evidence.taskName)
      .filter((taskName): taskName is string => Boolean(taskName))
      .map(normalizeText)
      .filter((taskName) => taskName.length >= 6),
  ];
  const firstOverdueSignal = firstIndexOfAny(primaryWindow, overdueSignals);

  if (firstOverdueSignal < 0) {
    return false;
  }

  const firstFutureStatus = firstIndexOfAny(primaryWindow, [
    'due soon',
    'upcoming',
  ]);

  return firstFutureStatus < 0 || firstOverdueSignal <= firstFutureStatus;
}

function collectOverduePmsEvidence(
  retrieval: DocumentRetrievalResponseDto,
): PmsOverdueEvidence[] {
  return retrieval.results.flatMap((result) => {
    if (result.docClass !== DocumentDocClass.HISTORICAL_PROCEDURE) {
      return [];
    }

    return extractOverdueEvidenceFromResult(result);
  });
}

function extractOverdueEvidenceFromResult(
  result: DocumentRetrievalResultDto,
): PmsOverdueEvidence[] {
  const snippet = result.snippet;
  const status = extractField(snippet, 'status');

  if (status && isOverdueStatus(status)) {
    return [buildEvidence(result.rank, snippet)];
  }

  const overdueSegments = extractOverdueSegments(snippet);

  if (overdueSegments.length) {
    return overdueSegments.map((segment) => buildEvidence(result.rank, segment));
  }

  if (hasOverdueEquipmentSummary(snippet)) {
    return [buildEvidence(result.rank, snippet)];
  }

  return [];
}

function extractOverdueSegments(snippet: string): string[] {
  const matches = [
    ...snippet.matchAll(
      /(?:(?:task_name|task|maintenance task)\s*:\s*|["“])([^"“”.;\n]{4,160})(?:["”])?[^.;\n]{0,320}\b(?:current\s+)?status\s*:?\s*OVERDUE\b/giu,
    ),
  ];

  if (matches.length) {
    return matches
      .map((match) => match[0])
      .filter((segment) => segment.trim().length > 0);
  }

  const normalized = snippet.replace(/\s+/gu, ' ');
  const overdueIndex = normalized.search(/\boverdue\b/iu);

  if (overdueIndex < 0) {
    return [];
  }

  const start = Math.max(0, overdueIndex - 420);
  const end = Math.min(normalized.length, overdueIndex + 420);
  const segment = normalized.slice(start, end);

  return /\b(?:task|maintenance|status|due)\b/iu.test(segment)
    ? [segment]
    : [];
}

function hasOverdueEquipmentSummary(snippet: string): boolean {
  return (
    /\bdoc_type\s*:\s*equipment_summary\b/iu.test(snippet) &&
    /\btasks_overdue\s*:\s*[1-9]\d*\b/iu.test(snippet)
  );
}

function buildEvidence(rank: number, source: string): PmsOverdueEvidence {
  return {
    rank,
    taskName: extractTaskName(source),
    status: 'OVERDUE',
    nextDueDate: extractField(source, 'next_due_date'),
    nextDueHours: extractField(source, 'next_due_hours'),
    currentHours:
      extractField(source, 'current_equipment_hours') ??
      extractField(source, 'running_hours'),
    hoursRemaining: extractField(source, 'hours_remaining'),
    daysRemaining: extractField(source, 'days_remaining'),
    responsible: extractField(source, 'responsible'),
  };
}

function extractTaskName(source: string): string | null {
  return (
    extractField(source, 'task_name') ??
    extractQuotedTaskName(source) ??
    extractNamedTaskBeforeStatus(source)
  );
}

function extractQuotedTaskName(source: string): string | null {
  const match = source.match(/["“]([^"“”]{6,160})["”][^"“”]{0,260}\boverdue\b/iu);

  return sanitizeValue(match?.[1] ?? null, 160);
}

function extractNamedTaskBeforeStatus(source: string): string | null {
  const match = source.match(
    /\b(?:task|maintenance task)\s*:\s*([^.;\n]{6,160}?)(?=[.;,\s]+\b(?:current\s+)?status\s*:?\s*overdue\b)/iu,
  );

  return sanitizeValue(match?.[1] ?? null, 160);
}

function extractField(source: string, fieldName: string): string | null {
  const fieldPattern = fieldName.replace(/_/g, String.raw`[_\s-]*`);
  const nextFieldPattern = [
    'doc_type',
    'equipment_id',
    'component_aliases',
    'task_name',
    'priority',
    'interval',
    'last_completed_date',
    'last_completed_hours',
    'next_due_date',
    'next_due_hours',
    'current_equipment_hours',
    'running_hours',
    'hours_remaining',
    'days_remaining',
    'total_pms_tasks',
    'tasks_overdue',
    'tasks_due_soon',
    'tasks_postponed',
    'hour_counter_source',
    'status',
    'postponed',
    'responsible',
    'approval',
    'work_scope',
  ]
    .filter((candidate) => candidate !== fieldName)
    .map((candidate) => candidate.replace(/_/g, String.raw`[_\s-]*`))
    .join('|');
  const match = source.match(
    new RegExp(
      String.raw`\b${fieldPattern}\s*:\s*(.*?)(?=\s+\b(?:${nextFieldPattern})\s*:|\s+\x60{3}|$)`,
      'iu',
    ),
  );

  return sanitizeValue(match?.[1] ?? null, 160);
}

function sanitizeValue(value: string | null, limit: number): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/gu, ' ').trim();

  if (!normalized) {
    return null;
  }

  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
    : normalized;
}

function isOverdueStatus(value: string): boolean {
  return normalizeText(value) === 'overdue';
}

function firstIndexOfAny(value: string, needles: string[]): number {
  return needles.reduce((first, needle) => {
    const index = value.indexOf(needle);

    if (index < 0) {
      return first;
    }

    return first < 0 ? index : Math.min(first, index);
  }, -1);
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
