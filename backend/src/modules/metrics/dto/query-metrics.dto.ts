import { IsOptional, IsString, MinLength } from 'class-validator';

export class QueryMetricsDto {
  @IsString()
  @MinLength(1)
  question!: string;

  @IsOptional()
  @IsString()
  shipId?: string;

  @IsOptional()
  @IsString()
  timeRange?: string;
}
