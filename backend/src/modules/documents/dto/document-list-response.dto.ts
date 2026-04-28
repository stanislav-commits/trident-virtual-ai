import { DocumentResponseDto } from './document-response.dto';

export class DocumentListPaginationDto {
  page!: number;
  pageSize!: number;
  total!: number;
  totalPages!: number;
  hasNextPage!: boolean;
  hasPreviousPage!: boolean;
}

export class DocumentListResponseDto {
  items!: DocumentResponseDto[];
  pagination!: DocumentListPaginationDto;
}
