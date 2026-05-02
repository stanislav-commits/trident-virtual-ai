import { ConflictException } from '@nestjs/common';
import { DocumentParseStatus } from './enums/document-parse-status.enum';

export const REPARSE_SOURCE_UNAVAILABLE_MESSAGE =
  'Cannot reparse because the source file is unavailable and no remote document exists.';

export const REPARSE_ALLOWED_STATUSES = new Set<DocumentParseStatus>([
  DocumentParseStatus.FAILED,
  DocumentParseStatus.PARSED,
  DocumentParseStatus.REPARSE_REQUIRED,
]);

export const REPARSE_IN_PROGRESS_STATUSES = new Set<DocumentParseStatus>([
  DocumentParseStatus.UPLOADED,
  DocumentParseStatus.PENDING_CONFIG,
  DocumentParseStatus.PENDING_PARSE,
  DocumentParseStatus.PARSING,
]);

export function assertDocumentCanReparse(status: DocumentParseStatus): void {
  if (REPARSE_ALLOWED_STATUSES.has(status)) {
    return;
  }

  if (REPARSE_IN_PROGRESS_STATUSES.has(status)) {
    throw new ConflictException(
      'Cannot reparse while document ingestion or parsing is already in progress.',
    );
  }

  throw new ConflictException(
    `Cannot reparse document while parse status is "${status}".`,
  );
}
