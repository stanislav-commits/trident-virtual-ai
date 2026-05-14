import { ChatMessageEntity } from '../../entities/chat-message.entity';
import { ChatMessageRole } from '../../enums/chat-message-role.enum';
import { isMaintenanceRecordIntent } from './document-maintenance-intent';

const MAX_ENRICHED_SEARCH_QUESTION_LENGTH = 320;

const FUEL_FILTER_REPLACEMENT_QUERY =
  'engine fuel filter replacement procedure replace fuel filter cartridge procedure open main fuel tap handpump check leaks';
const MAINTENANCE_SCHEDULE_QUERY =
  'periodic checks maintenance schedule running hours service interval hours section maintenance';

interface EnrichDocumentSearchQuestionInput {
  originalQuestion: string;
  searchQuestion: string;
  messages?: ChatMessageEntity[];
}

export function enrichDocumentSearchQuestion(
  input: EnrichDocumentSearchQuestionInput,
): string {
  const baseQuestion = normalizeWhitespace(input.searchQuestion);
  const sourceText = normalizeWhitespace(
    `${input.originalQuestion} ${baseQuestion}`,
  );
  const enrichmentParts: string[] = [];

  if (isFuelFilterReplacementQuestion(sourceText)) {
    enrichmentParts.push(FUEL_FILTER_REPLACEMENT_QUERY);
  }

  if (
    isMaintenanceScheduleQuestion(sourceText) &&
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
  const hasMaintenanceIntent =
    /\b(?:maintenance|maintain|service|servicing|scheduled|schedule|interval|periodic checks|checks and maintenance|due|next)\b/u.test(
      normalized,
    );
  const hasScheduleSignal =
    /\b(?:next|due|scheduled|schedule|interval|periodic|running hours|run hours|hours|hrs|perform|performed)\b/u.test(
      normalized,
    );

  return hasMaintenanceIntent && hasScheduleSignal;
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
