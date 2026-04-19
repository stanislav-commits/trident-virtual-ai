import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { ChatMessagesService } from './chat-messages.service';
import { ChatSessionsService } from './chat-sessions.service';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { ListChatSessionsQueryDto } from './dto/list-chat-sessions-query.dto';
import { SetChatSessionPinDto } from './dto/set-chat-session-pin.dto';
import { UpdateChatSessionDto } from './dto/update-chat-session.dto';

@Controller('chat-v2')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly chatSessionsService: ChatSessionsService,
    private readonly chatMessagesService: ChatMessagesService,
  ) {}

  @Get('sessions')
  listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListChatSessionsQueryDto,
  ) {
    return this.chatSessionsService.list(user, query);
  }

  @Post('sessions')
  createSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateChatSessionDto,
  ) {
    return this.chatSessionsService.create(user, body);
  }

  @Get('sessions/:sessionId')
  getSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatSessionsService.getOne(user, sessionId);
  }

  @Get('sessions/:sessionId/messages')
  getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatMessagesService.list(user, sessionId);
  }

  @Post('sessions/:sessionId/messages')
  createMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Body() body: CreateChatMessageDto,
  ) {
    return this.chatMessagesService.createUserMessage(user, sessionId, body);
  }

  @Post('sessions/:sessionId/regenerate')
  regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatMessagesService.regenerateAssistantMessage(user, sessionId);
  }

  @Patch('sessions/:sessionId')
  updateSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Body() body: UpdateChatSessionDto,
  ) {
    return this.chatSessionsService.rename(user, sessionId, body);
  }

  @Patch('sessions/:sessionId/pin')
  setPinned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Body() body: SetChatSessionPinDto,
  ) {
    return this.chatSessionsService.setPinned(user, sessionId, body);
  }

  @Delete('sessions/:sessionId')
  deleteSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatSessionsService.remove(user, sessionId);
  }

  @Delete('sessions/:sessionId/messages/:messageId')
  deleteMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chatMessagesService.remove(user, sessionId, messageId);
  }
}
