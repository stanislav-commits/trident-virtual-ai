import { IsString, IsOptional, IsUUID } from 'class-validator';

export class CreateChatSessionDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsUUID()
  shipId?: string;
}
