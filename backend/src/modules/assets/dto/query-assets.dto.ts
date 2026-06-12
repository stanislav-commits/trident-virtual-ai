import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AssetLifecycleStatus } from '../enums/asset-lifecycle-status.enum';

export class QueryAssetsDto {
  // Free-text search across asset_id_internal / display_name / brand / model
  // / serial_no / sfi_sub_name.
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(AssetLifecycleStatus)
  lifecycleStatus?: AssetLifecycleStatus;

  // Filter by SFI top-level group, e.g. "3.0" returns all engines + props.
  @IsOptional()
  @IsString()
  sfiGroup?: string;

  // Filter by exact SFI subgroup, e.g. "3.2" returns Main Propulsion Motors.
  @IsOptional()
  @IsString()
  sfiSub?: string;

  // Convenience prefix for `asset_id_internal`, e.g. "SWX.3.2" returns the
  // whole propulsion-motor branch.
  @IsOptional()
  @IsString()
  assetIdPrefix?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(0)
  offset?: number;
}
