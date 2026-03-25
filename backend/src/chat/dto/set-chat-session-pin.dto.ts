import { IsBoolean } from 'class-validator';

export class SetChatSessionPinDto {
  @IsBoolean()
  isPinned: boolean;
}
