import { DocumentRetrievalResponseDto } from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';

export function buildStructuredPmsFallbackSummary(
  retrieval: DocumentRetrievalResponseDto,
): string | null {
  const records = retrieval.results
    .filter(
      (result) =>
        result.docClass === DocumentDocClass.HISTORICAL_PROCEDURE &&
        isStructuredPmsSnippet(result.snippet),
    )
    .slice(0, 3);

  if (!records.length) {
    return null;
  }

  return [
    'I found PMS task evidence, but the drafted answer mixed numeric units. Here is the safely supported PMS evidence:',
    ...records.map(formatStructuredPmsRecord),
  ].join('\n');
}

export function isStructuredPmsUnitMismatchReason(
  reason: string,
  retrieval: DocumentRetrievalResponseDto,
): boolean {
  const claim = extractUnsupportedValueUnit(reason);

  if (!claim) {
    return false;
  }

  const unit = normalizeUnit(claim.unit);
  const value = claim.value.replace(',', '.');

  if (unit === 'd') {
    return retrieval.results.some((result) =>
      [
        'current_equipment_hours',
        'next_due_hours',
        'last_completed_hours',
        'running_hours',
        'hours_remaining',
      ].some(
        (fieldName) =>
          extractStructuredPmsField(result.snippet, fieldName) === value,
      ),
    );
  }

  if (unit === 'h') {
    return retrieval.results.some((result) => {
      const daysRemaining = extractStructuredPmsField(
        result.snippet,
        'days_remaining',
      );

      return daysRemaining === value || daysRemaining === `-${value}`;
    });
  }

  return false;
}

function extractUnsupportedValueUnit(
  reason: string,
): { value: string; unit: string } | null {
  const match = reason.match(
    /"(-?\d+(?:[.,]\d+)?)\s*(days?|hours?|hrs?|h|d)"/iu,
  );

  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    value: match[1],
    unit: match[2],
  };
}

function normalizeUnit(value: string): 'h' | 'd' | null {
  const normalized = value.toLocaleLowerCase();

  if (
    normalized === 'h' ||
    normalized.startsWith('hour') ||
    normalized.startsWith('hr')
  ) {
    return 'h';
  }

  if (normalized === 'd' || normalized.startsWith('day')) {
    return 'd';
  }

  return null;
}

function formatStructuredPmsRecord(
  result: DocumentRetrievalResponseDto['results'][number],
): string {
  const fields = [
    ['Task', extractStructuredPmsField(result.snippet, 'task_name')],
    ['Status', extractStructuredPmsField(result.snippet, 'status')],
    [
      'Last completed date',
      extractStructuredPmsField(result.snippet, 'last_completed_date'),
    ],
    [
      'Last completed hours',
      appendUnit(
        extractStructuredPmsField(result.snippet, 'last_completed_hours'),
        'hours',
      ),
    ],
    ['Next due date', extractStructuredPmsField(result.snippet, 'next_due_date')],
    [
      'Next due hours',
      appendUnit(
        extractStructuredPmsField(result.snippet, 'next_due_hours'),
        'hours',
      ),
    ],
    [
      'Current equipment hours',
      appendUnit(
        extractStructuredPmsField(result.snippet, 'current_equipment_hours'),
        'hours',
      ),
    ],
    [
      'Hours remaining',
      appendUnit(
        extractStructuredPmsField(result.snippet, 'hours_remaining'),
        'hours',
      ),
    ],
    [
      'Days remaining',
      appendUnit(
        extractStructuredPmsField(result.snippet, 'days_remaining'),
        'days',
      ),
    ],
    ['Responsible', extractStructuredPmsField(result.snippet, 'responsible')],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('; ');

  return `- ${fields || truncate(result.snippet, 220)} [${result.rank}]`;
}

function isStructuredPmsSnippet(snippet: string): boolean {
  return (
    snippet.includes('doc_type: maintenance_record') ||
    snippet.includes('task_name:') ||
    snippet.includes('next_due_hours:') ||
    snippet.includes('current_equipment_hours:')
  );
}

function extractStructuredPmsField(
  snippet: string,
  fieldName: string,
): string | null {
  const fieldPattern = fieldName.replace(/_/g, String.raw`[_\s-]*`);
  const nextFieldPattern = [
    'doc_type',
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
    'maintenance_record',
  ]
    .filter((candidate) => candidate !== fieldName)
    .map((candidate) => candidate.replace(/_/g, String.raw`[_\s-]*`))
    .join('|');
  const match = snippet.match(
    new RegExp(
      String.raw`\b${fieldPattern}\s*:\s*(.*?)(?=\s+\b(?:${nextFieldPattern})\s*:|$)`,
      'iu',
    ),
  );

  return sanitizeStructuredPmsValue(match?.[1] ?? null);
}

function appendUnit(value: string | null, unit: string): string | null {
  if (!value) {
    return null;
  }

  return `${value} ${unit}`;
}

function sanitizeStructuredPmsValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .split(/```|##|\n/u)[0]
    .split(
      /\b(?:doc_type|task_name|priority|interval|last_completed_date|last_completed_hour|next_due_date|next_due_hour|current_equipment_hour|running_hour|hours_remaining|days_remaining|total_pms_tasks|tasks_overdue|tasks_due_soon|tasks_postponed|hour_counter_source|status|postponed|responsible|approval|work_scope|maintenance_record)\b/iu,
    )[0]
    .replace(/\s+/gu, ' ')
    .trim();

  if (!normalized) {
    return null;
  }

  return truncate(normalized, 90);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
