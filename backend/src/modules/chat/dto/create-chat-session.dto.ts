import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChatSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  shipId?: string | null;
}
