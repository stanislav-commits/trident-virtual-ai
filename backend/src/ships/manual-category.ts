export const SHIP_MANUAL_CATEGORIES = [
  'MANUALS',
  'HISTORY_PROCEDURES',
  'CERTIFICATES',
  'REGULATION',
] as const;

export type ShipManualCategory = (typeof SHIP_MANUAL_CATEGORIES)[number];

export const DEFAULT_SHIP_MANUAL_CATEGORY: ShipManualCategory = 'MANUALS';

type ShipManualCategoryDetails = {
  label: string;
  ragflowParentPath: string;
};

export const SHIP_MANUAL_CATEGORY_DETAILS: Record<
  ShipManualCategory,
  ShipManualCategoryDetails
> = {
  MANUALS: {
    label: 'Manuals',
    ragflowParentPath: 'Manuals',
  },
  HISTORY_PROCEDURES: {
    label: 'History Procedures',
    ragflowParentPath: 'History Procedures',
  },
  CERTIFICATES: {
    label: 'Certificates',
    ragflowParentPath: 'Certificates',
  },
  REGULATION: {
    label: 'Regulation',
    ragflowParentPath: 'Regulation',
  },
};

function normalizeCategoryValue(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/[\s-]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

export function parseShipManualCategory(
  value?: string | null,
): ShipManualCategory | undefined {
  const normalized = normalizeCategoryValue(value);
  if (!normalized) return undefined;
  return SHIP_MANUAL_CATEGORIES.find((category) => category === normalized);
}

export function resolveShipManualCategory(
  value?: string | null,
): ShipManualCategory {
  return parseShipManualCategory(value) ?? DEFAULT_SHIP_MANUAL_CATEGORY;
}
