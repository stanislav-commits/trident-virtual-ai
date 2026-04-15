import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChatService } from './chat.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SetChatSessionPinDto } from './dto/set-chat-session-pin.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
  ChatSessionListResponseDto,
} from './dto/chat-response.dto';
import type { AuthUser } from '../auth/auth.service';

@Controller('chat')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('sessions')
  async createSession(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateChatSessionDto,
  ): Promise<ChatSessionResponseDto> {
    if (user.role !== 'admin') {
      if (!user.shipId) {
        throw new ForbiddenException('User is not assigned to any ship');
      }
      if (!dto.shipId || user.shipId !== dto.shipId) {
        throw new ForbiddenException('Cannot create chat for another ship');
      }
    }

    return this.chatService.createSession(user.id, dto);
  }

  @Get('sessions')
  async listSessions(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ChatSessionListResponseDto> {
    return this.chatService.listSessions(user.id, user.role, {
      search,
      cursor,
      limit,
    });
  }

  @Get('sessions/:id')
  async getSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatService.getSession(sessionId, user.id, user.role);
  }

  @Patch('sessions/:id')
  async updateSession(
    @Param('id') sessionId: string,
    @Body() body: { title?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatService.updateSessionTitle(
      sessionId,
      user.id,
      user.role,
      body.title,
    );
  }

  @Patch('sessions/:id/pin')
  async setSessionPinned(
    @Param('id') sessionId: string,
    @Body() dto: SetChatSessionPinDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatService.setSessionPinned(
      sessionId,
      user.id,
      user.role,
      dto.isPinned,
    );
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async deleteSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.chatService.deleteSession(sessionId, user.id, user.role);
  }

  @Post('sessions/:id/messages')
  async sendMessage(
    @Param('id') sessionId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatMessageResponseDto> {
    return this.chatService.addMessage(sessionId, user.id, user.role, dto);
  }

  @Get('sessions/:id/messages')
  async getMessages(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatMessageResponseDto[]> {
    const session = await this.chatService.getSession(
      sessionId,
      user.id,
      user.role,
    );
    return session.messages || [];
  }

  @Delete('sessions/:sessionId/messages/:messageId')
  @HttpCode(204)
  async deleteMessage(
    @Param('sessionId') sessionId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.chatService.deleteMessage(
      sessionId,
      messageId,
      user.id,
      user.role,
    );
  }

  @Post('sessions/:id/regenerate')
  async regenerateLastResponse(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatMessageResponseDto> {
    return this.chatService.regenerateLastResponse(
      sessionId,
      user.id,
      user.role,
    );
  }
}
