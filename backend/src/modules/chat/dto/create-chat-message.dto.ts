import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Metadata echoed back from POST sessions/:id/attachments. The binary is
 *  already in storage under (sessionId, id); this just rides on the message. */
export class ChatMessageAttachmentDto {
  @IsString()
  @MinLength(1)
  id!: string;

  @IsString()
  name!: string;

  @IsString()
  mimeType!: string;

  @IsOptional()
  @IsInt()
  sizeBytes?: number;

  @IsString()
  provider!: string;
}

export class CreateChatMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageAttachmentDto)
  attachments?: ChatMessageAttachmentDto[];

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
