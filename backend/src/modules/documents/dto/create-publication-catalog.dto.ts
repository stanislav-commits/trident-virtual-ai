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

export class CreatePublicationCatalogDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  /** Flag/voyage conditionality (e.g. "flag-specific", "if operating polar"). */
  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(120)
  conditionalNote?: string | null;

  /** Library taxonomy (Regs4Ships load) — see PublicationCatalogEntity. */
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

  /** Section headings of the merged document — searchable, never rendered. */
  @Transform(({ value }) => normalizeOptionalText(value))
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  contents?: string | null;
}
