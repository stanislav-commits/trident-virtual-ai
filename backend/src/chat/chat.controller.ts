import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChatService } from './chat.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
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
  ): Promise<ChatSessionResponseDto[]> {
    return this.chatService.listSessions(user.id, user.role);
  }

  @Get('sessions/:id')
  async getSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatService.getSession(sessionId, user.id, user.role);
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
}
