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
 * Matches controlled codes in BOTH shapes they occur in:
 * - separated: "EM 002 01", "EM-002-01", "JMS EM 002 1" (filenames, clean
 *   text) — lax digit counts, the SMS is not typed consistently;
 * - concatenated: "EM00201" — pdf-parse loses the spaces in the SMS PDFs'
 *   text layer ("FormEM00201EMERGENCYREPORT"), leaving dept + exactly 5
 *   digits (3-digit group + 2-digit item). "EM002" alone is a SECTION
 *   heading, not a form — the item digits are required.
 */
const CODE_RE = new RegExp(
  // The SMS PDFs' text layer is concatenated ("FormEM00201EMERGENCYREPORT"),
  // so a plain \b never fires — anchor on either a non-alphanumeric boundary
  // or the literal word "Form" glued to the code. The latter also keeps
  // lookalikes ("SYSTEM00201") out: a letter before the dept is only allowed
  // when that letter run is "Form".
  `(?:(?<=[Ff]orm)|(?<![A-Za-z0-9]))(?:JMS[\\s.-]*)?${DEPT}(?:[\\s.-]+(\\d{1,3})[\\s.-]+(\\d{1,2})(?!\\d)|(\\d{3})(\\d{2})(?!\\d))`,
  'gi',
);

function canonical(dept: string, group: string, item: string): string {
  return `${dept.toUpperCase()} ${group.padStart(3, '0')} ${item.padStart(2, '0')}`;
}

/**
 * The document's OWN controlled code from its (file)name, or null.
 * "JMS yyyy-MM-dd AD 002 01 Monthly SMS Review V.3.0.xlsx" → "AD 002 01".
 */
function matchToCode(match: RegExpExecArray | RegExpMatchArray): string {
  // Groups 2+3 = separated shape, groups 4+5 = concatenated shape.
  return canonical(match[1], match[2] ?? match[4], match[3] ?? match[5]);
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
