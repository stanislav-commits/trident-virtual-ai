import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class MetricConceptMemberDto {
  @IsUUID()
  metricCatalogId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
