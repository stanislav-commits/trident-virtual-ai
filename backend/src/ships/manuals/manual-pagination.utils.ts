import type { ManualsPaginationMeta } from './manual-pagination.types';

export interface ManualPaginationLimits {
  defaultPageSize: number;
  maxPageSize: number;
}

export function normalizeManualPagination(
  page: number | undefined,
  pageSize: number | undefined,
  limits: ManualPaginationLimits,
): { page: number; pageSize: number } {
  const normalizedPage = Number.isFinite(page)
    ? Math.max(1, Math.floor(page as number))
    : 1;
  const normalizedPageSize = Number.isFinite(pageSize)
    ? Math.max(1, Math.min(Math.floor(pageSize as number), limits.maxPageSize))
    : limits.defaultPageSize;

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

export function buildManualPaginationMeta(
  total: number,
  page: number,
  pageSize: number,
): ManualsPaginationMeta {
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  const currentPage = Math.min(page, totalPages);

  return {
    page: currentPage,
    pageSize,
    total,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1,
  };
}
