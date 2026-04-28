import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export type DocumentRemoteDeleteStatus =
  | 'deleted'
  | 'already_absent'
  | 'skipped'
  | 'failed';

export class BulkDeleteDocumentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];
}

export class DocumentDeleteResponseDto {
  id!: string;
  deleted!: boolean;
  remoteDeleteStatus!: DocumentRemoteDeleteStatus;
  error?: string;
}

export class BulkDeleteDocumentsResponseDto {
  requested!: number;
  deleted!: number;
  failed!: number;
  results!: DocumentDeleteResponseDto[];
}
