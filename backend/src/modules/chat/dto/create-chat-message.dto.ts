import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateChatMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  shipId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  get message(): string {
    return this.content;
  }
}
