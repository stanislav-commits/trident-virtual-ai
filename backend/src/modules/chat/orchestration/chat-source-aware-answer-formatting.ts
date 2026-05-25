interface SourceAwareSectionEntry {
  summary: string;
  repeatedLeadingText?: string | null;
}

export function formatSourceAwareSection(
  title: string,
  entries: SourceAwareSectionEntry[],
): string {
  const summaries = dedupeSummaries(
    entries
      .map((entry) =>
        normalizeSourceAwareSectionBody(title, entry.summary, entry.repeatedLeadingText),
      )
      .filter(Boolean),
  );

  if (!summaries.length) {
    return '';
  }

  return [`## ${title}`, summaries.join('\n\n')].join('\n\n');
}

function normalizeSourceAwareSectionBody(
  title: string,
  summary: string,
  repeatedLeadingText?: string | null,
): string {
  let normalized = stripRepeatedLeadingText(summary.trim(), repeatedLeadingText);

  normalized = stripRedundantSectionHeading(normalized, title)
    .replace(/^(?:#{1,6}[ \t]+)?Source[ \t]+\d+[ \t]*:?[ \t]*$/gimu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized;
}

function stripRepeatedLeadingText(
  summary: string,
  repeatedLeadingText?: string | null,
): string {
  const prefix = repeatedLeadingText?.trim();

  if (!prefix) {
    return summary;
  }

  const prefixPattern = escapeRegExp(prefix).replace(/\\ /g, '\\s+');
  const withoutPrefix = summary
    .replace(new RegExp(`^${prefixPattern}(?:\\s*[:\\-]?\\s*)?`, 'iu'), '')
    .trim();

  return withoutPrefix || summary;
}

function stripRedundantSectionHeading(summary: string, title: string): string {
  const headingPattern = new RegExp(
    `^(?:#{1,6}\\s+)?${escapeRegExp(title)}\\s*:?\\s*(?:\\r?\\n|$)`,
    'iu',
  );

  return summary.replace(headingPattern, '').trim();
}

function dedupeSummaries(summaries: string[]): string[] {
  const seen = new Set<string>();

  return summaries.filter((summary) => {
    const key = summary.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
