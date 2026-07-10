import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';
import { AssetLifecycleStatus } from '../enums/asset-lifecycle-status.enum';

export class CreateAssetDto {
  @IsString()
  @MaxLength(80)
  assetIdInternal!: string;

  @IsString()
  @MaxLength(255)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  sfiGroup?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sfiGroupName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sfiSub?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sfiSubName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  drawingCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  parentAssetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  servedByAssetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  locationAssetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  serialNo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  criticality?: number;

  @IsOptional()
  @IsEnum(AssetLifecycleStatus)
  lifecycleStatus?: AssetLifecycleStatus;

  @IsOptional()
  @IsDateString()
  commissionedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  rinaRef?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  // ── v14.6 universal location schema ──
  @IsOptional() @IsString() @MaxLength(2)   zone?: string;
  @IsOptional() @IsString() @MaxLength(10)  deckRole?: string;
  @IsOptional() @IsInt() @Min(-2) @Max(20)  deckLevel?: number;
  @IsOptional() @IsString() @MaxLength(50)  spaceInstance?: string;
  @IsOptional() @IsString() @MaxLength(255) spaceLabel?: string;

  // ── Maintenance ──
  @IsOptional() @IsString() @MaxLength(255) drawingRef?: string;
  @IsOptional() @IsString()                 inspectionObligation?: string;

  // ── Provenance ──
  @IsOptional() @IsBoolean() parentAutoPopulated?: boolean;
  @IsOptional() @IsBoolean() criticalityAutoPopulated?: boolean;
  @IsOptional() @IsString() @MaxLength(100) sourceSheet?: string;

  // ── Catch-all bucket ──
  @IsOptional() @IsObject() extras?: Record<string, unknown>;
}
