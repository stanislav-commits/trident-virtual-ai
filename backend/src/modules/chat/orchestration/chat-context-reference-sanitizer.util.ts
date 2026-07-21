/**
 * Hard backend-side guarantee that a metric/telemetry reference can never
 * reach the chat client's Sources UI — the chat user doesn't know the
 * telemetry catalog exists, so a metric key or asset code showing up in
 * Sources is always a bug, not a formatting nuance. This is enforced here
 * (not just in the frontend's own filter) so it holds regardless of which
 * responder produced the reference, including any future or currently
 * disabled one that forgets to tag `sourceType: 'metric'`.
 */
export function sanitizeContextReferencesForClient(
  references: unknown[] | null | undefined,
): unknown[] {
  if (!Array.isArray(references)) {
    return [];
  }

  return references.filter((reference) => !isMetricLikeReference(reference));
}

function isMetricLikeReference(reference: unknown): boolean {
  if (!reference || typeof reference !== 'object') {
    return false;
  }

  const entry = reference as Record<string, unknown>;

  if (entry.sourceType === 'metric') {
    return true;
  }

  const id = entry.id;
  if (typeof id === 'string' && /^metric[-:]/.test(id)) {
    return true;
  }

  // A legitimate document/web/form reference always carries one of these
  // identifying fields — a reference with none of them but a "measurement ::
  // field" style title/snippet (the metric analyzer's own format) is a
  // telemetry reference that slipped through without its tag.
  const hasLegitimateSource =
    typeof entry.documentId === 'string' ||
    typeof entry.shipManualId === 'string' ||
    (typeof entry.sourceUrl === 'string' && /^https?:\/\//i.test(entry.sourceUrl));
  if (hasLegitimateSource) {
    return false;
  }

  const doubleColonPattern = /\b[\w.-]+\s*::\s*[\w.-]+\b/;
  return (
    doubleColonPattern.test(String(entry.sourceTitle ?? '')) ||
    doubleColonPattern.test(String(entry.snippet ?? ''))
  );
}
