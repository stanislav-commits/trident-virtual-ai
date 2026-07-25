/**
 * Detects a bare "yes/confirm" reply to a pending write-action proposal
 * (task create/complete, defect log/close, metric watch, hours reading).
 *
 * Both the intent classifier and the semantic router are stateless,
 * single-question LLM calls with no conversation history — a content-free
 * "Да, подтверждаю" carries no signal either can route from, and has been
 * observed landing on small_talk, which has no tool access and fabricates a
 * plausible "done" reply with nothing actually written to the register. The
 * planner uses these two checks together to force such a reply straight to
 * the metrics/write-tools responder instead of risking a fresh classify.
 *
 * A confirmation that restates real content ("Да, подтверждаю: запиши этот
 * дефект...") already carries enough signal for the normal pipeline and is
 * intentionally NOT matched here — only a bare, content-free reply is.
 */

const CONFIRMATION_TOKEN =
  '(?:да|ага|угу|конечно|подтверждаю|подтверждено|верно|точно|правильно|согласен|согласна|давай(?:те)?|поехали|погнали|yes|yeah|yep|yup|correct|confirm(?:ed)?|ok(?:ay)?|ок(?:ей)?|go\\s*ahead|do\\s*it|sounds?\\s*good|all\\s*good|proceed|affirmative)';

/**
 * Words that ride along with a confirmation and carry no content of their
 * own. Without these, the single most natural Russian confirmation — "всё
 * верно" — failed the whole-string match (only "верно" was a known token),
 * fell through to a fresh classify, was labelled small_talk and answered by
 * the tool-less chat responder, which fabricated "Задача создана! ✅" while
 * nothing reached the register. Observed live 2026-07-26.
 */
const FILLER_TOKEN =
  '(?:вс[её]|так|именно|абсолютно|полностью|совершенно|тогда|it\'?s|that\'?s|all|everything|looks|sounds|good|fine)';

const ANY_CONFIRMATION_WORD = `(?:${CONFIRMATION_TOKEN}|${FILLER_TOKEN})`;

const BARE_CONFIRMATION_PATTERN = new RegExp(
  `^[\\s"'«»]*${ANY_CONFIRMATION_WORD}(?:[\\s,.:;!"'»]+${ANY_CONFIRMATION_WORD})*[\\s".,!:;»]*$`,
  'iu',
);

/**
 * Filler alone ("всё так") must not count as a confirmation, so at least one
 * real affirmative has to be present. NB: JS \b is ASCII-only and never
 * fires around Cyrillic — the boundaries here are letter lookarounds, which
 * also keep "неверно" from matching on its "верно" tail.
 */
const HAS_CONFIRMATION_TOKEN = new RegExp(
  `(?<!\\p{L})${CONFIRMATION_TOKEN}(?!\\p{L})`,
  'iu',
);

const PENDING_WRITE_PROPOSAL_PATTERN =
  /подтвержда|подтвердите|создать\s+задачу|создаём|создадим|записать\s+(?:дефект|этот\s+дефект|показания)|закрыть\s+дефект|начать\s+следить|перестать\s+следить|confirm\b|shall\s+i\b|should\s+i\s+(?:create|log|close|proceed)|do\s+you\s+want\s+me\s+to|go\s+ahead\s+and/iu;

/** Is this message a short, content-free affirmative ("да", "подтверждаю", "yes, confirm")? */
export function isBareConfirmationReply(text: string): boolean {
  const trimmed = text.trim();
  return (
    BARE_CONFIRMATION_PATTERN.test(trimmed) &&
    HAS_CONFIRMATION_TOKEN.test(trimmed)
  );
}

/**
 * Does this (presumably prior assistant) message read like a write-action
 * confirmation ask? Deliberately NOT gated on a literal "?" — the write
 * tools' prompts sometimes phrase the ask as an imperative ("Подтвердите,
 * если хотите...") rather than a question, and the keyword set below is
 * specific enough on its own to keep false positives low-risk (worst case,
 * the next bare "yes" reply just gets routed to the metrics responder,
 * which is a safe superset capability, not a wrong or unsafe one).
 */
export function looksLikePendingWriteProposal(text: string): boolean {
  return PENDING_WRITE_PROPOSAL_PATTERN.test(text);
}
