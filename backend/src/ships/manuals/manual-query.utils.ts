import { Prisma } from '@prisma/client';
import type { ShipManualCategory } from '../manual-category';

export function normalizeManualIds(ids?: string[]): string[] {
  if (!ids?.length) return [];
  return [...new Set(ids.map((id) => id?.trim()).filter(Boolean))];
}

export function normalizeManualSearchTerm(search?: string): string | undefined {
  const normalized = search?.trim();
  return normalized ? normalized : undefined;
}

export function buildManualWhere(
  shipId: string,
  options?: {
    category?: ShipManualCategory;
    search?: string;
    includeManualIds?: string[];
    excludeManualIds?: string[];
  },
): Prisma.ShipManualWhereInput {
  const normalizedSearch = normalizeManualSearchTerm(options?.search);

  return {
    shipId,
    ...(options?.category ? { category: options.category } : {}),
    ...(normalizedSearch
      ? {
          filename: {
            contains: normalizedSearch,
            mode: 'insensitive' as const,
          },
        }
      : {}),
    ...(options?.includeManualIds?.length
      ? { id: { in: options.includeManualIds } }
      : {}),
    ...(options?.excludeManualIds?.length
      ? { id: { notIn: options.excludeManualIds } }
      : {}),
  };
}
