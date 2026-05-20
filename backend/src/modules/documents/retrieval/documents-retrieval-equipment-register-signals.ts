import { DocumentDocClass } from '../enums/document-doc-class.enum';

export const EQUIPMENT_REGISTER_COMPAT_DOC_CLASSES = [
  DocumentDocClass.REGULATION,
  DocumentDocClass.MANUAL,
  DocumentDocClass.HISTORICAL_PROCEDURE,
  DocumentDocClass.CERTIFICATE,
];

const EQUIPMENT_REGISTER_SEARCH_HINT =
  'equipment list equipment register asset register vessel equipment list asset_id_internal display_name SFI uploaded asset register';

const GENERIC_EQUIPMENT_REGISTER_TOKENS = new Set([
  'asset',
  'assets',
  'equipment',
  'equipments',
  'list',
  'register',
  'registry',
  'index',
  'inventory',
  'vessel',
  'ship',
  'boat',
  'onboard',
  'uploaded',
  'show',
  'find',
  'from',
  'search',
  'lookup',
  'have',
  'has',
  'installed',
  'listed',
  'present',
  'does',
  'this',
  'that',
  'there',
  'first',
  'items',
  'item',
  'rows',
  'row',
  'sfi',
]);

// TODO: Replace this compatibility layer with a structured
// asset_register/equipment_index service. The temporary rules below only make
// current uploaded register-style documents retrievable through document chat.
export function isEquipmentRegisterQuestion(value: string): boolean {
  const normalized = normalizeEquipmentRegisterText(value);

  if (!normalized) {
    return false;
  }

  const explicitRegisterQuestion =
    /\b(?:equipment|asset|sfi)\s+(?:list|register|registry|index|inventory)\b/u.test(
      normalized,
    ) ||
    /\b(?:vessel|ship|uploaded|full)\s+(?:equipment|asset)\s+(?:list|register|registry|index|inventory)\b/u.test(
      normalized,
    ) ||
    /\b(?:\u0441\u043f\u0438\u0441\u043e\u043a|\u043f\u0435\u0440\u0435\u043b\u0456\u043a|\u0440\u0435\u0454\u0441\u0442\u0440|\u0440\u0435\u0435\u0441\u0442\u0440)\s+(?:\u043e\u0431\u043b\u0430\u0434\u043d\u0430\u043d\u043d\u044f|\u043e\u0431\u043e\u0440\u0443\u0434\u043e\u0432\u0430\u043d\u0438\u044f|\u0430\u043a\u0442\u0438\u0432\u0456\u0432|\u0430\u043a\u0442\u0438\u0432\u043e\u0432)\b/u.test(
      normalized,
    );
  const assetExistenceQuestion =
    /\bdoes\s+(?:this\s+)?(?:vessel|ship|boat)\s+have\b/u.test(normalized) &&
    !/\bdoes\s+(?:this\s+)?(?:vessel|ship|boat)\s+have.{0,50}\b(?:certificate|certificates|manual|manuals|document|documents|regulation|regulations|permit|permits|licen[cs]e|licenses)\b/u.test(
      normalized,
    );
  const assetPresenceQuestion =
    /\b(?:installed|onboard|present|listed)\b/u.test(normalized) &&
    /\b(?:anodes?|pump|generator|genset|purifier|mgps|panel|valve|filter|door|sensor|system)\b/u.test(
      normalized,
    ) &&
    !/\b(?:manual|manuals|procedure|procedures|instruction|instructions|certificate|certificates|regulation|regulations)\b/u.test(
      normalized,
    );

  return explicitRegisterQuestion || assetExistenceQuestion || assetPresenceQuestion;
}

export function appendEquipmentRegisterSearchHints(
  searchQuestion: string,
  originalQuestion = searchQuestion,
): string {
  const combined = `${originalQuestion} ${searchQuestion}`;

  if (
    !isEquipmentRegisterQuestion(originalQuestion) &&
    !isEquipmentRegisterQuestion(searchQuestion)
  ) {
    return searchQuestion;
  }

  return appendUniqueText(
    searchQuestion,
    `${EQUIPMENT_REGISTER_SEARCH_HINT} ${buildEntitySearchHint(combined)}`,
  );
}

export function isEquipmentRegisterStyleEvidence(input: {
  question: string;
  content: string;
  fileName?: string | null;
}): boolean {
  if (!isEquipmentRegisterQuestion(input.question)) {
    return false;
  }

  const content = normalizeEquipmentRegisterText(input.content);
  const fileName = normalizeEquipmentRegisterText(input.fileName ?? '');
  const hasRegisterTitleSignal =
    /\b(?:equipment|asset)\s+(?:list|register|registry|index|inventory)\b/u.test(
      fileName,
    );
  const hasRegisterContentSignal =
    /\bequipment\s+list\b/u.test(content) ||
    /\basset\s+register\b/u.test(content) ||
    /\bequipment\s+register\b/u.test(content);
  const hasTableFieldSignal =
    /\basset\s*id\s*internal\b/u.test(content) ||
    /\bdisplay\s*name\b/u.test(content);

  return (
    (hasRegisterContentSignal && hasTableFieldSignal) ||
    (hasRegisterTitleSignal && hasTableFieldSignal)
  );
}

export function hasEquipmentRegisterEntitySupport(input: {
  question: string;
  content: string;
}): boolean {
  const entityTokens = getEquipmentRegisterEntityTokens(input.question);

  if (!entityTokens.length) {
    return true;
  }

  const contentTokens = tokenizeEquipmentRegisterText(input.content);

  return entityTokens.some((token) =>
    contentTokens.some(
      (contentToken) =>
        contentToken === token ||
        stripPluralSuffix(contentToken) === token ||
        contentToken === stripPluralSuffix(token),
    ),
  );
}

export function getEquipmentRegisterEvidenceBonus(input: {
  question: string;
  content: string;
  fileName?: string | null;
}): number {
  if (!isEquipmentRegisterStyleEvidence(input)) {
    return 0;
  }

  return hasEquipmentRegisterEntitySupport(input) ? 0.14 : 0.04;
}

function getEquipmentRegisterEntityTokens(question: string): string[] {
  return tokenizeEquipmentRegisterText(question).filter(
    (token) => !GENERIC_EQUIPMENT_REGISTER_TOKENS.has(token),
  );
}

function buildEntitySearchHint(question: string): string {
  const tokens = getEquipmentRegisterEntityTokens(question);
  const singularTokens = tokens
    .map((token) => stripPluralSuffix(token))
    .filter((token, index) => token !== tokens[index]);

  return Array.from(new Set([...tokens, ...singularTokens])).join(' ');
}

function appendUniqueText(base: string, addition: string): string {
  const baseTokens = new Set(tokenizeEquipmentRegisterText(base));
  const missingTerms = addition
    .split(/\s+/u)
    .filter((term) =>
      tokenizeEquipmentRegisterText(term).some((token) => !baseTokens.has(token)),
    );

  return missingTerms.length ? `${base} ${missingTerms.join(' ')}` : base;
}

function tokenizeEquipmentRegisterText(value: string): string[] {
  return Array.from(
    new Set(
      normalizeEquipmentRegisterText(value)
        .split(/\s+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

function normalizeEquipmentRegisterText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[_-]+/gu, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripPluralSuffix(value: string): string {
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}
