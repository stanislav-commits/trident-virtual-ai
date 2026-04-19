import { IsOptional, IsString, MinLength } from 'class-validator';

export class SearchDocumentsDto {
  @IsString()
  @MinLength(1)
  question!: string;

  @IsOptional()
  @IsString()
  shipId?: string;

  @IsOptional()
  @IsString()
  category?: string;
}
