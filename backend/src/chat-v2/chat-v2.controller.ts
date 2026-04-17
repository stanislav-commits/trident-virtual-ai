import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  ChatMessageResponseDto,
  ChatSessionListResponseDto,
  ChatSessionResponseDto,
} from '../chat/dto/chat-response.dto';
import { CreateChatSessionDto } from '../chat/dto/create-chat-session.dto';
import { SendMessageDto } from '../chat/dto/send-message.dto';
import { SetChatSessionPinDto } from '../chat/dto/set-chat-session-pin.dto';
import { ChatV2Service } from './chat-v2.service';

@Controller('chat-v2')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChatV2Controller {
  constructor(private readonly chatV2Service: ChatV2Service) {}

  @Post('sessions')
  createSession(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateChatSessionDto,
  ): Promise<ChatSessionResponseDto> {
    return this.chatV2Service.createSession(user, dto);
  }

  @Get('sessions')
  listSessions(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ChatSessionListResponseDto> {
    return this.chatV2Service.listSessions(user, { search, cursor, limit });
  }

  @Get('sessions/:id')
  getSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatV2Service.getSession(sessionId, user);
  }

  @Patch('sessions/:id')
  updateSession(
    @Param('id') sessionId: string,
    @Body() body: { title?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatV2Service.updateSessionTitle(sessionId, user, body.title);
  }

  @Patch('sessions/:id/pin')
  setSessionPinned(
    @Param('id') sessionId: string,
    @Body() dto: SetChatSessionPinDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatV2Service.setSessionPinned(sessionId, user, dto);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  deleteSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.chatV2Service.deleteSession(sessionId, user);
  }

  @Post('sessions/:id/messages')
  sendMessage(
    @Param('id') sessionId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatMessageResponseDto> {
    return this.chatV2Service.addMessage(sessionId, user, dto);
  }

  @Get('sessions/:id/messages')
  async getMessages(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatMessageResponseDto[]> {
    const session = await this.chatV2Service.getSession(sessionId, user);
    return session.messages || [];
  }

  @Delete('sessions/:sessionId/messages/:messageId')
  @HttpCode(204)
  deleteMessage(
    @Param('sessionId') sessionId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.chatV2Service.deleteMessage(sessionId, messageId, user);
  }

  @Post('sessions/:id/regenerate')
  regenerateLastResponse(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatMessageResponseDto> {
    return this.chatV2Service.regenerateLastResponse(sessionId, user);
  }
}
