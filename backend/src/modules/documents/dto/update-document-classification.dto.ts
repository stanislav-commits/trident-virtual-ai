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
import { DocumentRole } from '../enums/document-role.enum';
import { DocumentTimeScope } from '../enums/document-time-scope.enum';

function normalizeOptionalText(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeOptionalEnum(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export class UpdateDocumentClassificationDto {
  @IsOptional()
  @IsEnum(DocumentDocClass)
  docClass?: DocumentDocClass;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  language?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  equipmentOrSystem?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(255)
  equipmentName?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  equipmentAliases?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  manufacturer?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  model?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(255)
  systemArea?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  documentPurpose?: string | null;

  @Transform(({ value }) => normalizeOptionalEnum(value))
  @IsOptional()
  @IsEnum(DocumentRole)
  documentRole?: DocumentRole | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  revision?: string | null;

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
  contentFocus?: string | null;
}
