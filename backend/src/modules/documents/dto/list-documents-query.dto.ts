import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentParseStatus } from '../enums/document-parse-status.enum';

export class ListDocumentsQueryDto {
  @IsOptional()
  @IsString()
  shipId?: string;

  @IsOptional()
  @IsEnum(DocumentDocClass)
  docClass?: DocumentDocClass;

  @IsOptional()
  @IsEnum(DocumentParseStatus)
  parseStatus?: DocumentParseStatus;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
