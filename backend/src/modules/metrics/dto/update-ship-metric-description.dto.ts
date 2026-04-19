import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

function normalizeDescription(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

export class UpdateShipMetricDescriptionDto {
  @Transform(({ value }) => normalizeDescription(value))
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;
}
