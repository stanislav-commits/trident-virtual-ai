/**
 * v60 Phase 4 event vocabulary. Codes are what `compliance_doc_types.
 * trigger_codes` lists and what producers (manual entry, ship particulars,
 * asset changes, document replacement) record. The Behaviour Matrix names the
 * triggers in free text ("Alteration, remeasurement, tonnage change or flag
 * change"); these codes are that text made machine-readable — the catalogue
 * has no seed column for them (update_trigger is empty on every prod row), so
 * the vocabulary is deliberately small and each code is hand-mapped to the
 * rows it affects in the seeding migration.
 *
 * Outcomes follow the Behaviour Profiles sheet:
 *   TO-REVIEW  — "the change may not require a new test but must be checked":
 *                flag the record, keep it in force.
 *   TO-INVALID — "the existing report can no longer be relied upon":
 *                the record stops satisfying compliance.
 */

export type ComplianceEventOutcome = 'review' | 'invalid';

export interface ComplianceEventSpec {
  code: string;
  label: string;
  outcome: ComplianceEventOutcome;
  /** Whether the event usually names one asset (narrows the affected set). */
  assetScoped: boolean;
}

export const COMPLIANCE_EVENT_CODES: ComplianceEventSpec[] = [
  {
    code: 'flag_change',
    label: 'Flag change',
    outcome: 'review',
    assetScoped: false,
  },
  {
    code: 'vessel_particulars_change',
    label: 'Vessel particulars change (name / ownership / company / class)',
    outcome: 'review',
    assetScoped: false,
  },
  {
    code: 'structural_change',
    label: 'Structural or dimensional alteration',
    outcome: 'review',
    assetScoped: false,
  },
  {
    code: 'sea_area_change',
    label: 'GMDSS sea-area change',
    outcome: 'review',
    assetScoped: false,
  },
  {
    code: 'dry_docking',
    label: 'Dry docking / in-water survey completed',
    outcome: 'review',
    assetScoped: false,
  },
  {
    code: 'equipment_replaced',
    label: 'Linked equipment replaced or materially changed',
    outcome: 'invalid',
    assetScoped: true,
  },
  {
    code: 'equipment_unserviceable',
    label: 'Linked equipment unserviceable',
    outcome: 'invalid',
    assetScoped: true,
  },
];

/** Internal code recorded when a parent certificate is replaced (DEP-CHILD). */
export const PARENT_REPLACED_CODE = 'parent_replaced';

export function eventSpec(code: string): ComplianceEventSpec | null {
  return COMPLIANCE_EVENT_CODES.find((c) => c.code === code) ?? null;
}
