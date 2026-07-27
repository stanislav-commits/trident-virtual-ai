/**
 * Detects a request ABOUT the conversation itself rather than about the
 * vessel — "переведи на английский", "rephrase that", "покороче".
 *
 * These have no meaning outside the thread: the thing to translate or
 * shorten is the assistant's previous answer. But the decomposer rewrites
 * every ask into a standalone question and the classifier then sees a
 * context-free "translate the proposed task" — which was routed to
 * `documentation`, fell through the documents→web fallback and came back
 * from a stateless web responder asking the user to paste the text it was
 * supposed to already have (observed live 2026-07-27, after an English
 * conversation).
 *
 * Only a SHORT, content-free meta instruction matches. Anything that names
 * real subject matter ("переведи инструкцию по замене топливного фильтра")
 * exceeds the tail budget and falls through to the normal pipeline, which
 * can retrieve that document properly.
 */

const META_VERB =
  '(?:переведи|перевести|перевод|переформулируй|перефразируй|перепиши|повтори|сократи|упрости|расшифруй|подробнее|короче|кратко|' +
  'translate|rephrase|reword|rewrite|repeat|shorten|simplify|summari[sz]e|expand)';

/**
 * Verb, then at most a short tail — a target language or a qualifier
 * ("на английский", "to english", "please", "по-русски"). NB: JS \b is
 * ASCII-only and never fires before a Cyrillic letter, so the verb is
 * anchored with ^ and a non-letter lookahead instead.
 */
const CONVERSATION_META_PATTERN = new RegExp(
  `^[\\s"'«»]*${META_VERB}(?![\\p{L}])[^.?!]{0,32}[\\s".,!?:;»]*$`,
  'iu',
);

/** Is this turn asking to restate/translate what was already said here? */
export function isConversationMetaRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) return false;
  return CONVERSATION_META_PATTERN.test(trimmed);
}
