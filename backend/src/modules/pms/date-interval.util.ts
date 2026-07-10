/** Add a calendar interval to an ISO date (YYYY-MM-DD), returning ISO. Shared
 *  by the PMS service (roll-forward) and the import mapper (first due date). */
export function addInterval(iso: string, value: number, unit: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (unit === 'days') d.setDate(d.getDate() + value);
  else if (unit === 'weeks') d.setDate(d.getDate() + value * 7);
  else if (unit === 'months') d.setMonth(d.getMonth() + value);
  else if (unit === 'years') d.setFullYear(d.getFullYear() + value);
  return d.toISOString().slice(0, 10);
}
