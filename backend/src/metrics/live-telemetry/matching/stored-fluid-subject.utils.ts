import type { StoredFluidSubject } from '../live-telemetry.types';

export function detectWaterQualifiers(
  normalizedQuery: string,
): StoredFluidSubject['waterQualifiers'] {
  const qualifiers = new Set<
    NonNullable<StoredFluidSubject['waterQualifiers']>[number]
  >();

  if (/\bfresh\s*water\b/i.test(normalizedQuery)) {
    qualifiers.add('fresh');
  }
  if (/\bsea\s*water\b|\bseawater\b/i.test(normalizedQuery)) {
    qualifiers.add('sea');
  }
  if (
    /\bblack(?:\s+and\s+grey|\s*&\s*grey)?\s+water\b/i.test(normalizedQuery)
  ) {
    qualifiers.add('black');
    if (/\bgrey\b|\bgray\b/i.test(normalizedQuery)) {
      qualifiers.add('grey');
    }
  } else if (/\bblack\s+water\b/i.test(normalizedQuery)) {
    qualifiers.add('black');
  }
  if (/\bgrey\s+water\b|\bgray\s+water\b/i.test(normalizedQuery)) {
    qualifiers.add('grey');
  }
  if (
    /\bbilge\s+water\b|\bbilge\b[\s\S]{0,12}\btank\b/i.test(normalizedQuery)
  ) {
    qualifiers.add('bilge');
  }

  return qualifiers.size > 0 ? [...qualifiers] : undefined;
}

export function matchesWaterQualifier(
  haystack: string,
  qualifier: NonNullable<StoredFluidSubject['waterQualifiers']>[number],
): boolean {
  switch (qualifier) {
    case 'fresh':
      return /\bfresh\s*water\b/i.test(haystack);
    case 'sea':
      return /\bsea\s*water\b|\bseawater\b/i.test(haystack);
    case 'black':
      return /\bblack\b[\s\S]{0,12}\bwater\b/i.test(haystack);
    case 'grey':
      return /\b(grey|gray)\b[\s\S]{0,12}\bwater\b/i.test(haystack);
    case 'bilge':
      return /\bbilge\b[\s\S]{0,12}\bwater\b|\bbilge\b[\s\S]{0,12}\btank\b/i.test(
        haystack,
      );
    default:
      return false;
  }
}

export function matchesStoredFluidSubject(
  haystack: string,
  subject: StoredFluidSubject,
): boolean {
  if (subject.fluid === 'water') {
    if (!/\bwater\b/i.test(haystack)) {
      return false;
    }

    if (!subject.waterQualifiers?.length) {
      return true;
    }

    return subject.waterQualifiers.some((qualifier) =>
      matchesWaterQualifier(haystack, qualifier),
    );
  }

  if (subject.fluid === 'def') {
    return /\b(def|urea)\b/i.test(haystack);
  }

  return new RegExp(`\\b${subject.fluid}\\b`, 'i').test(haystack);
}

export function detectStoredFluidSubject(
  normalizedQuery: string,
): StoredFluidSubject | null {
  if (/\bfuel\b/i.test(normalizedQuery)) return { fluid: 'fuel' };
  if (/\boil\b/i.test(normalizedQuery)) return { fluid: 'oil' };
  if (/\bcoolant\b/i.test(normalizedQuery)) return { fluid: 'coolant' };
  if (/\b(def|urea)\b/i.test(normalizedQuery)) return { fluid: 'def' };
  if (
    /\b(water|fresh water|seawater|sea water|black water|grey water|gray water|bilge water)\b/i.test(
      normalizedQuery,
    )
  ) {
    const waterQualifiers = detectWaterQualifiers(normalizedQuery);
    return (waterQualifiers?.length ?? 0) > 0
      ? { fluid: 'water', waterQualifiers }
      : { fluid: 'water' };
  }
  return null;
}

export function describeStoredFluidSubject(subject: StoredFluidSubject): string {
  if (subject.fluid !== 'water') {
    return subject.fluid === 'def' ? 'DEF' : subject.fluid;
  }

  const qualifiers = subject.waterQualifiers ?? [];
  if (qualifiers.includes('fresh')) return 'fresh water';
  if (qualifiers.includes('sea')) return 'sea water';
  if (qualifiers.includes('black')) return 'black water';
  if (qualifiers.includes('grey')) return 'grey water';
  if (qualifiers.includes('bilge')) return 'bilge water';
  return 'water';
}
