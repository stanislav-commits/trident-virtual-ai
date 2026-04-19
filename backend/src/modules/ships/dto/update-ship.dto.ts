import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { normalizeImoNumber, normalizeOptionalInteger, normalizeTrimmedText } from '../ships.normalization';

export class UpdateShipDto {
  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  @MinLength(2)
  organizationName?: string;

  @Transform(({ value }) => normalizeImoNumber(value))
  @IsOptional()
  @IsString()
  @Matches(/^\d{7}$/, {
    message: 'IMO number must contain exactly 7 digits',
  })
  imoNumber?: string | null;

  @Transform(({ value }) => normalizeOptionalInteger(value))
  @IsOptional()
  @IsInt()
  @Min(1800)
  @Max(3000)
  buildYear?: number;
}
