import { ChatMessageEntity } from '../../../entities/chat-message.entity';
import { ChatMessageRole } from '../../../enums/chat-message-role.enum';
import {
  isAdministrativeComplianceIntent,
  isMaintenanceRecordIntent,
} from './document-maintenance-intent';
import { DocumentIntentPlan } from '../intent/document-intent-plan.types';
import { hasUsablePlannedRetrievalQuery } from '../intent/document-intent-query';

const MAX_ENRICHED_SEARCH_QUESTION_LENGTH = 320;

const FUEL_FILTER_REPLACEMENT_QUERY =
  'engine fuel filter replacement procedure replace fuel filter cartridge procedure open main fuel tap handpump check leaks';
const MAINTENANCE_SCHEDULE_QUERY =
  'periodic checks maintenance schedule running hours service interval hours section maintenance';

interface EnrichDocumentSearchQuestionInput {
  originalQuestion: string;
  searchQuestion: string;
  messages?: ChatMessageEntity[];
  documentIntentPlan?: DocumentIntentPlan | null;
}

export function enrichDocumentSearchQuestion(
  input: EnrichDocumentSearchQuestionInput,
): string {
  const baseQuestion = normalizeWhitespace(input.searchQuestion);
  const sourceText = normalizeWhitespace(
    `${input.originalQuestion} ${baseQuestion}`,
  );
  const enrichmentParts: string[] = [];
  const pmsFollowUpContext = extractPmsFollowUpContext(input);
  const aliasTerms = buildEquipmentAliasTerms(sourceText);

  if (
    !hasUsablePlannedRetrievalQuery(input.documentIntentPlan) &&
    isFuelFilterReplacementQuestion(sourceText)
  ) {
    enrichmentParts.push(FUEL_FILTER_REPLACEMENT_QUERY);
  }

  if (pmsFollowUpContext) {
    enrichmentParts.push(pmsFollowUpContext);
  }

  if (aliasTerms) {
    enrichmentParts.push(aliasTerms);
  }

  if (
    isMaintenanceScheduleQuestion(sourceText) &&
    !pmsFollowUpContext &&
    !isMaintenanceRecordIntent(sourceText)
  ) {
    const runningHours = extractRelevantRunningHours(input);
    enrichmentParts.push(MAINTENANCE_SCHEDULE_QUERY);

    if (runningHours) {
      enrichmentParts.push(`${runningHours} running hours`);
    }
  }

  if (!enrichmentParts.length) {
    return baseQuestion;
  }

  return limitSearchQuestionLength(
    appendUniqueSearchTerms(baseQuestion, enrichmentParts),
  );
}

export function isFuelFilterReplacementQuestion(value: string): boolean {
  const normalized = normalizeComparableText(value);

  return (
    /\bfuel\s*(?:pre\s*)?filter(?:s| cartridge| cartridges)?\b/u.test(
      normalized,
    ) &&
    /\b(?:change|changing|replace|replacing|replacement|renew|renewing|service|servicing|remove|removing|install|installing)\b/u.test(
      normalized,
    )
  );
}

export function isMaintenanceScheduleQuestion(value: string): boolean {
  const normalized = normalizeComparableText(value);

  if (isAdministrativeComplianceIntent(normalized)) {
    return false;
  }

  const hasMaintenanceIntent =
    /\b(?:maintenance|maintain|service|servicing|schedule|interval|periodic checks|checks and maintenance)\b/u.test(
      normalized,
    );
  const hasScheduleSignal =
    /\b(?:next|due|scheduled|schedule|interval|periodic|running hours|run hours|hours|hrs)\b/u.test(
      normalized,
    );
  const hasManufacturerServiceSignal =
    /\b(?:manufacturer|maker|oem|manual)\b/u.test(normalized) &&
    /\b(?:service|servicing|maintenance)\b/u.test(normalized);

  return hasMaintenanceIntent && (hasScheduleSignal || hasManufacturerServiceSignal);
}

export function extractPmsFollowUpContext(
  input: Pick<
    EnrichDocumentSearchQuestionInput,
    'originalQuestion' | 'messages'
  >,
): string | null {
  if (!isPmsTaskFollowUpQuestion(input.originalQuestion)) {
    return null;
  }

  const recentTexts = collectRecentAssistantPmsTexts(input.messages);

  for (const text of recentTexts) {
    const taskName =
      extractStructuredField(text, 'task_name') ??
      extractLabeledValue(text, ['Next maintenance', 'Task', 'Maintenance task']);
    const equipment =
      extractStructuredField(text, 'equipment_name') ??
      extractStructuredField(text, 'component_aliases') ??
      extractMaintenanceRecordSubject(text);

    if (!taskName && !equipment) {
      continue;
    }

    return limitSearchQuestionLength(
      normalizeWhitespace(
        [
          taskName,
          equipment,
          'PMS maintenance record work_scope scope of work job description tasks included historical_procedure',
        ]
          .filter(Boolean)
          .join(' '),
      ),
    );
  }

  return null;
}

export function extractRelevantRunningHours(
  input: Pick<EnrichDocumentSearchQuestionInput, 'originalQuestion' | 'messages'>,
): string | null {
  const fromQuestion = extractLastRunningHoursValue(input.originalQuestion);

  if (fromQuestion) {
    return fromQuestion;
  }

  const priorMessages = (input.messages ?? [])
    .filter((message) => !message.deletedAt)
    .filter((message) => message.role !== ChatMessageRole.SYSTEM)
    .filter((message) => message.content.trim() !== input.originalQuestion.trim());

  for (const message of [...priorMessages].reverse().slice(0, 8)) {
    const value = extractLastRunningHoursValue(message.content);

    if (value) {
      return value;
    }
  }

  return null;
}

function extractLastRunningHoursValue(value: string): string | null {
  const normalized = normalizeWhitespace(value);
  const matches = [
    ...Array.from(
      normalized.matchAll(
        /\b(\d{1,7}(?:[.,]\d{1,3})?)\s*(?:running|run)\s*(?:hours?|hrs?)\b/giu,
      ),
    ).map((match) => ({ index: match.index ?? 0, value: match[1] })),
    ...Array.from(
      normalized.matchAll(
        /\brunning\s*(?:time|hours?|hrs?)\b[^\d]{0,48}(\d{1,7}(?:[.,]\d{1,3})?)\s*(?:hours?|hrs?)\b/giu,
      ),
    ).map((match) => ({ index: match.index ?? 0, value: match[1] })),
  ].sort((left, right) => left.index - right.index);
  const lastMatch = matches[matches.length - 1];
  const rawValue = lastMatch?.value?.replace(',', '.');

  return rawValue ?? null;
}

function buildEquipmentAliasTerms(value: string): string | null {
  const normalized = normalizeComparableText(value);
  const aliases: string[] = [];

  if (
    /\b(?:port|portside|port side|ps)\s+(?:generator|genset|gen\s*set)\b/u.test(
      normalized,
    )
  ) {
    aliases.push('port generator portside generator port side generator PS GENSET');
  }

  if (
    /\b(?:starboard|stbd|sb)\s+(?:generator|genset|gen\s*set)\b/u.test(
      normalized,
    )
  ) {
    aliases.push(
      'starboard generator starboard side generator STBD generator SB GENSET',
    );
  }

  if (/\b(?:fuel oil purifier|fuel purifier|purifier)\b/u.test(normalized)) {
    aliases.push('fuel purifier fuel oil purifier fuel oil separator purifier');
  }

  return aliases.length ? aliases.join(' ') : null;
}

function isPmsTaskFollowUpQuestion(value: string): boolean {
  const normalized = normalizeComparableText(value);
  const hasFollowUpReference =
    /\b(?:this|that|it|its|the)\s+(?:maintenance|task|job|service|work|scope)\b/u.test(
      normalized,
    ) ||
    /\b(?:for it|for this|on it|at this maintenance|for this maintenance)\b/u.test(
      normalized,
    ) ||
    /\b(?:це|ця|цей|цього|нього|неї|эту|это|этого|него|нее)\b/u.test(
      normalized,
    );
  const hasScopeOrActionIntent =
    /\b(?:work scope|scope of work|scope|job description|task description|what should be performed|what to perform|what do i need to do|what should i do|what needs to be done|tasks included|included work|perform at|perform for)\b/u.test(
      normalized,
    ) ||
    /\b(?:how should i perform|how do i perform|perform this|perform the)\b/u.test(
      normalized,
    ) ||
    /\b(?:обсяг робіт|опис робіт|що виконати|що робити|які роботи|роботи входять|объем работ|описание работ|что выполнить|что делать|какие работы)\b/u.test(
      normalized,
    );

  return hasFollowUpReference && hasScopeOrActionIntent;
}

function collectRecentAssistantPmsTexts(
  messages: ChatMessageEntity[] | undefined,
): string[] {
  return (messages ?? [])
    .filter((message) => !message.deletedAt)
    .filter((message) => message.role === ChatMessageRole.ASSISTANT)
    .slice(-8)
    .reverse()
    .flatMap((message) => {
      const values = [message.content, ...extractContextReferenceSnippets(message)];

      return values.filter((value) => isPmsText(value));
    });
}

function extractContextReferenceSnippets(message: ChatMessageEntity): string[] {
  const snippets: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const entry = value as Record<string, unknown>;

    if (typeof entry.snippet === 'string') {
      snippets.push(entry.snippet);
    }

    for (const child of Object.values(entry)) {
      if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };

  visit(message.ragflowContext);
  return snippets;
}

function isPmsText(value: string): boolean {
  const normalized = normalizeComparableText(value);

  return (
    normalized.includes('doc type maintenance record') ||
    normalized.includes('maintenance record for') ||
    normalized.includes('task name') ||
    normalized.includes('work scope')
  );
}

function extractStructuredField(value: string, fieldName: string): string | null {
  const escapedField = fieldName.replace(/_/g, String.raw`[_\s-]*`);
  const match = value.match(
    new RegExp(
      String.raw`\b${escapedField}\s*:\s*(.+?)(?=\s+\b(?:doc[_\s-]*type|equipment[_\s-]*name|component[_\s-]*aliases|task[_\s-]*name|priority|interval|last[_\s-]*completed[_\s-]*(?:date|hours)|next[_\s-]*due[_\s-]*(?:date|hours)|current[_\s-]*equipment[_\s-]*hours|running[_\s-]*hours|hours[_\s-]*remaining|days[_\s-]*remaining|status|responsible|approval|work[_\s-]*scope)\s*:|$)`,
      'iu',
    ),
  );

  return cleanupExtractedText(match?.[1] ?? null);
}

function extractLabeledValue(value: string, labels: string[]): string | null {
  for (const label of labels) {
    const match = value.match(
      new RegExp(String.raw`\b${escapeRegExp(label)}\s*[:\-]\s*(.+)`, 'iu'),
    );
    const extracted = cleanupExtractedText(match?.[1] ?? null);

    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function extractMaintenanceRecordSubject(value: string): string | null {
  const match = value.match(/\bMaintenance record for\s+(.+?)(?:[.;\n]|$)/iu);

  return cleanupExtractedText(match?.[1] ?? null);
}

function cleanupExtractedText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cleaned = normalizeWhitespace(value)
    .replace(/^[\["'`]+|[\]"'`,.;:]+$/gu, '')
    .slice(0, 160)
    .trim();

  return cleaned || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendUniqueSearchTerms(
  searchQuestion: string,
  enrichmentParts: string[],
): string {
  let comparableSearchQuestion = normalizeComparableText(searchQuestion);
  const termsToAppend: string[] = [];

  for (const part of enrichmentParts) {
    const normalizedPart = normalizeComparableText(part);

    if (!normalizedPart || comparableSearchQuestion.includes(normalizedPart)) {
      continue;
    }

    termsToAppend.push(part);
    comparableSearchQuestion = normalizeComparableText(
      `${comparableSearchQuestion} ${part}`,
    );
  }

  return normalizeWhitespace([searchQuestion, ...termsToAppend].join(' '));
}

function limitSearchQuestionLength(value: string): string {
  if (value.length <= MAX_ENRICHED_SEARCH_QUESTION_LENGTH) {
    return value;
  }

  const words = value.split(/\s+/u);
  const kept: string[] = [];
  let length = 0;

  for (const word of words) {
    const nextLength = length + (kept.length ? 1 : 0) + word.length;

    if (nextLength > MAX_ENRICHED_SEARCH_QUESTION_LENGTH) {
      break;
    }

    kept.push(word);
    length = nextLength;
  }

  return kept.join(' ');
}

function normalizeComparableText(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
