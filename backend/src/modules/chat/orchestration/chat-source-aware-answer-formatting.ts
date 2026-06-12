import { formatConciseWebInformation } from './chat-source-aware-web-formatting';

interface SourceAwareSectionEntry {
  summary: string;
  repeatedLeadingText?: string | null;
}

/**
 * Flowing-prose alternative to two sequential `formatSourceAwareSection`
 * calls. Produces ONE clean answer with no `## Ship documents` /
 * `## Web information` headers and no "I could not find sufficient
 * evidence..." preamble. Used for chat replies where the user wants a soft
 * conversational answer rather than a structured report.
 *
 * Document entries that are nothing more than "no documents matched"
 * boilerplate are dropped silently — the web answer alone speaks for itself.
 */
export function composeFlowingSourceProse(
  documentSummaries: SourceAwareSectionEntry[],
  webSummaries: SourceAwareSectionEntry[],
): string {
  const docs = documentSummaries
    .map((entry) =>
      normalizeSourceAwareSectionBody(
        'Ship documents', entry.summary, entry.repeatedLeadingText,
      ),
    )
    .filter((s) => s && !isPureNoEvidenceBoilerplate(s));

  const webs = webSummaries
    .map((entry) =>
      normalizeSourceAwareSectionBody(
        'Web information', entry.summary, entry.repeatedLeadingText,
      ),
    )
    .map(softenWebProse)
    .filter(Boolean);

  return dedupeSummaries([...docs, ...webs]).join('\n\n').trim();
}

/**
 * True when the docs answer is essentially "we have no matching documents
 * for this question" — i.e. there is nothing of substance to forward. The
 * detector is tight (specific phrases + length cap) so we don't accidentally
 * drop real document answers that happen to mention a limitation.
 */
function isPureNoEvidenceBoilerplate(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 500) return false;
  return /could not find sufficient evidence|no parsed documents matched|i could not confirm this from the uploaded ship documents/iu.test(
    trimmed,
  );
}

/**
 * Strip the rigid "Public sources suggest:" lead and a few other structural
 * tics so the web text reads as flowing prose. The model itself is now
 * prompted for 1-2 short paragraphs, so usually there's nothing to do here.
 */
function softenWebProse(value: string): string {
  let out = value.trim();
  // Drop a leading "I could not confirm/find ... uploaded ship documents ..."
  // sentence if the model echoed the fallback framing. Repeat once in case
  // there are multiple stacked preambles.
  for (let i = 0; i < 2; i += 1) {
    out = out.replace(
      /^I (?:could not|cannot|did not)\s+(?:confirm|find)[^.]*(?:uploaded|ship)\s+documents?[^.]*\.\s*/iu,
      '',
    );
    out = out.replace(
      /^(?:Public sources suggest|What I found|Findings|Notes? and limits?)\s*:?\s*\n*/iu,
      '',
    );
    out = out.replace(/^(?:#{1,6}\s+)?Limit\s*:?\s*\n+/iu, '');
  }
  return out.trim();
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
