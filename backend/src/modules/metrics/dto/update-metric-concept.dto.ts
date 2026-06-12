import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MetricAggregationRule } from '../enums/metric-aggregation-rule.enum';
import { MetricConceptType } from '../enums/metric-concept-type.enum';
import { MetricRangeAggregation } from '../enums/metric-query-time-mode.enum';
import { MetricConceptMemberDto } from './metric-concept-member.dto';

export class UpdateMetricConceptDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsEnum(MetricConceptType)
  type?: MetricConceptType;

  @IsOptional()
  @IsEnum(MetricAggregationRule)
  aggregationRule?: MetricAggregationRule;

  // Hint for how to aggregate this concept over the time axis when
  // timeMode = RANGE. Pass null in the request body to clear it.
  @IsOptional()
  @IsEnum(MetricRangeAggregation)
  rangeAggregationHint?: MetricRangeAggregation | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => MetricConceptMemberDto)
  members?: MetricConceptMemberDto[];
}
