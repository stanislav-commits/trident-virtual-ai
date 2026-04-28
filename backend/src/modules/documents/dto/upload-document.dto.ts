import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentTimeScope } from '../enums/document-time-scope.enum';

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export class UploadDocumentDto {
  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  shipId?: string;

  @IsEnum(DocumentDocClass)
  docClass!: DocumentDocClass;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  language?: string;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  equipmentOrSystem?: string;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  manufacturer?: string;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  model?: string;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  revision?: string;

  @IsOptional()
  @IsEnum(DocumentTimeScope)
  timeScope?: DocumentTimeScope;

  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sourcePriority?: number;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  contentFocus?: string;
}
