import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

/** Partial edit of a catalog slot — taxonomy reconciliation + housekeeping. */
export class UpdatePublicationCatalogDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(120)
  conditionalNote?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(30)
  jurisdiction?: string | null;

  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(160)
  series?: string | null;
}
