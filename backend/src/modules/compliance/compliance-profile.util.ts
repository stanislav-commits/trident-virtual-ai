/**
 * Pure helpers that map a ship's compliance profile (size, flag,
 * operation type) onto the applicability columns of the vessel-agnostic
 * compliance master matrix. Kept free of Nest/TypeORM runtime so they are
 * trivially unit-testable.
 */

import { ComplianceDocMasterEntity } from './entities/compliance-doc-master.entity';

/** gt_bucket value → master-matrix applicability column. */
export const GT_BUCKET_COLUMN: Record<
  string,
  keyof ComplianceDocMasterEntity
> = {
  lt24: 'appLt24',
  '24_300': 'app24300',
  '300_399': 'app300399',
  '400_499': 'app400499',
  '500_3000': 'app5003000',
  gt3000: 'appGt3000',
};

/** flag_registry value → master-matrix applicability column. */
export const FLAG_REGISTRY_COLUMN: Record<
  string,
  keyof ComplianceDocMasterEntity
> = {
  red_ensign: 'appRedEnsign',
  eu: 'appEuFlag',
  other: 'appOtherFlag',
};

/** <24m bucket is by LENGTH; the rest by gross tonnage. */
export function deriveGtBucket(
  grossTonnage: number | null,
  lengthM: number | null,
): string | null {
  if (lengthM != null && lengthM > 0 && lengthM < 24) return 'lt24';
  if (grossTonnage == null || grossTonnage <= 0) return null;
  if (grossTonnage < 300) return '24_300';
  if (grossTonnage <= 399) return '300_399';
  if (grossTonnage <= 499) return '400_499';
  if (grossTonnage <= 3000) return '500_3000';
  return 'gt3000';
}

/** Map a free-text flag state to the matrix's flag columns. */
export function deriveFlagRegistry(flag: string | null): string | null {
  if (!flag) return null;
  const f = flag.toLowerCase();
  const redEnsign = [
    'cayman', 'uk', 'united kingdom', 'british', 'bermuda', 'gibraltar',
    'isle of man', 'bvi', 'virgin islands', 'guernsey', 'jersey',
  ];
  const eu = [
    'malta', 'france', 'italy', 'spain', 'netherlands', 'germany',
    'greece', 'portugal', 'croatia', 'cyprus', 'belgium', 'denmark',
    'luxembourg', 'poland', 'ireland', 'finland', 'sweden',
  ];
  if (redEnsign.some((k) => f.includes(k))) return 'red_ensign';
  if (eu.some((k) => f.includes(k))) return 'eu';
  return 'other';
}

/**
 * Combine the applicable column values of one master row into a single
 * applicability verdict. Precedence: N (not applicable) beats C
 * (conditional) beats Y (required) beats R (recommended) — the most
 * restrictive signal wins.
 */
/**
 * What a resolved applicability letter MEANS for this vessel.
 *
 * The letters come from the Cert_Applicability_Matrix legend:
 *   Y = Required   C = Conditional (see notes)   R = Recommended
 *   N = Not Required   blank = TBD for this vessel
 *
 * Only `required` makes a document a compliance GAP: a conditional document
 * must not raise a missing-document alert until applicability is confirmed
 * for the vessel, and confirming is exactly
 * an operator switching the per-ship type from C to Y (PATCH types/:typeId).
 * Blank is TBD, so it is treated as conditional rather than silently required.
 */
export type ApplicabilityVerdict =
  | 'required'
  | 'conditional'
  | 'recommended'
  | 'not_applicable';

export function applicabilityVerdict(
  applicability: string | null | undefined,
): ApplicabilityVerdict {
  switch (String(applicability ?? '').trim().toUpperCase()) {
    case 'Y':
      return 'required';
    case 'R':
      return 'recommended';
    case 'N':
      return 'not_applicable';
    case 'C':
    default:
      return 'conditional'; // C and blank/TBD alike
  }
}

/** Does a missing document of this applicability count as a compliance gap? */
export function raisesGap(applicability: string | null | undefined): boolean {
  return applicabilityVerdict(applicability) === 'required';
}

/**
 * Hide a not-required document from the register — but only while it holds no
 * records. Something an operator actually uploaded is never hidden, whatever
 * the matrix says about this vessel.
 */
export function hideFromRegister(
  applicability: string | null | undefined,
  recordCount: number,
): boolean {
  return (
    recordCount === 0 && applicabilityVerdict(applicability) === 'not_applicable'
  );
}

export function resolveApplicability(
  row: ComplianceDocMasterEntity,
  keys: {
    gtKey: keyof ComplianceDocMasterEntity;
    opKey: keyof ComplianceDocMasterEntity;
    flagKey: keyof ComplianceDocMasterEntity | null;
  },
): string {
  const vals = [
    row[keys.gtKey],
    row[keys.opKey],
    keys.flagKey ? row[keys.flagKey] : '',
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (!vals.length) return '';
  if (vals.includes('N')) return 'N';
  if (vals.includes('C')) return 'C';
  if (vals.includes('Y')) return 'Y';
  if (vals.includes('R')) return 'R';
  return vals[0];
}
