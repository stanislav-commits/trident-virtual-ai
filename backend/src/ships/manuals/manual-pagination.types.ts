import type { ShipManualCategory } from '../manual-category';

export interface ManualRecord {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  category: ShipManualCategory;
  uploadedAt: Date;
}

export interface ManualsPaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedManualsResult<T> {
  items: T[];
  pagination: ManualsPaginationMeta;
}
