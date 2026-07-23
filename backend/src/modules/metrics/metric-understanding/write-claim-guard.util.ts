/**
 * Deterministic honesty guard for the analyzer's write tools.
 *
 * Observed live (2026-07-23): even when correctly routed with all write tools
 * available, the model sometimes SKIPS the tool call and fabricates a
 * "Задача создана! ✅" final answer — nothing reaches the register, and the
 * crew walks away believing it did. Prompt instructions alone did not stop
 * this, so — same philosophy as stripDuplicateMarkdownTables — the loop
 * checks the invariant in code: a final answer may claim a completed register
 * write ONLY if a write tool actually succeeded this turn. On violation the
 * answer is withheld and the model gets ONE corrective round to either
 * perform the (already confirmed) write for real or restate without the
 * false claim.
 *
 * Detection is a heuristic over the answer text; a false positive only costs
 * one extra LLM round (the correction note tells the model to answer
 * unchanged if it wasn't claiming a new write), so recall is favoured over
 * precision. Past-tense/perfective success forms are matched; proposals
 * ("создать задачу?", "вот что я создам"), refusals ("не создана",
 * "not created") and history statements ("была создана 12 июня") are
 * excluded via form choice and lookbehinds.
 */

/** Keep in sync with the write-tool cases in dispatchToolCall(). */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_maintenance_task',
  'complete_maintenance_task',
  'log_hours_reading',
  'create_metric_watch',
  'remove_metric_watch',
  'log_defect',
  'close_defect',
]);

/** Things the write tools write: tasks, defects, watches, hours, records. */
const WRITE_NOUN_PATTERN =
  /задач|дефект|поломк|наблюдени|показани|моточас|запис[ьи]|регистр|реестр|task|defect|watch|reading|hours|register/iu;

/**
 * Perfective-past / passive-participle success forms. Deliberately absent:
 * infinitives (создать), future (создам / будет создана — see lookbehinds)
 * and nouns (создание), which is what legitimate proposals use.
 */
// NB: JS \b is ASCII-only and never fires around Cyrillic — the RU branch
// uses a (?!\p{L}) lookahead as its word boundary instead. That also blocks
// participial-adjective forms ("созданной задачи" in a proposal) because
// the next char is a letter.
const SUCCESS_VERB_PATTERN = new RegExp(
  '(?<!не\\s)(?<!будет\\s)(?<!будут\\s)(?<!быть\\s)(?<!была\\s)(?<!были\\s)(?<!был\\s)(?<!чтобы\\s)(?<!чтобы\\sя\\s)' +
    '(?:' +
    'создан[аоы]?|создал[аи]?|' +
    'записан[аоы]?|записал[аи]?|' +
    'закрыт[аоы]?|закрыл[аи]?|' +
    'добавлен[аоы]?|добавил[аи]?|' +
    'внесен[аоы]?|внесён|внесл[аи]?|' +
    'зафиксирован[аоы]?|зафиксировал[аи]?|' +
    'отмечен[аоы]?|отметил[аи]?|' +
    'удален[аоы]?|удалён|удалил[аи]?|' +
    'завершен[аоы]?|завершён|' +
    'сохранен[аоы]?|сохранён' +
    ')(?!\\p{L})' +
    '|(?<!not\\s)(?<!isn\'t\\s)(?<!wasn\'t\\s)(?<!will\\sbe\\s)(?<!to\\sbe\\s)' +
    '\\b(?:created|logged|recorded|closed|added|removed|marked|completed|saved|registered)\\b',
  'iu',
);

/**
 * Does this final answer claim that a register write has been completed?
 * Requires a write-register noun plus a success verb form. A bare "✅" is
 * deliberately NOT a signal on its own — honest status listings (morning
 * brief, task checklists) use ✅ markers routinely, and every observed
 * fabrication matches the verb pattern anyway.
 */
export function claimsRegisterWriteSuccess(answer: string): boolean {
  return WRITE_NOUN_PATTERN.test(answer) && SUCCESS_VERB_PATTERN.test(answer);
}

/**
 * Appended deterministically when the model repeats an unverified write
 * claim even after the corrective round. Bilingual because the answer
 * language is model-chosen and unknowable here; being blunt in both beats
 * letting the crew believe a phantom register write.
 */
export const WRITE_CLAIM_UNVERIFIED_DISCLAIMER =
  '⚠️ Проверка системы: запись в регистр НЕ выполнена — инструмент записи не был вызван, данные не сохранены. ' +
  'System check: nothing was actually written to the register — no write tool was called.';

/**
 * Injected as a user-role system note when the guard trips — mirrors the
 * existing dropped-tool-calls note pattern in the same loop.
 */
export const WRITE_CLAIM_CORRECTION_NOTE =
  '[system note] Your answer claims a register write (task / defect / watch / ' +
  'hours reading) was completed, but NO write tool call succeeded in this turn — ' +
  'NOTHING has been written. Do one of the following now: (1) if the user ' +
  'explicitly confirmed this exact action in this conversation, call the ' +
  'appropriate write tool with confirmed:true; (2) if they have not confirmed ' +
  'yet, state what you would write and ask for confirmation — WITHOUT claiming ' +
  'anything was created or saved; (3) if your answer was only describing ' +
  'records that already exist (not reporting a new write), repeat it unchanged. ' +
  'Never state that something was written to the register unless a tool call ' +
  'in this conversation returned ok:true for it.';
