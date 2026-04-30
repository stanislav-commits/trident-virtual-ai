import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthenticatedUser } from '../../../core/auth/auth.types';
import { CurrentUser } from '../../../core/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../core/auth/guards/jwt-auth.guard';
import {
  CHAT_VOICE_AUDIO_FIELD_NAME,
  getChatVoiceUploadLimitBytes,
} from './chat-voice.constants';
import { ChatVoiceTranscriptionService } from './chat-voice-transcription.service';
import { UploadedChatVoiceAudioFile } from './chat-voice.types';
import { CreateChatVoiceTranscriptionDto } from './dto/create-chat-voice-transcription.dto';

@Controller('chat-v2/voice')
@UseGuards(JwtAuthGuard)
export class ChatVoiceController {
  constructor(
    private readonly chatVoiceTranscriptionService: ChatVoiceTranscriptionService,
  ) {}

  @Post('transcriptions')
  @UseInterceptors(
    FileInterceptor(CHAT_VOICE_AUDIO_FIELD_NAME, {
      limits: {
        fileSize: getChatVoiceUploadLimitBytes(),
      },
    }),
  )
  transcribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateChatVoiceTranscriptionDto,
    @UploadedFile() file: UploadedChatVoiceAudioFile,
  ) {
    return this.chatVoiceTranscriptionService.transcribe(user, body, file);
  }
}
