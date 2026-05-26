import { formatConciseWebInformation } from './chat-source-aware-web-formatting';

interface SourceAwareSectionEntry {
  summary: string;
  repeatedLeadingText?: string | null;
}

interface SourceAwareSectionOptions {
  conciseWebInformation?: boolean;
  groupRelatedEntries?: boolean;
  collapseRepeatedLeadingBoilerplate?: boolean;
}

export function formatSourceAwareSection(
  title: string,
  entries: SourceAwareSectionEntry[],
  options: SourceAwareSectionOptions = {},
): string {
  let summaries = dedupeSummaries(
    entries
      .map((entry) =>
        normalizeSourceAwareSectionBody(title, entry.summary, entry.repeatedLeadingText),
      )
      .filter(Boolean),
  );

  if (options.collapseRepeatedLeadingBoilerplate) {
    summaries = removeRepeatedLeadingBoilerplate(summaries);
  }

  const body = options.conciseWebInformation
    ? formatConciseWebInformation(summaries)
    : options.groupRelatedEntries && summaries.length > 1
      ? formatAsChecklist(summaries)
      : summaries.join('\n\n');

  if (!body) {
    return '';
  }

  return [`## ${title}`, body].join('\n\n');
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

function removeRepeatedLeadingBoilerplate(summaries: string[]): string[] {
  const seen = new Set<string>();

  return summaries
    .map((summary) => {
      const leadingSentence = summary.match(/^[^.!?\n]+[.!?](?:\s+|$)/u)?.[0];

      if (!leadingSentence || !isDocumentBoilerplate(leadingSentence)) {
        return summary;
      }

      const key = leadingSentence.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        return summary;
      }

      return summary.slice(leadingSentence.length).trim();
    })
    .filter(Boolean);
}

function isDocumentBoilerplate(value: string): boolean {
  return (
    /\b(?:ship|uploaded)\s+documents?\b/iu.test(value) &&
    /\b(?:could not|cannot|did not|insufficient|not enough|no usable|weak|ambiguous|not confirm)\b/iu.test(
      value,
    )
  );
}

function formatAsChecklist(summaries: string[]): string {
  if (summaries.some(hasStructuredBlockContent)) {
    return summaries.join('\n\n');
  }

  return summaries
    .map((summary) => {
      const [firstLine, ...rest] = summary.split(/\r?\n/);

      return [
        `- ${firstLine}`,
        ...rest.map((line) => (line.trim() ? `  ${line}` : '')),
      ].join('\n');
    })
    .join('\n');
}

function hasStructuredBlockContent(summary: string): boolean {
  return /^(?:#{1,6}[ \t]+|\|.+\|[ \t]*$)/mu.test(summary);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
