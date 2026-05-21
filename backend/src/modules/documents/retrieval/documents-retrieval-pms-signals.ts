import { DocumentDocClass } from '../enums/document-doc-class.enum';
import {
  DocumentRetrievalCandidateScoreInput,
  DocumentRetrievalHints,
  EnrichedDocumentRetrievalCandidate,
} from './documents-retrieval.types';

type PmsTaskStatus = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'NO_SCHEDULE';
type PmsSelectionIntent = 'next_scheduled' | 'upcoming' | 'attention';

interface PmsCandidateSignals {
  sameEquipment: boolean;
  isEquipmentSummary: boolean;
  isMaintenanceRecord: boolean;
  hasTaskOverview: boolean;
  status: PmsTaskStatus | null;
  nextDueDate: number | null;
  nextDueHours: number | null;
}

export function getPmsTaskSelectionBonus(
  input: DocumentRetrievalCandidateScoreInput,
): number {
  const intent = getPmsSelectionIntent(input.question);
  const signals = getPmsCandidateSignals(
    input.content,
    input.document.docClass,
    input.hints,
  );

  if (!intent || !signals.sameEquipment) {
    return 0;
  }

  let bonus = 0;

  if (signals.isEquipmentSummary && signals.hasTaskOverview) {
    bonus += intent === 'attention' ? 0.1 : 0.26;
  }

  if (!signals.isMaintenanceRecord || !signals.status) {
    return bonus;
  }

  if (intent === 'attention') {
    if (signals.status === 'OVERDUE') bonus += 0.18;
    if (signals.status === 'DUE_SOON') bonus += 0.14;
    return bonus;
  }

  if (signals.status === 'DUE_SOON') {
    bonus += 0.18;
  } else if (signals.status === 'UPCOMING') {
    bonus += 0.08;
  } else if (signals.status === 'OVERDUE') {
    bonus += intent === 'next_scheduled' ? 0.12 : 0.06;
  }

  return bonus;
}

export function applyPmsFutureTaskOrderBonuses(
  candidates: EnrichedDocumentRetrievalCandidate[],
  question: string,
  hints: DocumentRetrievalHints,
): EnrichedDocumentRetrievalCandidate[] {
  const intent = getPmsSelectionIntent(question);

  if (!intent || intent === 'attention') {
    return candidates;
  }

  const futureCandidates = candidates
    .map((candidate) => ({
      candidate,
      signals: getPmsCandidateSignals(
        candidate.chunk.content ?? '',
        candidate.document.docClass,
        hints,
      ),
    }))
    .filter(({ signals }) =>
      signals.sameEquipment &&
      signals.isMaintenanceRecord &&
      (signals.status === 'DUE_SOON' || signals.status === 'UPCOMING') &&
      (signals.nextDueDate !== null || signals.nextDueHours !== null),
    )
    .sort((left, right) => compareFutureTaskSignals(left.signals, right.signals));

  if (!futureCandidates.length) {
    return candidates;
  }

  const orderBonusByChunkId = new Map<string, number>();

  futureCandidates.forEach(({ candidate }, index) => {
    orderBonusByChunkId.set(
      candidate.chunk.id,
      Math.max(0, 0.06 - index * 0.01),
    );
  });

  return candidates.map((candidate) => {
    const orderBonus = orderBonusByChunkId.get(candidate.chunk.id);

    if (!orderBonus) {
      return candidate;
    }

    return {
      ...candidate,
      rerankScore: roundScore(candidate.rerankScore + orderBonus),
    };
  });
}

function compareFutureTaskSignals(
  left: PmsCandidateSignals,
  right: PmsCandidateSignals,
): number {
  const statusDelta = getFutureStatusRank(left.status) - getFutureStatusRank(right.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const dateDelta = compareNullableNumbers(left.nextDueDate, right.nextDueDate);
  if (dateDelta !== 0) {
    return dateDelta;
  }

  return compareNullableNumbers(left.nextDueHours, right.nextDueHours);
}

function getPmsCandidateSignals(
  content: string,
  docClass: DocumentDocClass,
  hints: DocumentRetrievalHints,
): PmsCandidateSignals {
  const normalized = normalizeComparableText(content);
  const normalizedFields = normalizeFieldText(content);
  const compact = normalized.replace(/\s+/gu, '');
  const sameEquipment = hints.equipmentOrSystem.some((hint) =>
    matchesHintInContent(hint, normalized, compact),
  );

  if (
    docClass !== DocumentDocClass.HISTORICAL_PROCEDURE ||
    !sameEquipment
  ) {
    return {
      sameEquipment,
      isEquipmentSummary: false,
      isMaintenanceRecord: false,
      hasTaskOverview: false,
      status: null,
      nextDueDate: null,
      nextDueHours: null,
    };
  }

  const isEquipmentSummary =
    /\bdoc_type\s*:\s*equipment_summary\b/u.test(normalizedFields) ||
    /\bequipment summary for\b/u.test(normalized);
  const isMaintenanceRecord =
    /\bdoc_type\s*:\s*maintenance_record\b/u.test(normalizedFields) ||
    /\bmaintenance record for\b/u.test(normalized);

  return {
    sameEquipment,
    isEquipmentSummary,
    isMaintenanceRecord,
    hasTaskOverview:
      /\btasks_overdue\s*:/u.test(normalizedFields) ||
      /\btasks_due_soon\s*:/u.test(normalizedFields) ||
      /\bnext upcoming task\b/u.test(normalized) ||
      /\ball registered maintenance tasks\b/u.test(normalized),
    status: extractStatus(normalizedFields),
    nextDueDate: extractDueDate(normalizedFields),
    nextDueHours: extractDueHours(normalizedFields),
  };
}

function getPmsSelectionIntent(question: string): PmsSelectionIntent | null {
  const normalized = normalizeComparableText(question);
  const hasMaintenanceContext =
    /\b(?:maintenance|service|tasks?|pms|tests?|inspections?|checks?|overhauls?)\b/u.test(
      normalized,
    );

  if (!hasMaintenanceContext) {
    return null;
  }

  if (
    /\b(?:next upcoming|future scheduled|not overdue)\b/u.test(normalized)
  ) {
    return 'upcoming';
  }

  if (
    /\b(?:overdue|needs attention|need attention|due now|currently due)\b/u.test(
      normalized,
    ) ||
    /\bwhat (?:maintenance|service|tasks?) (?:is|are) due\b/u.test(normalized)
  ) {
    return 'attention';
  }

  if (
    /\bnext\b/u.test(normalized) &&
    /\b(?:maintenance|service|scheduled)\b/u.test(normalized)
  ) {
    return 'next_scheduled';
  }

  return null;
}

function matchesHintInContent(
  hint: string,
  normalizedContent: string,
  compactContent: string,
): boolean {
  return buildHintAlternatives(hint).some((normalizedHint) => {
    const compactHint = normalizedHint.replace(/\s+/gu, '');

    if (!normalizedHint || compactHint.length < 4) {
      return false;
    }

    return (
      normalizedContent.includes(normalizedHint) ||
      compactContent.includes(compactHint) ||
      tokensMatchWithinWindow(normalizedHint, normalizedContent)
    );
  });
}

function buildHintAlternatives(hint: string): string[] {
  const normalizedHint = normalizeComparableText(hint);
  const alternatives = new Set<string>();

  if (normalizedHint) {
    alternatives.add(normalizedHint);
  }

  const sideExpanded = normalizedHint
    .replace(/\bportside\b/gu, 'port side')
    .replace(/\bstarboard\b/gu, 'starboard side')
    .replace(/\bstbd\b/gu, 'starboard');

  if (sideExpanded) {
    alternatives.add(sideExpanded);
    alternatives.add(sideExpanded.replace(/\bport side\b/gu, 'port'));
    alternatives.add(sideExpanded.replace(/\bstarboard side\b/gu, 'starboard'));
  }

  return [...alternatives].filter(Boolean);
}

function tokensMatchWithinWindow(
  normalizedHint: string,
  normalizedContent: string,
): boolean {
  const tokens = normalizedHint.split(/\s+/u).filter((token) => token.length >= 3);

  if (tokens.length < 2) {
    return false;
  }

  const anchor = tokens[0];
  const windowSize = 260;
  let index = normalizedContent.indexOf(anchor);

  while (index >= 0) {
    const start = Math.max(0, index - windowSize);
    const end = Math.min(normalizedContent.length, index + windowSize);
    const window = normalizedContent.slice(start, end);

    if (tokens.every((token) => window.includes(token))) {
      return true;
    }

    index = normalizedContent.indexOf(anchor, index + anchor.length);
  }

  return false;
}

function extractStatus(value: string): PmsTaskStatus | null {
  if (/\b(?:current\s+)?status\s*:\s*due[_\s-]?soon\b/u.test(value)) {
    return 'DUE_SOON';
  }
  if (/\b(?:current\s+)?status\s*:\s*overdue\b/u.test(value)) return 'OVERDUE';
  if (/\b(?:current\s+)?status\s*:\s*upcoming\b/u.test(value)) return 'UPCOMING';
  if (/\b(?:current\s+)?status\s*:\s*no[_\s-]?schedule\b/u.test(value)) {
    return 'NO_SCHEDULE';
  }
  return null;
}

function extractDueDate(value: string): number | null {
  const match =
    value.match(/\bnext_due_date\s*:\s*(\d{4}-\d{2}-\d{2})\b/u) ??
    value.match(
      /\b(?:next\s+service\s+is\s+)?due\s+(?:by|on)\s+(\d{4}-\d{2}-\d{2})\b/u,
    );
  const timestamp = match?.[1] ? Date.parse(`${match[1]}T00:00:00Z`) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function extractDueHours(value: string): number | null {
  const match =
    value.match(/\bnext_due_hours\s*:\s*(\d+(?:\.\d+)?)\b/u) ??
    value.match(
      /\b(?:next\s+service\s+is\s+)?due\s+(?:by|on)\s+\d{4}-\d{2}-\d{2}[^.]{0,80}\bat\s*(\d+(?:\.\d+)?)\s*(?:equipment\s*)?hours?\b/u,
    );
  const parsed = match?.[1] ? Number.parseFloat(match[1]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function getFutureStatusRank(status: PmsTaskStatus | null): number {
  if (status === 'DUE_SOON') return 0;
  if (status === 'UPCOMING') return 1;
  return 2;
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function normalizeComparableText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeFieldText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
