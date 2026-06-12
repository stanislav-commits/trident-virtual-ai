import { IsOptional, IsString, MinLength } from 'class-validator';

export class SearchWebDto {
  @IsString()
  @MinLength(1)
  question!: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  vesselContext?: string;
}
