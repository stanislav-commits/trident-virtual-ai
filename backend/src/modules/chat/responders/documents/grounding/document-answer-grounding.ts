import {
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';

interface NumericValueClaim {
  raw: string;
  numericValue: string;
  unit: string;
}

export type DocumentAnswerGroundingValidation =
  | { isGrounded: true }
  | { isGrounded: false; reason: string };

export function extractCitedEvidenceRanks(answerText: string): Set<number> {
  const ranks = new Set<number>();

  for (const match of answerText.matchAll(/\[(\d{1,2})\]/g)) {
    const rank = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(rank) && rank > 0) {
      ranks.add(rank);
    }
  }

  return ranks;
}

export function validateDocumentAnswerGrounding(
  answerText: string,
  retrieval: DocumentRetrievalResponseDto,
  options: {
    supportedNumericContext?: string[];
  } = {},
): DocumentAnswerGroundingValidation {
  const claims = extractNumericValueClaims(answerText).filter(
    (claim) =>
      !isNumericValueClaimSupportedByContext(
        claim,
        options.supportedNumericContext ?? [],
      ),
  );

  if (!claims.length) {
    return { isGrounded: true };
  }

  const citedRanks = extractCitedEvidenceRanks(answerText);
  if (!citedRanks.size) {
    return {
      isGrounded: false,
      reason:
        'The answer contains concrete numeric or technical values but does not cite supporting evidence.',
    };
  }

  const citedEvidenceResults = retrieval.results.filter((result) =>
    citedRanks.has(result.rank),
  );

  for (const claim of claims) {
    if (
      !isNumericValueClaimSupportedByResults(
        claim,
        citedEvidenceResults,
        answerText,
      )
    ) {
      return {
        isGrounded: false,
        reason: `The answer included "${claim.raw}", but that exact value/unit was not found in the cited evidence snippets.`,
      };
    }
  }

  return { isGrounded: true };
}

function isNumericValueClaimSupportedByResults(
  claim: NumericValueClaim,
  results: DocumentRetrievalResultDto[],
  answerText: string,
): boolean {
  return results.some(
    (result) =>
      isNumericValueClaimSupported(claim, result.snippet) ||
      isHistoricalMaintenanceHourClaimSupported(claim, result) ||
      isHistoricalMaintenanceDayClaimSupported(claim, result, answerText) ||
      isHistoricalMaintenanceTaskNameIntervalClaimSupported(
        claim,
        answerText,
        result,
      ),
  );
}

function extractNumericValueClaims(answerText: string): NumericValueClaim[] {
  const withoutCitations = answerText.replace(/\[\d{1,2}\]/g, ' ');
  const numberPattern = String.raw`\d+(?:[.,]\d+)?(?:\s*(?:\u00f7|[-\u2013\u2014]|to)\s*\d+(?:[.,]\d+)?)?`;
  const unitPattern = [
    'l/min',
    'l/h',
    'kw',
    'kva',
    'va',
    'vdc',
    'vac',
    'volt(?:s)?',
    'v',
    'w',
    'ah',
    'amp(?:s)?',
    'a',
    'bar',
    'psi',
    '\\u00b0\\s*c',
    'degrees?\\s*c',
    'lit(?:er|re)s?',
    'l',
    'dm\\s*3',
    'dm\\u00b3',
    'rpm',
    'hz',
    'sec(?:onds?)?',
    'min(?:utes?)?',
    'days?',
    'hours?',
    'hrs?',
    'h',
    'mm',
    'cm',
    'kg',
    'g',
    '%',
  ].join('|');
  const valuePattern = new RegExp(
    String.raw`\b(${numberPattern})\s*(${unitPattern})(?=\s|[.,;:)\]]|$)`,
    'giu',
  );
  const claims: NumericValueClaim[] = [];

  for (const match of withoutCitations.matchAll(valuePattern)) {
    const raw = match[0]?.trim();
    const numericValue = match[1]?.trim();
    const unit = match[2]?.trim();

    if (!raw || !numericValue || !unit) {
      continue;
    }

    claims.push({ raw, numericValue, unit });
  }

  return claims;
}

function isNumericValueClaimSupported(
  claim: NumericValueClaim,
  evidenceText: string,
): boolean {
  const normalizedEvidence = normalizeNumericGroundingText(evidenceText);
  const numericValue = normalizeNumericValue(claim.numericValue);
  const unit = normalizeNumericUnit(claim.unit);

  if (!numericValue || !unit) {
    return false;
  }

  const valuePattern = escapeRegExp(numericValue);
  const unitPattern = escapeRegExp(unit);
  const localExpressionPattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}.])${valuePattern}\s*${unitPattern}(?![\p{L}\p{N}/])`,
    'u',
  );

  return localExpressionPattern.test(normalizedEvidence);
}

function isHistoricalMaintenanceHourClaimSupported(
  claim: NumericValueClaim,
  result: DocumentRetrievalResultDto,
): boolean {
  if (
    result.docClass !== DocumentDocClass.HISTORICAL_PROCEDURE ||
    !isMaintenanceRecordEvidence(result.snippet)
  ) {
    return false;
  }

  const numericValue = normalizeNumericValue(claim.numericValue);
  const unit = normalizeNumericUnit(claim.unit);

  if (!numericValue || unit !== 'h' || !/^\d+(?:\.\d+)?$/u.test(numericValue)) {
    return false;
  }

  const rawEvidence = result.snippet.toLowerCase().replace(/\u00a0/g, ' ');
  const yamlHourFieldPattern = new RegExp(
    String.raw`\b(?:last_completed_hours|next_due_hours|current_equipment_hours|running_hours|hours_remaining)\s*:\s*${escapeRegExp(numericValue)}(?![\d.])`,
    'u',
  );

  if (yamlHourFieldPattern.test(rawEvidence)) {
    return true;
  }

  const normalizedEvidence = normalizeNumericGroundingText(result.snippet);
  const valuePattern = escapeRegExp(numericValue);
  const descriptorHourPattern = new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}.])${valuePattern}\s+(?:equipment|operating|running)\s+h(?![\p{L}\p{N}/])`,
    'u',
  );

  return descriptorHourPattern.test(normalizedEvidence);
}

function isHistoricalMaintenanceDayClaimSupported(
  claim: NumericValueClaim,
  result: DocumentRetrievalResultDto,
  answerText: string,
): boolean {
  if (
    result.docClass !== DocumentDocClass.HISTORICAL_PROCEDURE ||
    !isMaintenanceRecordEvidence(result.snippet)
  ) {
    return false;
  }

  const numericValue = normalizeNumericValue(claim.numericValue);
  const unit = normalizeNumericUnit(claim.unit);

  if (!numericValue || unit !== 'd' || !/^\d+(?:\.\d+)?$/u.test(numericValue)) {
    return false;
  }

  const rawEvidence = result.snippet.toLowerCase().replace(/\u00a0/g, ' ');
  const positiveDaysFieldPattern = new RegExp(
    String.raw`\bdays_remaining\s*:\s*${escapeRegExp(numericValue)}(?![\d.])`,
    'u',
  );

  if (positiveDaysFieldPattern.test(rawEvidence)) {
    return true;
  }

  if (!/\boverdue\b/iu.test(answerText)) {
    return false;
  }

  const overdueDaysFieldPattern = new RegExp(
    String.raw`\bdays_remaining\s*:\s*-${escapeRegExp(numericValue)}(?![\d.])`,
    'u',
  );

  return overdueDaysFieldPattern.test(rawEvidence);
}

function isHistoricalMaintenanceTaskNameIntervalClaimSupported(
  claim: NumericValueClaim,
  answerText: string,
  result: DocumentRetrievalResultDto,
): boolean {
  if (
    result.docClass !== DocumentDocClass.HISTORICAL_PROCEDURE ||
    !isMaintenanceRecordEvidence(result.snippet)
  ) {
    return false;
  }

  const normalizedClaim = normalizeTaskNameText(claim.raw);
  const normalizedAnswer = normalizeTaskNameText(answerText);

  if (!normalizedClaim || !normalizedAnswer) {
    return false;
  }

  return extractMaintenanceTaskNames(result.snippet).some((taskName) => {
    const normalizedTaskName = normalizeTaskNameText(taskName);

    return (
      normalizedTaskName.includes(normalizedClaim) &&
      normalizedAnswer.includes(normalizedTaskName)
    );
  });
}

function isMaintenanceRecordEvidence(snippet: string): boolean {
  const normalized = snippet.toLowerCase();

  return (
    normalized.includes('doc_type: maintenance_record') ||
    normalized.includes('maintenance record for')
  );
}

function extractMaintenanceTaskNames(snippet: string): string[] {
  const taskNames = new Set<string>();
  const yamlMatch = snippet.match(
    /\btask_name\s*:\s*(.+?)(?=\s+(?:priority|interval|last_completed_date|last_completed_hours|next_due_date|next_due_hours|current_equipment_hours|hours_remaining|days_remaining|status|postponed|responsible|work_scope)\s*:|\s+```|\s+Maintenance record for|$)/iu,
  );
  const proseMatches = snippet.matchAll(/\bMaintenance task:\s*"([^"]+)"/giu);

  if (yamlMatch?.[1]?.trim()) {
    taskNames.add(yamlMatch[1].trim());
  }

  for (const match of proseMatches) {
    const taskName = match[1]?.trim();

    if (taskName) {
      taskNames.add(taskName);
    }
  }

  return [...taskNames];
}

function isNumericValueClaimSupportedByContext(
  claim: NumericValueClaim,
  supportedNumericContext: string[],
): boolean {
  if (!supportedNumericContext.length) {
    return false;
  }

  return supportedNumericContext.some((value) =>
    isNumericValueClaimSupported(claim, value),
  );
}

function normalizeNumericGroundingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/,/g, '.')
    .replace(/\bdm\s*(?:3|\u00b3)\b/g, 'dm3')
    .replace(/\bl\s*\/\s*(min|h)\b/g, 'l/$1')
    .replace(/\b(?:litres?|liters?)\b/g, 'l')
    .replace(/\bvolts?\b/g, 'v')
    .replace(/\bamps?\b/g, 'a')
    .replace(/\bseconds?\b/g, 'sec')
    .replace(/\bminutes?\b/g, 'min')
    .replace(/\bdays?\b/g, 'd')
    .replace(/\bhrs?\b/g, 'h')
    .replace(/\bhours?\b/g, 'h')
    .replace(/\bdegrees?\s*c\b/g, 'c')
    .replace(/\u00b0\s*c\b/g, 'c')
    .replace(
      /(\d+(?:\.\d+)?)\s*(?:\u00f7|[-\u2013\u2014]|to)\s*(\d+(?:\.\d+)?)/gu,
      '$1-$2',
    )
    .replace(/([\p{L}])(\d)/gu, '$1 $2')
    .replace(/(\d)([\p{L}])/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNumericValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/,/g, '.')
    .replace(
      /(\d+(?:\.\d+)?)\s*(?:\u00f7|[-\u2013\u2014]|to)\s*(\d+(?:\.\d+)?)/gu,
      '$1-$2',
    )
    .replace(/\s+/g, '');
}

function normalizeNumericUnit(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')
    .replace(/^dm(?:3|\u00b3)$/, 'dm3')
    .replace(/^lit(?:er|re)s?$/, 'l')
    .replace(/^volts?$/, 'v')
    .replace(/^amps?$/, 'a')
    .replace(/^seconds?$/, 'sec')
    .replace(/^minutes?$/, 'min')
    .replace(/^days?$/, 'd')
    .replace(/^hrs?$/, 'h')
    .replace(/^hours?$/, 'h')
    .replace(/^degrees?c$/, 'c')
    .replace(/^\u00b0c$/, 'c');
}

function normalizeTaskNameText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
