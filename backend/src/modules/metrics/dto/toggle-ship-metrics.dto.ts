import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class ToggleShipMetricsDto {
  @IsBoolean()
  isEnabled!: boolean;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  metricIds?: string[];
}
