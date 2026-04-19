import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ResolveMetricConceptDto {
  @IsString()
  @MaxLength(255)
  query!: string;

  @IsOptional()
  @IsUUID()
  shipId?: string;
}
