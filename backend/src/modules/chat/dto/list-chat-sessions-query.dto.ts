import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListChatSessionsQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  cursor?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
