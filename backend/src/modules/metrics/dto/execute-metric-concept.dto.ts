import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MetricQueryTimeMode } from '../enums/metric-query-time-mode.enum';

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
}
