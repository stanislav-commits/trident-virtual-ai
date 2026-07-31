/**
 * v60 reminder engine (Phase 3): which reminder a certificate is due, from its
 * type's Reminder Profile and the days left to expiry.
 *
 * The Behaviour Profiles sheet defines exactly two timed profiles — RP-00
 * ("Do not create date-based reminders") and RP-01 ("90, 60, 30, 14, 7 and
 * 1 day before expiry") — plus RP-12, which the Behaviour Matrix assigns to
 * the IEEC rows but the profiles sheet never defines. RP-12 is treated as
 * RP-01 until the client says otherwise.
 *
 * A type the v60 crosswalk never reached has a NULL profile. Those keep the
 * platform's pre-v60 behaviour — the standard expiry ladder — because v60 is
 * silent about them, and silently turning their alerts OFF would be a
 * regression the crew only notices when a certificate lapses.
 *
 * Severity encodes the escalation column ("Management at 30 days remaining
 * and when overdue" on the standard rows): info while the milestone is a
 * heads-up, warning from the 30-day escalation point, high in the final week,
 * critical once overdue.
 */

export type ReminderMilestone =
  | 'm90'
  | 'm60'
  | 'm30'
  | 'm14'
  | 'm7'
  | 'm1'
  | 'overdue';

export type ReminderSeverity = 'info' | 'warning' | 'high' | 'critical';

/** RP-01 ladder, farthest first. */
const MILESTONES: Array<{ key: ReminderMilestone; days: number }> = [
  { key: 'm90', days: 90 },
  { key: 'm60', days: 60 },
  { key: 'm30', days: 30 },
  { key: 'm14', days: 14 },
  { key: 'm7', days: 7 },
  { key: 'm1', days: 1 },
];

/**
 * The reminder currently owed for a document, or null for "no reminder".
 * `daysLeft` uses the register's convention (ceil of expiry − now): 0 =
 * expires today (still the m1 reminder), negative = overdue.
 */
export function reminderMilestone(
  reminderProfile: string | null,
  daysLeft: number,
): ReminderMilestone | null {
  if (reminderProfile === 'RP-00') return null;
  if (daysLeft < 0) return 'overdue';
  // Latest milestone already reached: the smallest ladder value ≥ daysLeft.
  let reached: ReminderMilestone | null = null;
  for (const m of MILESTONES) {
    if (m.days >= daysLeft) reached = m.key;
  }
  return reached;
}

export function milestoneSeverity(
  milestone: ReminderMilestone,
): ReminderSeverity {
  switch (milestone) {
    case 'm90':
    case 'm60':
      return 'info';
    case 'm30':
    case 'm14':
      return 'warning';
    case 'm7':
    case 'm1':
      return 'high';
    case 'overdue':
      return 'critical';
  }
}

/**
 * Alert fingerprint for the reminder. Milestones are stable per document —
 * moving down the ladder changes the fingerprint, so each milestone surfaces
 * as its own alert ("create reminders on each listed day"). Overdue carries
 * the expiry date: a renewed certificate that lapses again later must fire a
 * fresh overdue alert, not deduplicate against the old one.
 */
export function reminderFingerprint(
  docId: string,
  milestone: ReminderMilestone,
  expiryDate: string | null,
): string {
  return milestone === 'overdue'
    ? `cert:${docId}:overdue:${expiryDate ?? 'unknown'}`
    : `cert:${docId}:${milestone}`;
}
