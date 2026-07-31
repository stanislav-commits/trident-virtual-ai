import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Apply one value to many assets.
 *
 * Deliberately a short list of fields. The register's operational columns sit
 * empty on production not because there is nowhere to put them but because
 * filling 1500 of them one drawer at a time is not work anyone does — these are
 * the ones an operator sets for a whole class at once. Identity fields
 * (asset id, name, serial) are absent on purpose: those are per-unit facts and
 * a bulk write would only ever be a mistake.
 *
 * A field left undefined is untouched; an explicit null clears it.
 */
export class BulkUpdateAssetsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(2000)
  @IsUUID('4', { each: true })
  assetIds!: string[];

  @IsOptional() @IsString() @MaxLength(255) location?: string | null;

  @IsOptional()
  @IsIn(['engine', 'deck', 'interior', 'galley'])
  department?: string | null;

  @IsOptional() @IsString() @MaxLength(120) brand?: string | null;
  @IsOptional() @IsString() @MaxLength(120) model?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}
