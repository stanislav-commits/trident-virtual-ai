import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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

function normalizeBoundAssetId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class UpdateShipMetricDescriptionDto {
  @Transform(({ value }) => normalizeDescription(value))
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  // Manual override of the AI-suggested binding. uuid → bind to that asset
  // (confidence stamped to 1.0 = human-verified). null → clear the binding.
  // Omit the field entirely → leave the existing binding unchanged.
  @Transform(({ value }) => normalizeBoundAssetId(value))
  @IsOptional()
  @IsUUID()
  boundAssetId?: string | null;

  // Human override of the AI-suggested unit (e.g. AI said "Wh" but the field
  // actually publishes kWh — admin corrects to "kWh"). Empty/null clears the
  // override and we fall back to whatever the analyze step inferred.
  @Transform(({ value }) =>
    value === undefined
      ? undefined
      : value === null
        ? null
        : typeof value === 'string' && value.trim().length > 0
          ? value.trim()
          : null,
  )
  @IsOptional()
  @IsString()
  @MaxLength(30)
  aiUnit?: string | null;
}
