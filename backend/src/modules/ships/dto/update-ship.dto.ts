import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
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

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  mmsi?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  callSign?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  flag?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(600)
  lengthM?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  beamM?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  depthM?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500000)
  grossTonnage?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500000)
  netTonnage?: number | null;

  // Vessel master data — printed on statutory certificates, auto-populated
  // into compliance records rather than typed per certificate.
  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  officialNumber?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  portOfRegistry?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  registeredOwner?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  companyName?: string | null;

  @Transform(({ value }) => normalizeImoNumber(value))
  @IsOptional()
  @IsString()
  @Matches(/^\d{7}$/, {
    message: 'Company IMO number must contain exactly 7 digits',
  })
  companyImoNumber?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  shipyard?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  classSociety?: string | null;

  /**
   * Which shelves of the publications library this vessel reads, in the
   * library's own vocabulary: "flag:MT", "class:RINA". Empty means the whole
   * library — the filter narrows on request, it never hides on a blank field.
   */
  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  publicationFlag?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  publicationClass?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  homePort?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsEmail()
  fleetManagerEmail?: string | null;

  @IsOptional()
  @IsIn(['private', 'commercial'])
  operationType?: string | null;

  @Transform(({ value }) => normalizeTrimmedText(value))
  @IsOptional()
  @IsString()
  metricAnalysisHint?: string | null;
}
