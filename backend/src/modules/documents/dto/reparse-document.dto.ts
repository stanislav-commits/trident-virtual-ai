import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
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

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export class ReparseDocumentMetadataDto {
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
  manufacturer?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  model?: string | null;

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

export class ReparseDocumentDto {
  @IsOptional()
  @IsEnum(DocumentDocClass)
  docClass?: DocumentDocClass;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReparseDocumentMetadataDto)
  metadata?: ReparseDocumentMetadataDto;
}

export function toReparseMetadataOverrides(
  input: ReparseDocumentMetadataDto | undefined,
): ReparseDocumentMetadataDto {
  return input ?? {};
}
