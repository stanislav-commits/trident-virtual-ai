import { ChatMessageEntity } from '../../entities/chat-message.entity';
import { ChatMessageRole } from '../../enums/chat-message-role.enum';
import {
  isAdministrativeComplianceIntent,
  isMaintenanceRecordIntent,
} from './document-maintenance-intent';

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

  // Recover the equipment subject from a prior turn for an anchor-less follow-up.
  // A terse follow-up that names a component/action but no primary equipment
  // ("Fuel filter replacement" right after "...on the PS generator") otherwise
  // loses the retrieval anchor, which collapses RAGFlow relevance and trips the
  // automatic web fallback. Only backfill when the CURRENT ask names no primary
  // equipment of its own (a component noun like "filter" is not enough), and
  // only from the most recent prior user turn that did name one.
  const recoveredSubject = mentionsPrimaryEquipmentSubject(sourceText)
    ? null
    : extractRecentEquipmentSubject(input);

  // Suppress the generic fuel-filter term-bag once we have a concrete equipment
  // anchor to lean on (here: a recovered prior subject). Same rationale as the
  // maintenance-schedule bag below — the generic vocabulary dilutes a focused
  // equipment query and biases retrieval toward whichever manual has the densest
  // generic maintenance text, pushing the correct equipment manual down.
  if (isFuelFilterReplacementQuestion(sourceText) && !recoveredSubject) {
    enrichmentParts.push(FUEL_FILTER_REPLACEMENT_QUERY);
  }

  if (
    isMaintenanceScheduleQuestion(sourceText) &&
    !isMaintenanceRecordIntent(sourceText)
  ) {
    const runningHours = extractRelevantRunningHours(input);

    // Only inject the generic maintenance-schedule vocabulary for VAGUE
    // questions ("what maintenance is due?"). When the question already names a
    // concrete piece of equipment (e.g. "air compressor"), appending the generic
    // term-bag ("running hours / service interval / section maintenance ...")
    // dilutes the equipment signal and biases retrieval toward whichever manual
    // has the densest generic maintenance vocabulary (the OTC separator), pushing
    // the correct equipment manual out of the top results. The clean
    // equipment-focused query already ranks the right manual first.
    if (!mentionsSpecificEquipment(sourceText) && !recoveredSubject) {
      enrichmentParts.push(MAINTENANCE_SCHEDULE_QUERY);
    }

    if (runningHours) {
      enrichmentParts.push(`${runningHours} running hours`);
    }
  }

  if (recoveredSubject) {
    enrichmentParts.push(recoveredSubject);
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

// Recognisable marine-equipment nouns. When one of these appears in the
// question, the equipment term itself is the strongest retrieval signal, so we
// skip the generic maintenance-schedule term-bag (which would otherwise drown it
// out). Kept deliberately to concrete equipment — not generic words like
// "system" — to avoid false positives on vague maintenance questions.
const SPECIFIC_EQUIPMENT_PATTERN =
  /\b(?:compressor|pump|engine|generator|genset|separator|purifier|centrifuge|boiler|thruster|winch|windlass|crane|davit|watermaker|desalinator|alternator|motor|gearbox|gear ?box|propeller|stabili[sz]er|anchor|chiller|macerator|bilge|sounder|monitor|sensor|inverter|ups|battery charger|switchboard|valve|actuator|hydraulic|steering gear|sewage|incinerator|heat exchanger|cooler|filter)\b/u;

export function mentionsSpecificEquipment(value: string): boolean {
  return SPECIFIC_EQUIPMENT_PATTERN.test(normalizeComparableText(value));
}

// A narrower set than SPECIFIC_EQUIPMENT_PATTERN: only PRIMARY equipment
// (the machine/asset a manual is about), NOT components. "filter", "valve",
// "sensor", "cartridge", "belt" are components — a follow-up like "fuel filter
// replacement" names a component but no primary subject, so it still needs the
// prior turn's equipment ("PS generator") to retrieve correctly. The trailing
// (?:e?s)? matches plurals ("generators", "aux engines", "winches").
const PRIMARY_EQUIPMENT_SUBJECT_SOURCE =
  '\\b(?:main engine|auxiliary engine|aux engine|engine|generator|genset|gen ?set|compressor|pump|separator|purifier|centrifuge|boiler|thruster|winch|windlass|crane|davit|watermaker|desalinator|desalini[sz]er|alternator|motor|gearbox|gear ?box|propeller|stabili[sz]er|chiller|macerator|incinerator|switchboard|steering gear|heat exchanger|sewage (?:plant|treatment)|hydraulic power ?pack)(?:e?s)?\\b';
const PRIMARY_EQUIPMENT_SUBJECT_PATTERN = new RegExp(
  PRIMARY_EQUIPMENT_SUBJECT_SOURCE,
  'u',
);
const PRIMARY_EQUIPMENT_SUBJECT_PATTERN_GLOBAL = new RegExp(
  PRIMARY_EQUIPMENT_SUBJECT_SOURCE,
  'gu',
);

export function mentionsPrimaryEquipmentSubject(value: string): boolean {
  return PRIMARY_EQUIPMENT_SUBJECT_PATTERN.test(normalizeComparableText(value));
}

function primaryEquipmentNounKey(noun: string): string {
  return noun.replace(/(?:es|s)$/u, '');
}

// Position/role qualifiers that pin down WHICH unit ("PS generator", "port main
// engine"). Only these are carried in front of the noun — arbitrary preceding
// words (components, verbs, bare quantity digits, the negation "no") are never
// lifted, so the anchor stays clean.
const EQUIPMENT_QUALIFIER_TOKEN =
  /^(?:port|starboard|ps|sb|stbd|stb|fwd|forward|aft|upper|lower|main|emergency|auxiliary|aux)$/u;

// Substance / state / measurement / position words. These recur across
// unrelated questions ("fuel", "oil", "system", "located", "port"), so a shared
// one of these is NOT evidence that a follow-up continues the same topic —
// excluding them from the continuity check stops a new topic from inheriting a
// stale equipment subject.
const GENERIC_CONTINUITY_TOKENS = new Set([
  'fuel', 'oil', 'water', 'sea', 'seawater', 'freshwater', 'fresh', 'coolant',
  'gas', 'hot', 'cold', 'warm', 'low', 'high', 'pressure', 'temperature',
  'temp', 'level', 'levels', 'located', 'location', 'reading', 'readings',
  'value', 'values', 'system', 'systems', 'unit', 'units', 'side', 'normal',
  'running', 'status', 'onboard', 'ship', 'vessel', 'port', 'starboard',
  'main', 'emergency', 'auxiliary', 'aux', 'forward', 'aft', 'upper', 'lower',
]);

// Words with no retrieval signal, stripped from the current-ask token set used
// for the topical-continuity check.
const CONTINUITY_STOPWORDS = new Set([
  'how', 'the', 'and', 'for', 'are', 'does', 'did', 'you', 'your', 'please',
  'can', 'could', 'would', 'should', 'need', 'what', 'when', 'where', 'which',
  'who', 'change', 'changing', 'changed', 'replace', 'replacing', 'replacement',
  'renew', 'renewing', 'service', 'servicing', 'maintain', 'maintenance',
  'remove', 'removing', 'install', 'installing', 'procedure', 'process',
  'steps', 'step', 'guide', 'instructions', 'with', 'from', 'this', 'that',
  'its', 'about', 'tell', 'show', 'give', 'some', 'any', 'now', 'there', 'here',
  'one', 'ones',
]);

interface RecoveredEquipment {
  phrase: string;
  nounKey: string;
}

// Pull a prior USER turn's primary-equipment subject so a terse follow-up can
// inherit it. Two guards keep it high-precision: (1) topical continuity — the
// follow-up must share a SPECIFIC (non-generic) word with the prior turn; and
// (2) no ambiguity — the continuity-relevant prior turns must point at a single
// distinct machine, else we defer to the LLM decomposer rather than guess.
export function extractRecentEquipmentSubject(
  input: Pick<EnrichDocumentSearchQuestionInput, 'originalQuestion' | 'messages'>,
): string | null {
  const currentTokens = salientTokens(input.originalQuestion);

  if (!currentTokens.size) {
    return null;
  }

  const userMessages = (input.messages ?? [])
    .filter((message) => !message.deletedAt)
    .filter((message) => message.role === ChatMessageRole.USER);
  // Drop the current turn — always the most recent USER message, whether the
  // ask is the raw message or a synthetic decomposed component — so a compound
  // current message can never anchor its own components to itself.
  const priorUserMessages = userMessages.slice(0, -1);

  const matches: RecoveredEquipment[] = [];

  for (const message of [...priorUserMessages].reverse().slice(0, 8)) {
    if (!hasTokenOverlap(currentTokens, salientTokens(message.content))) {
      continue;
    }

    const recovered = extractEquipmentSubjectPhrase(message.content);

    if (recovered) {
      matches.push(recovered);
    }
  }

  if (!matches.length) {
    return null;
  }

  // Ambiguity guard: if the continuity-relevant thread mentioned more than one
  // distinct machine, we cannot safely tell which the terse follow-up means.
  const distinctNouns = new Set(matches.map((match) => match.nounKey));

  if (distinctNouns.size !== 1) {
    return null;
  }

  return matches[0].phrase;
}

function salientTokens(text: string): Set<string> {
  return new Set(
    normalizeComparableText(text)
      .split(' ')
      .filter(
        (word) =>
          word.length >= 3 &&
          !CONTINUITY_STOPWORDS.has(word) &&
          !GENERIC_CONTINUITY_TOKENS.has(word),
      ),
  );
}

function hasTokenOverlap(current: Set<string>, prior: Set<string>): boolean {
  for (const token of current) {
    if (prior.has(token)) {
      return true;
    }
  }

  return false;
}

// Build a clean anchor phrase: the primary equipment noun plus any position
// qualifiers directly in front of it ("ps generator", "no 2 engine"). Only
// allow-listed qualifier tokens are lifted, so components ("filter"), verbs and
// filler never leak in and a multi-word noun is kept whole (no "main main
// engine"). Returns null when the turn names MORE THAN ONE distinct machine
// ("compare the port engine and the generator") — we cannot tell which the
// follow-up means, so we defer rather than anchor to the leftmost one.
function extractEquipmentSubjectPhrase(
  content: string,
): RecoveredEquipment | null {
  const normalized = normalizeComparableText(content);
  const matches = [
    ...normalized.matchAll(PRIMARY_EQUIPMENT_SUBJECT_PATTERN_GLOBAL),
  ];

  if (!matches.length) {
    return null;
  }

  const distinctNouns = new Set(
    matches.map((match) => primaryEquipmentNounKey(match[0])),
  );

  if (distinctNouns.size !== 1) {
    return null;
  }

  const match = matches[0];
  const noun = match[0];
  const before = normalized
    .slice(0, match.index)
    .split(' ')
    .filter(Boolean);
  const qualifiers: string[] = [];

  for (let i = before.length - 1; i >= 0 && qualifiers.length < 3; i -= 1) {
    if (!EQUIPMENT_QUALIFIER_TOKEN.test(before[i])) {
      break;
    }

    qualifiers.unshift(before[i]);
  }

  return {
    phrase: [...qualifiers, noun].join(' '),
    nounKey: primaryEquipmentNounKey(noun),
  };
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
