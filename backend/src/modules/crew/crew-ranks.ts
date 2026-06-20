/**
 * The standard yacht rank structure, by department. rankLevel is
 * within-department seniority (1 = head of department). Free-text ranks are
 * still allowed on a crew member — this catalog drives the UI selectors and
 * the default rankLevel when a known rank is picked.
 */
export interface RankDef {
  rank: string;
  level: number;
}

export interface DepartmentDef {
  key: string;
  label: string;
  ranks: RankDef[];
}

export const CREW_DEPARTMENTS: DepartmentDef[] = [
  {
    key: 'bridge',
    label: 'Bridge / Deck',
    ranks: [
      { rank: 'Captain', level: 1 },
      { rank: 'Chief Officer', level: 2 },
      { rank: '2nd Officer', level: 3 },
      { rank: '3rd Officer', level: 4 },
    ],
  },
  {
    key: 'engine',
    label: 'Engine',
    ranks: [
      { rank: 'Chief Engineer', level: 1 },
      { rank: '2nd Engineer', level: 2 },
      { rank: '3rd Engineer', level: 3 },
      { rank: '4th Engineer', level: 4 },
    ],
  },
  {
    key: 'ratings',
    label: 'Ratings',
    ranks: [
      { rank: 'Stewardess', level: 3 },
      { rank: 'Seaman', level: 4 },
      { rank: 'Motorman', level: 4 },
    ],
  },
  { key: 'other', label: 'Other', ranks: [] },
];

/** Default seniority level for a (department, rank) pair from the catalog. */
export function defaultRankLevel(department: string, rank: string): number {
  const dept = CREW_DEPARTMENTS.find((d) => d.key === department);
  const found = dept?.ranks.find(
    (r) => r.rank.toLowerCase() === rank.trim().toLowerCase(),
  );
  return found?.level ?? 5;
}

export const DEPARTMENT_KEYS = CREW_DEPARTMENTS.map((d) => d.key);

/**
 * Best-effort map a free-text role/rank (e.g. from an imported PMS sheet's
 * "responsible" column) to a department key. Tries the catalog first, then
 * keyword heuristics. Returns null when it can't tell (→ a general task).
 */
export function departmentForRole(role: string | null | undefined): string | null {
  const v = (role ?? '').trim().toLowerCase();
  if (!v) return null;

  // exact catalog rank match
  for (const dept of CREW_DEPARTMENTS) {
    if (dept.ranks.some((r) => r.rank.toLowerCase() === v)) return dept.key;
  }

  // keyword heuristics (engineer before officer: "chief engineer" vs "chief officer")
  if (/\beng/.test(v) || /motorman|oiler|wiper/.test(v)) return 'engine';
  if (/captain|master|officer|\bmate\b|bridge|navigat|deck\s*officer/.test(v))
    return 'bridge';
  if (/steward|stew\b|interior|cook|chef|seaman|deckhand|bosun|rating|crew/.test(v))
    return 'ratings';
  return null;
}

/**
 * Does this crew member see EVERY department's items (not just their own)?
 * Captain (or admin, handled separately) sees all. Department heads still
 * see their whole department via the by-department rule.
 */
export function seesAllDepartments(crew: {
  department: string;
  rank: string;
  rankLevel: number;
}): boolean {
  if (/captain|master/i.test(crew.rank)) return true;
  if (crew.department === 'bridge' && crew.rankLevel <= 1) return true;
  return false;
}
