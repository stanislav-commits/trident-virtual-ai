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
  '(?:да|ага|угу|конечно|подтверждаю|подтверждено|верно|точно|правильно|yes|yeah|yep|yup|correct|confirm(?:ed)?|ok(?:ay)?|go\\s*ahead|do\\s*it|sounds?\\s*good|proceed|affirmative)';

const BARE_CONFIRMATION_PATTERN = new RegExp(
  `^[\\s"'«»]*${CONFIRMATION_TOKEN}(?:[\\s,.:;!"'»]+${CONFIRMATION_TOKEN})*[\\s".,!:;»]*$`,
  'iu',
);

const PENDING_WRITE_PROPOSAL_PATTERN =
  /подтвержда|подтвердите|создать\s+задачу|создаём|создадим|записать\s+(?:дефект|этот\s+дефект|показания)|закрыть\s+дефект|начать\s+следить|перестать\s+следить|confirm\b|shall\s+i\b|should\s+i\s+(?:create|log|close|proceed)|do\s+you\s+want\s+me\s+to|go\s+ahead\s+and/iu;

/** Is this message a short, content-free affirmative ("да", "подтверждаю", "yes, confirm")? */
export function isBareConfirmationReply(text: string): boolean {
  return BARE_CONFIRMATION_PATTERN.test(text.trim());
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
