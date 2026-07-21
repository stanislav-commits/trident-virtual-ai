/**
 * Controlled-document codes (JMS management-company convention):
 * "JMS EM 002 01 Emergency Report V1.0" → code "EM 002 01".
 * The SMS manual references forms/checklists by exactly these codes, so the
 * code is the JOIN KEY between a procedure's text and the uploaded form:
 * forms carry `doc_code` (parsed from the filename), procedures/circulars
 * carry `form_refs` (codes scanned out of their PDF text), and linking is a
 * lookup by code at read time — no ordering or manual step involved.
 */

/** JMS department prefixes seen in the controlled-document register. */
const DEPT = '(EM|AD|CW|HS|ENG|DCK|NAV|SEC)';

/**
 * Matches controlled codes in the shapes they occur in:
 * - lettered, separated: "AD 002 A 01", "AD-002-A-01" — a mid-code letter
 *   segment (e.g. yacht cert data sheets, "Form AD-002-A-01" per the
 *   document's own printed title). Requires an explicit separator around
 *   the letter — pdf-parse's concatenated text layer is too noisy to guess
 *   a bare letter-between-digits reliably (could be anything).
 * - plain, separated: "EM 002 01", "EM-002-01", "JMS EM 002 1" (filenames,
 *   clean text) — lax digit counts, the SMS is not typed consistently.
 * - plain, concatenated: "EM00201" — pdf-parse loses the spaces in the SMS
 *   PDFs' text layer ("FormEM00201EMERGENCYREPORT"), leaving dept + exactly
 *   5 digits (3-digit group + 2-digit item). "EM002" alone is a SECTION
 *   heading, not a form — the item digits are required.
 */
const CODE_RE = new RegExp(
  // The SMS PDFs' text layer is concatenated ("FormEM00201EMERGENCYREPORT"),
  // so a plain \b never fires — anchor on either a non-alphanumeric boundary
  // or the literal word "Form" glued to the code. The latter also keeps
  // lookalikes ("SYSTEM00201") out: a letter before the dept is only allowed
  // when that letter run is "Form".
  `(?:(?<=[Ff]orm)|(?<![A-Za-z0-9]))(?:JMS[\\s.-]*)?(` +
    `${DEPT}(?:` +
    `[\\s.-]+(\\d{1,3})[\\s.-]+([A-Za-z])[\\s.-]+(\\d{1,2})(?!\\d)` + // lettered, separated
    `|[\\s.-]+(\\d{1,3})[\\s.-]+(\\d{1,2})(?!\\d)` + // plain, separated
    `|(\\d{3})(\\d{2})(?!\\d)` + // plain, concatenated
    `)` +
    `)`,
  'gi',
);

/**
 * The document's OWN controlled code from its (file)name, or null.
 * "JMS yyyy-MM-dd AD 002 01 Monthly SMS Review V.3.0.xlsx" → "AD 002 01".
 * "JMS yyyy-mm-dd AD 002 A 01 YCDS V.2.1.xlsx" → "AD 002 A 01".
 *
 * Group map: 1=code body, 2=dept, 3/4/5=group/letter/item (lettered,
 * separated), 6/7=group/item (plain, separated), 8/9=group/item (plain,
 * concatenated).
 */
function matchToCode(match: RegExpExecArray | RegExpMatchArray): string {
  const dept = match[2].toUpperCase();
  if (match[4] !== undefined) {
    // Lettered code: DELIBERATELY do not normalize the separator away like
    // the plain shape does. If a procedure's text writes this code with a
    // hyphen ("AD-002-A-01") but the form's own filename was typed with
    // plain spaces ("AD 002 A 01") — or vice versa — the two canonical
    // strings come out literally different and DON'T match, so the pair
    // is not auto-linked. An inconsistent naming convention is a real
    // signal to confirm the link by hand (KB edit modal) rather than trust
    // a code match that only lines up after aggressive normalization.
    const hyphenated = /-/.test(match[1]);
    const sep = hyphenated ? '-' : ' ';
    return [
      dept,
      match[3].padStart(3, '0'),
      match[4].toUpperCase(),
      match[5].padStart(2, '0'),
    ].join(sep);
  }
  const group = match[6] ?? match[8];
  const item = match[7] ?? match[9];
  return `${dept} ${group.padStart(3, '0')} ${item.padStart(2, '0')}`;
}

/**
 * Strip a controlled-form filename down to a human name — drops "JMS", the
 * date placeholder, the code itself, version and extension. E.g.
 * "JMS yyyy-MM-dd ENG 008 01 Bunkering Checklist V.2.0.pdf" → "Bunkering
 * Checklist". Best-effort; '' if nothing readable remains.
 */
export function cleanFormName(fileName: string | null | undefined): string {
  if (!fileName) return '';
  return fileName
    .replace(/\.[a-z0-9]+$/i, '') // extension
    .replace(/^JMS\s+/i, '')
    .replace(/\byyyy[-/]?mm[-/]?dd\b/gi, '')
    .replace(
      new RegExp(
        `\\b${DEPT}\\s*\\d{1,3}(?:\\s*[A-Za-z])?\\s*\\d{1,2}\\b`,
        'gi',
      ),
      '',
    )
    .replace(/\bv[.\s]*\d+(?:[.\s]*\d+)*\b/gi, '') // version
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseDocCode(name: string | null | undefined): string | null {
  if (!name) return null;
  CODE_RE.lastIndex = 0;
  const match = CODE_RE.exec(name);
  return match ? matchToCode(match) : null;
}

/**
 * Every distinct controlled code referenced in a body of text (an SMS
 * procedure or fleet circular). Order of first appearance is preserved.
 */
export function scanFormRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  CODE_RE.lastIndex = 0;
  for (const match of text.matchAll(CODE_RE)) {
    const code = matchToCode(match);
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
