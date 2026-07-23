/**
 * Removes markdown-table blocks (consecutive lines starting/ending with a
 * pipe — this also matches the "|---|---|" separator row) from an answer.
 *
 * Used whenever a turn already rendered a visual presentation block
 * (render_table / render_kpi) whose values are duplicated as a markdown
 * table in the model's own prose despite the tool descriptions forbidding
 * it — prompt-only steering did not reliably stop this, so the strip is
 * deterministic rather than relying on the model's compliance.
 */
export function stripDuplicateMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l.trim());
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i])) {
      while (i < lines.length && isTableRow(lines[i])) i++;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
