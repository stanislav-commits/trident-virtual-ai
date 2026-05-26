const MAX_WEB_FINDINGS = 4;
const MAX_WEB_FINDING_LENGTH = 260;
const MAX_WEB_FINDINGS_BODY_LENGTH = 1100;

export function formatConciseWebInformation(summaries: string[]): string {
  const leadParagraphs: string[] = [];
  const limitParagraphs: string[] = [];
  const findings: string[] = [];

  for (const summary of summaries) {
    for (const block of extractContentBlocks(summary)) {
      if (isWebLeadBlock(block)) {
        leadParagraphs.push(block);
        continue;
      }

      if (isLimitBlock(block)) {
        limitParagraphs.push(normalizeLimitBlock(block));
        continue;
      }

      const listItems = extractListItems(block);

      if (listItems.length) {
        findings.push(...listItems);
        continue;
      }

      findings.push(block);
    }
  }

  const conciseFindings = takeConciseFindings(findings);
  const lead =
    dedupeText(leadParagraphs)[0] ??
    (conciseFindings.length ? 'Public sources suggest:' : '');
  const limit = dedupeText(limitParagraphs)[0] ?? '';

  return [
    lead,
    conciseFindings.map((finding) => `- ${finding}`).join('\n'),
    limit ? `Limit:\n${limit}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function extractContentBlocks(summary: string): string[] {
  const withoutSourceAppendix = summary
    .replace(
      /(?:^|\n)#{0,6}[ \t]*(?:sources?|references?|source details|links)[ \t]*:?[ \t]*\n[\s\S]*?(?=\n(?:#{0,6}[ \t]*)?Limit[ \t]*:|\s*$)/iu,
      '',
    )
    .replace(
      /^(?:#{1,6}[ \t]+)?(?:what i found|findings|web information|notes?(?: and limits?)?)[ \t]*:?[ \t]*$/gimu,
      '',
    )
    .replace(/^(?:#{1,6}[ \t]+)?Source[ \t]+\d+[ \t]*:?[ \t]*$/gimu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return withoutSourceAppendix
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => Boolean(block) && !isSourceOnlyBlock(block));
}

function isWebLeadBlock(block: string): boolean {
  return /^(?:I could not confirm|The (?:uploaded )?ship documents were checked first|Public sources (?:add|suggest|provide)|The web section below)/iu.test(
    block,
  );
}

function isLimitBlock(block: string): boolean {
  return (
    /^Limit\s*:/iu.test(block) ||
    /\b(?:not vessel-specific|not ship-specific|must not be treated as this vessel|may not match this vessel|not confirmation of this vessel)\b/iu.test(
      block,
    )
  );
}

function normalizeLimitBlock(block: string): string {
  const normalized = normalizeProse(block.replace(/^Limit\s*:\s*/iu, ''));

  if (
    /\bnot confirmation of this vessel(?:'s)?\b/iu.test(normalized) ||
    /\bnot confirmation of the vessel(?:'s)?\b/iu.test(normalized)
  ) {
    return "This is general public information, not confirmation of this vessel's onboard records or exact configuration.";
  }

  if (
    /\b(?:not vessel-specific|not ship-specific|public-reference|general public information)\b/iu.test(
      normalized,
    )
  ) {
    return 'This is general public information, not vessel-specific confirmation.';
  }

  return truncateFinding(normalized);
}

function extractListItems(block: string): string[] {
  if (!/^(?:[-*+]|\d+[.)])[ \t]+/mu.test(block)) {
    return [];
  }

  return block
    .split(/\r?\n/)
    .filter((line) => /^(?:[-*+]|\d+[.)])[ \t]+/u.test(line))
    .map((line) => line.replace(/^(?:[-*+]|\d+[.)])[ \t]+/u, '').trim())
    .filter((line) => Boolean(line) && !isSourceOnlyBlock(line));
}

function isSourceOnlyBlock(block: string): boolean {
  return (
    /^(?:sources?|references?|source details|links)\s*:?\s*$/iu.test(block) ||
    /^(?:https?:\/\/\S+\s*)+$/iu.test(block)
  );
}

function takeConciseFindings(findings: string[]): string[] {
  const selected: string[] = [];
  let bodyLength = 0;

  for (const finding of dedupeText(findings)) {
    const conciseFinding = truncateFinding(finding);

    if (isLowValueFinding(conciseFinding)) {
      continue;
    }

    const proposedLength = bodyLength + conciseFinding.length + 3;

    if (
      selected.length > 0 &&
      (selected.length >= MAX_WEB_FINDINGS ||
        proposedLength > MAX_WEB_FINDINGS_BODY_LENGTH)
    ) {
      continue;
    }

    selected.push(conciseFinding);
    bodyLength = proposedLength;

    if (selected.length >= MAX_WEB_FINDINGS) {
      break;
    }
  }

  return selected;
}

function truncateFinding(value: string): string {
  const normalized = normalizeProse(value);

  if (normalized.length <= MAX_WEB_FINDING_LENGTH) {
    return normalized;
  }

  const candidate = normalized.slice(0, MAX_WEB_FINDING_LENGTH);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('! '),
  );

  return sentenceEnd >= 80
    ? candidate.slice(0, sentenceEnd + 1).trim()
    : `${candidate.trimEnd()}...`;
}

function normalizeProse(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s+/u, '')
    .replace(/\s+#{1,6}\s+/gu, ' ')
    .replace(/^\s*\d+[.)]\s+/u, '')
    .replace(/\[([^\]]{1,100})\]\(https?:\/\/[^\s)]+\)/giu, '$1')
    .replace(/^\s*(?:what I found|findings|notes?(?: and limits?)?)\s*:?\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowValueFinding(value: string): boolean {
  return /^(?:because the uploaded ship-document evidence was insufficient|what public web info exists|publicly accessible official .* directly relevant)\b/iu.test(
    value,
  );
}

function dedupeText(values: string[]): string[] {
  const seen = new Set<string>();

  return values.filter((value) => {
    const key = value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
