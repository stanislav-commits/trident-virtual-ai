/**
 * Pure contact-entry extraction and deduplication utilities.
 *
 * Every function in this module is stateless — it receives all data it needs
 * through arguments and returns a result without side-effects. The functions
 * were extracted from ChatService to reduce its size and improve testability.
 */
import type { ChatCitation } from '../chat.types';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface DeterministicContactEntry {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  citation: ChatCitation;
}

// ──────────────────────────────────────────────────────────────────────
// Regex helpers (stable patterns, created once per call)
// ──────────────────────────────────────────────────────────────────────

function getContactNameAnchorPattern(): RegExp {
  return /(?=([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})\s*-\s*[A-Z][A-Za-z'.,&]+(?:[\s,]+[A-Z][A-Za-z'.,&]+){0,3})/g;
}

function getContactEmailPattern(): RegExp {
  return /\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/gi;
}

// ──────────────────────────────────────────────────────────────────────
// Text normalisation
// ──────────────────────────────────────────────────────────────────────

export function normalizeDeterministicContactText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[–—−]/g, '-')
    .replace(/[']/g, "'")
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeContactEmail(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

// ──────────────────────────────────────────────────────────────────────
// Name / role / phone / email extraction
// ──────────────────────────────────────────────────────────────────────

function isLikelyDeterministicContactName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const forbiddenTerms = [
    'company',
    'contact',
    'details',
    'yachting',
    'ops',
    'team',
    'website',
    'careers',
    'head',
    'globalhsqe',
    'founder',
    'director',
    'manager',
  ];

  return !forbiddenTerms.some((term) => normalized.includes(term));
}

function extractDeterministicContactAnchors(
  normalized: string,
): Array<{ index: number; name: string }> {
  const anchors: Array<{ index: number; name: string }> = [];
  const pattern = getContactNameAnchorPattern();
  let lastAcceptedEnd = -1;

  for (const match of normalized.matchAll(pattern)) {
    const name = match[1]?.trim();
    const index = match.index ?? 0;
    if (index < lastAcceptedEnd) {
      continue;
    }
    if (!name || !isLikelyDeterministicContactName(name)) {
      continue;
    }

    const existing = anchors[anchors.length - 1];
    if (existing?.index === index && existing.name === name) {
      continue;
    }

    anchors.push({ index, name });
    lastAcceptedEnd = index + name.length + 24;
  }

  return anchors;
}

function extractDeterministicContactName(segment: string): string | null {
  const anchor = extractDeterministicContactAnchors(segment)[0];
  if (anchor?.name) {
    return anchor.name;
  }

  const nameWithLocationMatch = segment.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-–]\s*[A-Z][A-Za-z.\s]{2,40}\b/,
  );
  if (nameWithLocationMatch?.[1]) {
    return nameWithLocationMatch[1].trim();
  }

  const fallbackMatch = segment.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/,
  );
  return fallbackMatch?.[1]?.trim() ?? null;
}

function sanitizeDeterministicContactRole(role: string): string | null {
  let sanitized = role;
  const sectionMarkers = [
    /\bJMs?\s+Yachting\s+Company\s+Contact\s+Details\b/i,
    /\bGlobalHSQE\b/i,
    /\bOps\s+Team\s*\d+\b/i,
    /\bWebsite\s*\/?\s*I[t1]\b/i,
  ];

  for (const marker of sectionMarkers) {
    const match = sanitized.match(marker);
    if (!match || match.index === undefined || match.index === 0) {
      continue;
    }

    sanitized = sanitized.slice(0, match.index).trim();
  }

  sanitized = sanitized
    .replace(/\s+/g, ' ')
    .replace(/^[-,\s]+|[-,\s]+$/g, '');

  return sanitized || null;
}

function extractDeterministicContactRole(
  segment: string,
  name: string,
): string | null {
  const cleaned = normalizeDeterministicContactText(
    segment
      .replace(getContactEmailPattern(), ' ')
      .replace(/\+\s*\d[\d\s()./-]{5,}\d\b/g, ' ')
      .replace(
        new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        ' ',
      )
      .replace(/\(\s*(?:m|o|work m|personal m)\s*\)/gi, ' '),
  );
  const keywordMatch = cleaned.match(
    /\b(?:Compliance|Founder|Director|Manager|Captain|Master|DPA|CSO)\b/i,
  );
  if (!keywordMatch || keywordMatch.index === undefined) {
    return null;
  }

  let startIndex = keywordMatch.index;
  const prefix = cleaned.slice(0, startIndex);
  const precedingTokenMatch = prefix.match(/([A-Z][A-Za-z/&]+,?)\s*$/);
  if (precedingTokenMatch) {
    startIndex = prefix.lastIndexOf(precedingTokenMatch[1]);
  }

  const role = cleaned
    .slice(startIndex)
    .replace(/^[-,\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitizeDeterministicContactRole(role);
}

function extractDeterministicContactPhone(segment: string): string | null {
  const match = segment.match(/\+\s*\d[\d\s()./-]{5,}\d\b/);
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
}

function extractDeterministicContactEmail(segment: string): string | null {
  const match = segment.match(getContactEmailPattern());
  return match?.[0] ? normalizeContactEmail(match[0]) : null;
}

// ──────────────────────────────────────────────────────────────────────
// Entry building
// ──────────────────────────────────────────────────────────────────────

function buildDeterministicContactEntry(
  segment: string,
  name: string | null,
  citation: ChatCitation,
): DeterministicContactEntry | null {
  if (!name) {
    return null;
  }

  const email = extractDeterministicContactEmail(segment);
  const phone = extractDeterministicContactPhone(segment) ?? undefined;
  const role = extractDeterministicContactRole(segment, name) ?? undefined;

  if (!email && !phone && !role) {
    return null;
  }

  return {
    name,
    role,
    email: email ?? undefined,
    phone,
    citation,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Name-anchored / email-anchored extraction strategies
// ──────────────────────────────────────────────────────────────────────

function extractNameAnchoredContactEntries(
  normalized: string,
  citation: ChatCitation,
): DeterministicContactEntry[] {
  const anchors = extractDeterministicContactAnchors(normalized);
  if (anchors.length === 0) {
    return [];
  }

  return anchors
    .map((anchor, index) => {
      const segment = normalized
        .slice(anchor.index, anchors[index + 1]?.index ?? normalized.length)
        .trim();
      const entry = buildDeterministicContactEntry(
        segment,
        anchor.name,
        citation,
      );
      if (!entry) {
        return null;
      }

      return {
        ...entry,
        order: anchor.index,
      };
    })
    .filter(
      (
        entry,
      ): entry is DeterministicContactEntry & {
        order: number;
      } => Boolean(entry),
    )
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...entry }) => entry);
}

function extractEmailAnchoredContactEntries(
  normalized: string,
  citation: ChatCitation,
): DeterministicContactEntry[] {
  const emailMatches = [
    ...normalized.matchAll(getContactEmailPattern()),
  ];
  if (emailMatches.length === 0) {
    return [];
  }

  return emailMatches
    .map((match) => {
      const emailIndex = match.index ?? 0;
      const windowStart = Math.max(0, emailIndex - 180);
      const windowEnd = Math.min(
        normalized.length,
        emailIndex + match[0].length + 180,
      );
      const segment = normalized.slice(windowStart, windowEnd).trim();
      const anchors = extractDeterministicContactAnchors(segment);
      const anchor =
        anchors.length > 0 ? anchors[anchors.length - 1] : undefined;
      const name =
        anchor?.name ?? extractDeterministicContactName(segment);

      return buildDeterministicContactEntry(segment, name, citation);
    })
    .filter((entry): entry is DeterministicContactEntry => Boolean(entry));
}

// ──────────────────────────────────────────────────────────────────────
// Top-level extraction entry point
// ──────────────────────────────────────────────────────────────────────

export function extractDeterministicContactEntries(
  citation: ChatCitation,
): DeterministicContactEntry[] {
  const snippet = citation.snippet?.trim();
  if (!snippet) {
    return [];
  }

  const normalized = normalizeDeterministicContactText(snippet);
  const nameAnchoredEntries = extractNameAnchoredContactEntries(
    normalized,
    citation,
  );
  if (nameAnchoredEntries.length > 0) {
    return nameAnchoredEntries;
  }

  return extractEmailAnchoredContactEntries(normalized, citation);
}

// ──────────────────────────────────────────────────────────────────────
// Deduplication
// ──────────────────────────────────────────────────────────────────────

function buildDeterministicContactEntryKey(
  entry: DeterministicContactEntry,
): string {
  return [
    normalizeDeterministicContactText(entry.name).toLowerCase(),
    entry.email?.toLowerCase() ?? '',
    (entry.phone ?? '').replace(/\D+/g, ''),
  ].join('::');
}

function buildDeterministicContactSourceScopedNameKey(
  entry: DeterministicContactEntry,
): string {
  return [
    normalizeDeterministicContactText(entry.name).toLowerCase(),
    normalizeDeterministicContactText(
      entry.citation.sourceTitle ?? '',
    ).toLowerCase(),
  ].join('::');
}

function getDeterministicContactEntryCompleteness(
  entry: DeterministicContactEntry,
): number {
  let score = 0;
  if (entry.role) {
    score += 2;
  }
  if (entry.email) {
    score += 3;
  }
  if (entry.phone) {
    score += 3;
  }

  return score;
}

function getDeterministicContactEntryTextLength(
  entry: DeterministicContactEntry,
): number {
  return [
    entry.name,
    entry.role ?? '',
    entry.email ?? '',
    entry.phone ?? '',
  ].join(' ').length;
}

function selectPreferredDeterministicContactEntry(
  existing: DeterministicContactEntry,
  next: DeterministicContactEntry,
): DeterministicContactEntry {
  const existingCompleteness =
    getDeterministicContactEntryCompleteness(existing);
  const nextCompleteness =
    getDeterministicContactEntryCompleteness(next);
  if (nextCompleteness !== existingCompleteness) {
    return nextCompleteness > existingCompleteness ? next : existing;
  }

  const existingScore = existing.citation.score ?? 0;
  const nextScore = next.citation.score ?? 0;
  if (nextScore !== existingScore) {
    return nextScore > existingScore ? next : existing;
  }

  return getDeterministicContactEntryTextLength(next) >
    getDeterministicContactEntryTextLength(existing)
    ? next
    : existing;
}

function choosePreferredDeterministicContactField(
  primary?: string,
  secondary?: string,
): string | undefined {
  if (!primary) {
    return secondary ?? undefined;
  }
  if (!secondary) {
    return primary;
  }

  return secondary.length > primary.length ? secondary : primary;
}

function mergeDeterministicContactEntries(
  left: DeterministicContactEntry,
  right: DeterministicContactEntry,
): DeterministicContactEntry {
  const primary = selectPreferredDeterministicContactEntry(left, right);
  const secondary = primary === left ? right : left;

  return {
    name:
      primary.name.length >= secondary.name.length
        ? primary.name
        : secondary.name,
    role: choosePreferredDeterministicContactField(
      primary.role,
      secondary.role,
    ),
    email: choosePreferredDeterministicContactField(
      primary.email,
      secondary.email,
    ),
    phone: choosePreferredDeterministicContactField(
      primary.phone,
      secondary.phone,
    ),
    citation:
      (primary.citation.score ?? 0) >= (secondary.citation.score ?? 0)
        ? primary.citation
        : secondary.citation,
  };
}

export function dedupeDeterministicContactEntries(
  entries: DeterministicContactEntry[],
): DeterministicContactEntry[] {
  const deduped = new Map<string, DeterministicContactEntry>();

  for (const entry of entries) {
    const key = buildDeterministicContactEntryKey(entry);

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, entry);
      continue;
    }

    deduped.set(
      key,
      selectPreferredDeterministicContactEntry(existing, entry),
    );
  }

  const mergedBySourceAndName = new Map<string, DeterministicContactEntry>();
  for (const entry of deduped.values()) {
    const key = buildDeterministicContactSourceScopedNameKey(entry);
    const existing = mergedBySourceAndName.get(key);
    if (!existing) {
      mergedBySourceAndName.set(key, entry);
      continue;
    }

    mergedBySourceAndName.set(
      key,
      mergeDeterministicContactEntries(existing, entry),
    );
  }

  return [...mergedBySourceAndName.values()];
}

// ──────────────────────────────────────────────────────────────────────
// Role inventory
// ──────────────────────────────────────────────────────────────────────

export function extractDeterministicRoleInventory(
  entries: DeterministicContactEntry[],
): Array<{ role: string; citation: ChatCitation }> {
  const roles = new Map<string, { role: string; citation: ChatCitation }>();

  for (const entry of entries) {
    const role = entry.role?.trim();
    if (!role) {
      continue;
    }

    const normalizedRole = normalizeDeterministicContactText(role)
      .toLowerCase()
      .replace(/\s+/g, ' ');
    const existing = roles.get(normalizedRole);
    if (
      !existing ||
      (entry.citation.score ?? 0) > (existing.citation.score ?? 0)
    ) {
      roles.set(normalizedRole, {
        role,
        citation: entry.citation,
      });
    }
  }

  return [...roles.values()].sort((left, right) =>
    left.role.localeCompare(right.role),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Query-based filtering
// (anchorTerms is passed in — the caller resolves it via the service)
// ──────────────────────────────────────────────────────────────────────

export function filterDeterministicContactEntriesForQuery(
  userQuery: string,
  entries: DeterministicContactEntry[],
  anchorTerms: string[],
): DeterministicContactEntry[] {
  const wantsEmail = /\bemails?\b/.test(userQuery.toLowerCase());
  const wantsPhone = /\b(phone|telephone|mobile|number|numbers)\b/i.test(
    userQuery,
  );

  const matched = entries.filter((entry) => {
    const haystack = [
      entry.name,
      entry.role ?? '',
      entry.email ?? '',
      entry.phone ?? '',
    ]
      .join('\n')
      .toLowerCase();

    if (wantsEmail && !entry.email) {
      return false;
    }
    if (wantsPhone && !entry.phone) {
      return false;
    }
    if (anchorTerms.length === 0) {
      return true;
    }

    return anchorTerms.every((term) => haystack.includes(term));
  });

  if (matched.length > 0) {
    return matched.sort((left, right) => {
      const leftRoleMatch =
        anchorTerms.length > 0 &&
        anchorTerms.every((term) =>
          (left.role ?? '').toLowerCase().includes(term),
        )
          ? 1
          : 0;
      const rightRoleMatch =
        anchorTerms.length > 0 &&
        anchorTerms.every((term) =>
          (right.role ?? '').toLowerCase().includes(term),
        )
          ? 1
          : 0;
      if (leftRoleMatch !== rightRoleMatch) {
        return rightRoleMatch - leftRoleMatch;
      }

      return (right.citation.score ?? 0) - (left.citation.score ?? 0);
    });
  }

  return [];
}

// ──────────────────────────────────────────────────────────────────────
// Source-group profiling & preference
// (anchorTerms is passed in — the caller resolves it via the service)
// ──────────────────────────────────────────────────────────────────────

export function groupDeterministicContactEntriesBySource(
  entries: DeterministicContactEntry[],
): Array<{ sourceKey: string; entries: DeterministicContactEntry[] }> {
  const grouped = new Map<string, DeterministicContactEntry[]>();

  for (const entry of entries) {
    const sourceKey = (entry.citation.sourceTitle ?? '').trim().toLowerCase();
    const bucket = grouped.get(sourceKey) ?? [];
    bucket.push(entry);
    grouped.set(sourceKey, bucket);
  }

  return [...grouped.entries()].map(([sourceKey, groupedEntries]) => ({
    sourceKey,
    entries: groupedEntries,
  }));
}

export function buildDeterministicContactSourceProfile(
  entries: DeterministicContactEntry[],
  anchorTerms: string[],
): {
  totalScore: number;
  directoryScore: number;
  anchorCoverage: number;
} {
  const sourceTitle = entries[0]?.citation.sourceTitle ?? '';
  const normalizedTitle = sourceTitle.toLowerCase();
  const directoryScore =
    /\b(contact\s+details|company\s+contact|directory|crew\s+list)\b/i.test(
      normalizedTitle,
    )
      ? 4
      : /\b(contact|email|phone)\b/i.test(normalizedTitle)
        ? 2
        : 0;
  const noisePenalty =
    /\b(ntvrp|response|plan|appendix|checklist|procedure|manual|guide|instruction)\b/i.test(
      normalizedTitle,
    )
      ? 3
      : 0;
  const anchorCoverage = anchorTerms.filter((term) =>
    entries.some((entry) =>
      [entry.name, entry.role ?? '', entry.email ?? '', entry.phone ?? '']
        .join('\n')
        .toLowerCase()
        .includes(term),
    ),
  ).length;
  const roleCount = entries.filter((entry) => entry.role).length;
  const contactPointCount = entries.filter(
    (entry) => entry.email || entry.phone,
  ).length;
  const totalScore =
    directoryScore * 30 +
    anchorCoverage * 8 +
    roleCount * 4 +
    contactPointCount * 2 +
    entries.length * 6 -
    noisePenalty * 25;

  return {
    totalScore,
    directoryScore,
    anchorCoverage,
  };
}

export function preferDeterministicContactSourceEntries(
  userQuery: string,
  entries: DeterministicContactEntry[],
  wantsExhaustiveList: boolean,
  anchorTerms: string[],
): DeterministicContactEntry[] {
  if (entries.length <= 1) {
    return entries;
  }

  const groups = groupDeterministicContactEntriesBySource(entries);
  if (groups.length <= 1) {
    return entries;
  }

  const explicitDirectoryRequest =
    /\b(contact\s+details\s+document|company\s+contact|contact\s+sheet|directory|crew\s+list)\b/i.test(
      userQuery,
    );
  const rankedGroups = groups
    .map((group) => ({
      ...group,
      profile: buildDeterministicContactSourceProfile(
        group.entries,
        anchorTerms,
      ),
    }))
    .sort(
      (left, right) => right.profile.totalScore - left.profile.totalScore,
    );
  const [bestGroup, secondGroup] = rankedGroups;
  if (!bestGroup) {
    return entries;
  }

  const secondScore =
    secondGroup?.profile.totalScore ?? Number.NEGATIVE_INFINITY;
  const strongLead =
    bestGroup.profile.totalScore >= secondScore + 15 ||
    bestGroup.profile.directoryScore >
      (secondGroup?.profile.directoryScore ?? 0);
  const shouldPreferSingleSource =
    wantsExhaustiveList ||
    explicitDirectoryRequest ||
    bestGroup.profile.directoryScore > 0 ||
    bestGroup.profile.anchorCoverage >
      (secondGroup?.profile.anchorCoverage ?? 0);

  return strongLead && shouldPreferSingleSource ? bestGroup.entries : entries;
}
