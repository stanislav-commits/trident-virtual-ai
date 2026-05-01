import { DocumentRetrievalResponseDto } from '../../documents/dto/document-retrieval-response.dto';

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
): DocumentAnswerGroundingValidation {
  const claims = extractNumericValueClaims(answerText);
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

  const citedEvidence = retrieval.results
    .filter((result) => citedRanks.has(result.rank))
    .map((result) => result.snippet)
    .join('\n');

  for (const claim of claims) {
    if (!isNumericValueClaimSupported(claim, citedEvidence)) {
      return {
        isGrounded: false,
        reason: `The answer included "${claim.raw}", but that exact value/unit was not found in the cited evidence snippets.`,
      };
    }
  }

  return { isGrounded: true };
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
    'hours?',
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
    .replace(/\bhours?\b/g, 'h')
    .replace(/\bdegrees?\s*c\b/g, 'c')
    .replace(/\u00b0\s*c\b/g, 'c')
    .replace(
      /(\d+(?:\.\d+)?)\s*(?:\u00f7|[-\u2013\u2014]|to)\s*(\d+(?:\.\d+)?)/gu,
      '$1-$2',
    )
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
    .replace(/^hours?$/, 'h')
    .replace(/^degrees?c$/, 'c')
    .replace(/^\u00b0c$/, 'c');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
