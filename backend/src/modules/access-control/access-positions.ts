/**
 * RBAC access model (positions × resource categories → permission level).
 *
 * A "position" is the matrix column — a flattened rank×department role, the
 * same shape IDEA uses (HOD Engineering / HOD Deck … are separate columns).
 * A crew member's position is DERIVED from their crew row (department + rank +
 * rankLevel); nothing new is stored on the user. The matrix itself is a
 * per-ship override on top of the platform DEFAULT_MATRIX defined here.
 *
 * NOTE: category-level access here is orthogonal to CONTENT department-scoping
 * (which manuals / PMS tasks a member sees within a granted category) — that
 * stays driven by crew.department + seesAllDepartments() at retrieval time.
 */

export enum AccessPosition {
  SUPERINTENDENT = 'superintendent', // shore-side technical/fleet manager
  MASTER = 'master',
  HOD_ENGINE = 'hod_engine',
  HOD_DECK = 'hod_deck',
  HOD_INTERIOR = 'hod_interior',
  HOD_GALLEY = 'hod_galley',
  ENGINE = 'engine',
  DECK = 'deck',
  INTERIOR = 'interior',
  GALLEY = 'galley',
  GUEST = 'guest',
}

/** Matrix rows — the information categories access is granted over. */
export enum ResourceCategory {
  KB_MANUALS = 'kb_manuals',
  KB_FORMS = 'kb_forms',
  KB_PLANS = 'kb_plans',
  PUBLICATIONS = 'publications',
  COMPLIANCE_STATUTORY = 'compliance_statutory',
  COMPLIANCE_EQUIPMENT = 'compliance_equipment',
  COMPLIANCE_PERSONNEL = 'compliance_personnel', // sensitive
  COMPLIANCE_INSURANCE = 'compliance_insurance', // sensitive
  COMPLIANCE_LEGAL = 'compliance_legal', // sensitive (Legal / Agreements / commercial)
  COMPLIANCE_RECORDS = 'compliance_records',
  COMPLIANCE_REPORTS = 'compliance_reports',
  ASSET_REGISTER = 'asset_register',
  PMS_TASKS = 'pms_tasks',
  METRICS = 'metrics',
  ALERTS = 'alerts',
}

/** Cell value. WRITE implies READ. */
export enum PermissionLevel {
  NONE = 'none',
  READ = 'read',
  WRITE = 'write',
}

export const ACCESS_POSITIONS = Object.values(AccessPosition);
export const RESOURCE_CATEGORIES = Object.values(ResourceCategory);

const OPERATIONAL: ResourceCategory[] = [
  ResourceCategory.KB_MANUALS,
  ResourceCategory.KB_FORMS,
  ResourceCategory.KB_PLANS,
  ResourceCategory.ASSET_REGISTER,
  ResourceCategory.PMS_TASKS,
  ResourceCategory.METRICS,
  ResourceCategory.ALERTS,
];
const COMPLIANCE_OPEN: ResourceCategory[] = [
  ResourceCategory.COMPLIANCE_STATUTORY,
  ResourceCategory.COMPLIANCE_EQUIPMENT,
  ResourceCategory.COMPLIANCE_RECORDS,
  ResourceCategory.COMPLIANCE_REPORTS,
];
const COMPLIANCE_SENSITIVE: ResourceCategory[] = [
  ResourceCategory.COMPLIANCE_PERSONNEL,
  ResourceCategory.COMPLIANCE_INSURANCE,
  ResourceCategory.COMPLIANCE_LEGAL,
];

function rowOf(
  fn: (c: ResourceCategory) => PermissionLevel,
): Record<ResourceCategory, PermissionLevel> {
  const out = {} as Record<ResourceCategory, PermissionLevel>;
  for (const c of RESOURCE_CATEGORIES) out[c] = fn(c);
  return out;
}

const isOperational = (c: ResourceCategory) => OPERATIONAL.includes(c);
const isComplianceOpen = (c: ResourceCategory) => COMPLIANCE_OPEN.includes(c);
const isSensitive = (c: ResourceCategory) => COMPLIANCE_SENSITIVE.includes(c);

/**
 * Platform default matrix. Per-ship rows in access_matrix_cell override a cell;
 * absence = this default. Publications are readable by everyone (fleet regs).
 * Sensitive compliance is Master/Superintendent only. Heads of department get
 * write on operational + read on open compliance + read on Personnel (their own
 * department is content-scoped downstream). Ratings/crew read operational only.
 */
export const DEFAULT_MATRIX: Record<
  AccessPosition,
  Record<ResourceCategory, PermissionLevel>
> = {
  [AccessPosition.SUPERINTENDENT]: rowOf((c) =>
    isSensitive(c) ? PermissionLevel.READ : PermissionLevel.WRITE,
  ),
  [AccessPosition.MASTER]: rowOf(() => PermissionLevel.WRITE),
  [AccessPosition.HOD_ENGINE]: rowOf(hodRow),
  [AccessPosition.HOD_DECK]: rowOf(hodRow),
  [AccessPosition.HOD_INTERIOR]: rowOf(hodRow),
  [AccessPosition.HOD_GALLEY]: rowOf(hodRow),
  [AccessPosition.ENGINE]: rowOf(crewRow),
  [AccessPosition.DECK]: rowOf(crewRow),
  [AccessPosition.INTERIOR]: rowOf(crewRow),
  [AccessPosition.GALLEY]: rowOf(crewRow),
  [AccessPosition.GUEST]: rowOf((c) =>
    c === ResourceCategory.PUBLICATIONS ? PermissionLevel.READ : PermissionLevel.NONE,
  ),
};

function hodRow(c: ResourceCategory): PermissionLevel {
  if (c === ResourceCategory.PUBLICATIONS) return PermissionLevel.READ;
  if (isOperational(c)) return PermissionLevel.WRITE;
  if (isComplianceOpen(c)) return PermissionLevel.READ;
  if (c === ResourceCategory.COMPLIANCE_PERSONNEL) return PermissionLevel.READ; // own dept, content-scoped
  return PermissionLevel.NONE; // insurance / legal
}

function crewRow(c: ResourceCategory): PermissionLevel {
  if (c === ResourceCategory.PUBLICATIONS) return PermissionLevel.READ;
  if (isOperational(c)) return PermissionLevel.READ;
  return PermissionLevel.NONE;
}

/** Map a KB document class to its access resource category (null = not gated). */
export function categoryForDocClass(
  docClass: string | null | undefined,
): ResourceCategory | null {
  switch ((docClass ?? '').toLowerCase()) {
    case 'manual':
      return ResourceCategory.KB_MANUALS;
    case 'form':
      return ResourceCategory.KB_FORMS;
    case 'plan':
      return ResourceCategory.KB_PLANS;
    case 'publication':
      return ResourceCategory.PUBLICATIONS;
    default:
      return null; // legacy / procedure / regulation → fail open
  }
}

/** Map a compliance doc-control archetype to its access resource category. */
export function categoryForArchetype(
  archetype: string | null | undefined,
): ResourceCategory | null {
  switch ((archetype ?? '').toUpperCase()) {
    case 'STAT_CERT':
      return ResourceCategory.COMPLIANCE_STATUTORY;
    case 'EQUIP_SVC':
    case 'EQUIP_TYPE':
      return ResourceCategory.COMPLIANCE_EQUIPMENT;
    case 'PERSONNEL':
      return ResourceCategory.COMPLIANCE_PERSONNEL;
    case 'INSURANCE':
      return ResourceCategory.COMPLIANCE_INSURANCE;
    case 'LEGAL':
    case 'AGREEMENT':
      return ResourceCategory.COMPLIANCE_LEGAL;
    case 'RECORD_BOOK':
      return ResourceCategory.COMPLIANCE_RECORDS;
    case 'REPORT':
      return ResourceCategory.COMPLIANCE_REPORTS;
    case 'PLAN':
      return ResourceCategory.KB_PLANS;
    case 'PUBLICATION':
      return ResourceCategory.PUBLICATIONS;
    default:
      return null; // unknown archetype → not access-gated (fail open)
  }
}

/** Normalise a crew.department string (tolerant of legacy keys) to a base dept. */
export function normalizeDepartment(
  department: string | null | undefined,
  rank: string | null | undefined,
): 'engine' | 'deck' | 'interior' | 'galley' | null {
  const d = (department ?? '').trim().toLowerCase();
  if (d === 'engine') return 'engine';
  if (d === 'deck' || d === 'bridge') return 'deck';
  if (d === 'interior') return 'interior';
  if (d === 'galley') return 'galley';
  // legacy 'ratings' / 'other' → infer from rank keywords
  const r = (rank ?? '').trim().toLowerCase();
  if (/motorman|oiler|wiper|\beng/.test(r)) return 'engine';
  if (/cook|chef|galley/.test(r)) return 'galley';
  if (/stew|interior|purser/.test(r)) return 'interior';
  if (/seaman|deckhand|bosun|mate|officer|captain|master|deck/.test(r)) return 'deck';
  return null;
}

const HOD_BY_DEPT: Record<string, AccessPosition> = {
  engine: AccessPosition.HOD_ENGINE,
  deck: AccessPosition.HOD_DECK,
  interior: AccessPosition.HOD_INTERIOR,
  galley: AccessPosition.HOD_GALLEY,
};
const CREW_BY_DEPT: Record<string, AccessPosition> = {
  engine: AccessPosition.ENGINE,
  deck: AccessPosition.DECK,
  interior: AccessPosition.INTERIOR,
  galley: AccessPosition.GALLEY,
};

/** Derive the matrix position from a crew member's department/rank/rankLevel. */
export function resolvePosition(crew: {
  department: string | null;
  rank: string | null;
  rankLevel: number | null;
}): AccessPosition {
  if (/captain|master/i.test(crew.rank ?? '')) return AccessPosition.MASTER;
  const dept = normalizeDepartment(crew.department, crew.rank);
  if (!dept) return AccessPosition.GUEST;
  const isHead = (crew.rankLevel ?? 5) <= 1;
  return (isHead ? HOD_BY_DEPT[dept] : CREW_BY_DEPT[dept]) ?? AccessPosition.GUEST;
}
