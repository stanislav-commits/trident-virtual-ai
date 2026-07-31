/** Add a calendar interval to an ISO date (YYYY-MM-DD), returning ISO. Shared
 *  by the PMS service (roll-forward) and the import mapper (first due date).
 *
 *  Pure UTC on purpose: parsing `T00:00:00` without the Z reads LOCAL midnight
 *  while toISOString() emits UTC, so on any zone east of UTC every result came
 *  out one day EARLY. The prod droplet runs UTC and never saw it — local dev
 *  did, and computed different due dates than prod for the same input. */
export function addInterval(iso: string, value: number, unit: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (unit === 'days') d.setUTCDate(d.getUTCDate() + value);
  else if (unit === 'weeks') d.setUTCDate(d.getUTCDate() + value * 7);
  else if (unit === 'months') d.setUTCMonth(d.getUTCMonth() + value);
  else if (unit === 'years') d.setUTCFullYear(d.getUTCFullYear() + value);
  return d.toISOString().slice(0, 10);
}
