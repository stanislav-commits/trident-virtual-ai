import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';
import { AssetLifecycleStatus } from '../enums/asset-lifecycle-status.enum';

export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  assetIdInternal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  sfiGroup?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sfiSub?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sfiSubName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  parentAssetId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  servedByAssetId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  locationAssetId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  serialNo?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  criticality?: number | null;

  @IsOptional()
  @IsEnum(AssetLifecycleStatus)
  lifecycleStatus?: AssetLifecycleStatus;

  @IsOptional()
  @IsDateString()
  commissionedDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  rinaRef?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;

  // ── v14.6 location schema ──
  @IsOptional() @IsString() @MaxLength(2)   zone?: string | null;
  @IsOptional() @IsString() @MaxLength(10)  deckRole?: string | null;
  @IsOptional() @IsString() @MaxLength(50)  spaceInstance?: string | null;
  @IsOptional() @IsString() @MaxLength(255) spaceLabel?: string | null;
  // ── Maintenance ──
  @IsOptional() @IsString() @MaxLength(255) drawingRef?: string | null;
  @IsOptional() @IsString()                 inspectionObligation?: string | null;
}
