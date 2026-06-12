import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  MetricQueryTimeMode,
  MetricRangeAggregation,
} from '../enums/metric-query-time-mode.enum';

export class ExecuteMetricConceptDto {
  @IsOptional()
  @IsUUID()
  conceptId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;

  @IsOptional()
  @IsUUID()
  shipId?: string;

  @IsOptional()
  @IsEnum(MetricQueryTimeMode)
  timeMode?: MetricQueryTimeMode;

  @IsOptional()
  @IsDateString()
  timestamp?: string;

  // Time window for timeMode = RANGE. Both bounds must be ISO-8601 strings;
  // they are required when timeMode = RANGE and ignored otherwise.
  @IsOptional()
  @IsDateString()
  rangeStart?: string;

  @IsOptional()
  @IsDateString()
  rangeEnd?: string;

  // Reduction across the time window. Defaults to MEAN inside the executor.
  @IsOptional()
  @IsEnum(MetricRangeAggregation)
  rangeAggregation?: MetricRangeAggregation;
}
