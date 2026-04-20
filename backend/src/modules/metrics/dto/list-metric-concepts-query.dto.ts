import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListMetricConceptsQueryDto {
  @IsOptional()
  @IsString()
  shipId?: string;

  @IsOptional()
  @IsString()
  search?: string;

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
