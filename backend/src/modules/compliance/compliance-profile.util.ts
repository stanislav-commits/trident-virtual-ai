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
