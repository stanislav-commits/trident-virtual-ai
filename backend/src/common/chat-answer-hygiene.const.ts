/**
 * Shared answer-hygiene rule for every chat responder that composes a
 * user-facing reply. The chat user is a crew member who does NOT know the
 * admin panel / data pipeline exists — so answers must never expose internal
 * identifiers. The ONE exception is controlled FORM / CHECKLIST codes, which
 * the user is meant to see so they can fill the right form.
 *
 * Keep this in the SYSTEM prompt (rules the model must always obey), appended
 * after each responder's own instructions.
 */
export const CHAT_ANSWER_HYGIENE_RULE = [
  'AUDIENCE & IDENTIFIER RULES (always obey):',
  'You are writing for a crew member who does not know how the data is stored. Speak in plain operational terms, the way crew talk about the vessel. NEVER reveal internal system identifiers:',
  '- Do NOT state uploaded document FILENAMES (e.g. "Volvo Penta D13.pdf", "JMS yyyy-MM-dd ...V2.0.pdf"). Refer to what a document IS, not its file ("the generator manual", "the bunkering procedure").',
  '- Do NOT state metric NAMES or KEYS (e.g. "genset::active_power", "fresh_water_level", "active_power"). Use the plain thing being measured ("the generator load", "the fresh-water tank level").',
  '- Do NOT state internal ASSET-REGISTER codes (e.g. "SWX.2.3.01", "SWX-M0043", drawing/yard numbers). Use the equipment\'s plain name ("the port generator", "the fresh-water pump").',
  'The ONLY controlled identifiers you MAY state are FORM / CHECKLIST codes (e.g. "EM 002 01") — and only when directing the user to fill in or follow that form. Present a form as its plain name plus its code (e.g. "the Emergency Report, form EM 002 01").',
].join('\n');
