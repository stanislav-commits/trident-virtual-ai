/**
 * Pure time-parsing helpers used by every tool that takes a Flux range.
 *
 * `parseFluxTime` throws on invalid input — never silently falls back. The
 * old "-10m fallback" version masked LLM bugs by returning data from the
 * wrong window.
 *
 * Supported formats:
 *   - "now()" or "0" → anchor (current time)
 *   - Relative: "-7d", "-24h", "-10m", "-30s", "-2w"
 *   - Absolute ISO: "2026-05-01T00:00:00Z" or anything Date.parse() accepts
 */

export function parseFluxTime(value: string, anchor: Date): Date {
  const trimmed = value.trim();
  if (trimmed === 'now()' || trimmed === '0') return anchor;

  const rel = /^-(\d+)(s|m|h|d|w)$/.exec(trimmed);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return new Date(anchor.getTime() - n * multipliers[unit]);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid Flux time "${value}". Use either relative ("-7d", "-24h", "-10m") or absolute ISO ("2026-05-01T00:00:00Z"). Supported relative units: s, m, h, d, w.`,
    );
  }
  return new Date(parsed);
}

export function parseRange(
  range: { start: string; stop?: string },
  now: Date = new Date(),
): { start: Date; stop: Date } {
  const start = parseFluxTime(range.start, now);
  const stop = range.stop ? parseFluxTime(range.stop, now) : now;
  return { start, stop };
}

/**
 * Parse a duration string ("5m", "1h", "30s") into milliseconds. Returns null
 * on invalid format — callers should fall back to a sensible default.
 */
export function parseDurationMs(d: string): number | null {
  const m = /^(\d+)(s|m|h)$/.exec(d.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
}
