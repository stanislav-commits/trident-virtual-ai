import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateChatSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title!: string;
}
