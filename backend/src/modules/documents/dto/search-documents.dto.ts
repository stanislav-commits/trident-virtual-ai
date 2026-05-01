import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';

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

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const values = Array.isArray(value) ? value : String(value).split(',');
  const normalized = values
    .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
    .filter(Boolean);

  return normalized.length ? normalized : undefined;
}

export class SearchDocumentsDto {
  @Transform(({ value }) => normalizeOptionalText(value) ?? value)
  @IsString()
  @MinLength(1)
  question!: string;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  shipId?: string;

  /**
   * Legacy category input retained for older callers. New callers should use
   * candidateDocClasses.
   */
  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  category?: string;

  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @IsEnum(DocumentDocClass, { each: true })
  candidateDocClasses?: DocumentDocClass[];

  @IsOptional()
  @IsEnum(DocumentRetrievalQuestionType)
  questionType?: DocumentRetrievalQuestionType;

  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  equipmentOrSystemHints?: string[];

  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  manufacturerHints?: string[];

  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modelHints?: string[];

  @Transform(({ value }) => normalizeStringArray(value))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contentFocusHints?: string[];

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  languageHint?: string;

  /**
   * Optional document title/file-name hint. When the question clearly targets
   * a known manual by name, callers can pass the title (or filename) to bias
   * retrieval toward documents whose stored name matches the hint.
   */
  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  documentTitleHint?: string;

  @Transform(({ value }) => normalizeOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  requireDocumentTitleMatch?: boolean;

  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;

  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  candidateK?: number;

  @Transform(({ value }) => normalizeOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  allowMultiDocument?: boolean;

  @Transform(({ value }) => normalizeOptionalBoolean(value))
  @IsOptional()
  @IsBoolean()
  allowWeakEvidence?: boolean;
}
