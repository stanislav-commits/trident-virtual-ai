import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export type MetricCatalogBoundFilter = 'all' | 'bound' | 'unbound';

export class ListShipMetricCatalogQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  bucket?: string;

  // Filter by asset binding state:
  //   all      → no filter (default)
  //   bound    → only metrics with a bound_asset_id
  //   unbound  → only metrics without one (typically NMEA / SignalK channels
  //              where no matching virtual subsystem asset exists, or AI
  //              returned NONE for low-confidence cases)
  @IsOptional()
  @IsIn(['all', 'bound', 'unbound'])
  bound?: MetricCatalogBoundFilter;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
