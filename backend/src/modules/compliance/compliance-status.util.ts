import { raisesGap } from './compliance-profile.util';

/**
 * `conditional` is not a health state — it means the register cannot say the
 * document is missing, because the applicability matrix has not established
 * that this vessel needs it (C / R / TBD). See applicabilityVerdict().
 */
export type ComplianceStatus =
  | 'valid'
  | 'expiring'
  | 'expired'
  | 'missing'
  | 'conditional';

/** How long before expiry a certificate starts reading as "expiring". */
export const EXPIRING_DAYS = 90;

/** The fields of a record that decide its status — nothing else is needed. */
export interface StatusRecord {
  id: string;
  expiryDate: string | Date | null;
  recordState: string | null;
  assetId: string | null;
}

/** Who or what a record covers, for grouping. */
export interface StatusLink {
  assetId: string | null;
  crewMemberId: string | null;
}

/**
 * How a compliance record and a rulebook row read as a status.
 *
 * Its own file because two pages answer the same question and must not answer
 * it differently: the compliance register itself, and the Overview tile that
 * summarises it. A second implementation in SQL would drift on the first change
 * to any of the rules below, and the two screens would disagree in front of the
 * client.
 */

/**
 * A single record. No expiry date means the document does not expire — REPORT,
 * PLAN, PUBLICATION, RECORD_BOOK and EQUIP_TYPE are all dated without lapsing,
 * so their expiry_date is null by design (see validityField) and they count as
 * valid rather than as born-expired.
 */
export function recordStatus(doc: {
  expiryDate: string | Date | null;
}): ComplianceStatus {
  if (!doc.expiryDate) return 'valid';
  const expiry = new Date(doc.expiryDate);
  const now = new Date();
  if (expiry.getTime() < now.getTime()) return 'expired';
  const days = (expiry.getTime() - now.getTime()) / 86_400_000;
  return days <= EXPIRING_DAYS ? 'expiring' : 'valid';
}

/**
 * Type-level verdict over the CURRENT records, grouped by what each one covers:
 * worst across targets, best within a target.
 *
 * Four liferafts with four certificates are one rulebook row. The newest valid
 * issue for a given raft is what counts for that raft (best within target), and
 * one raft out of date makes the line out of date (worst across targets).
 *
 * With no live records the applicability matrix decides whether the empty row
 * is a gap: required → missing, otherwise conditional. A type whose only
 * records are superseded or archived is empty again by design.
 */
export function typeStatus(
  records: StatusRecord[],
  applicability: string | null | undefined,
  linksByDoc?: Map<string, StatusLink[]>,
): ComplianceStatus {
  const live = records.filter((doc) => doc.recordState === 'current');
  if (!live.length) {
    return raisesGap(applicability) ? 'missing' : 'conditional';
  }

  const rank: Record<string, number> = { valid: 0, expiring: 1, expired: 2 };
  const bestPerTarget = new Map<string, number>();
  for (const doc of live) {
    const links = linksByDoc?.get(doc.id) ?? [];
    const target = links.length
      ? links
          .map((l) => l.assetId ?? l.crewMemberId ?? '')
          .filter(Boolean)
          .sort()
          .join(',')
      : (doc.assetId ?? 'VESSEL');
    const score = rank[recordStatus(doc)] ?? 0;
    const current = bestPerTarget.get(target);
    // best (lowest rank) wins within a target — the newest valid issue
    if (current === undefined || score < current) {
      bestPerTarget.set(target, score);
    }
  }

  // worst (highest rank) across targets
  const worst = Math.max(...bestPerTarget.values());
  return (['valid', 'expiring', 'expired'] as const)[worst] ?? 'valid';
}
