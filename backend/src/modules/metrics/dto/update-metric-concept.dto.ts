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
import { MetricConceptMemberDto } from './metric-concept-member.dto';

export class UpdateMetricConceptDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;

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

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => MetricConceptMemberDto)
  members?: MetricConceptMemberDto[];
}
