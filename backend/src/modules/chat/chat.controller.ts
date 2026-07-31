import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { ChatDailyBriefService } from './chat-daily-brief.service';
import { ChatMessagesService } from './chat-messages.service';
import { ChatProgressBus } from './progress/chat-progress.bus';
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
    private readonly chatProgressBus: ChatProgressBus,
    private readonly chatDailyBriefService: ChatDailyBriefService,
  ) {}

  /**
   * Re-post today's brief notification (admin only) — the same announcement
   * the cron makes, counted from the alarm log and the task list. Costs
   * nothing: it does not write the brief.
   */
  @Post('daily-brief/announce')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  announceDailyBrief() {
    return this.chatDailyBriefService.announceForAllShips();
  }

  /**
   * Write today's full brief for one vessel and return the session it landed
   * in. This is the expensive half, so it happens only when a person presses
   * the button on the notification — and bills to that person.
   */
  @Post('daily-brief/generate')
  generateDailyBrief(
    @Body() body: { shipId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.chatDailyBriefService.generateForShip(body.shipId, user.id);
  }

  /**
   * Live progress stream for the assistant reply being generated in this
   * session. EventSource clients authenticate via `?access_token=` (the
   * browser API cannot set headers). Events: planning / ask_started /
   * tool / composing / done / error — see ChatProgressEvent.
   */
  @Sse('sessions/:sessionId/stream')
  async streamProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ): Promise<Observable<MessageEvent>> {
    await this.chatSessionsService.findAccessibleSessionOrThrow(
      user,
      sessionId,
    );
    return this.chatProgressBus
      .subscribe(sessionId)
      .pipe(map((event) => ({ data: event }) as MessageEvent));
  }

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

  /** Upload a photo for the NEXT message in this session ("+ attach") —
   *  returns metadata the client echoes back on send. The assistant sees
   *  attached images via Claude vision. */
  @Post('sessions/:sessionId/attachments')
  @UseInterceptors(FileInterceptor('file'))
  uploadAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @UploadedFile()
    file: { originalname?: string; mimetype?: string; size?: number; buffer?: Buffer },
  ) {
    if (!file?.buffer) throw new BadRequestException('file is required');
    return this.chatMessagesService.uploadAttachment(user, sessionId, file);
  }

  @Get('sessions/:sessionId/attachments/:attachmentId')
  async getAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const att = await this.chatMessagesService.getAttachment(
      user,
      sessionId,
      attachmentId,
    );
    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(att.name)}"`,
    );
    res.send(att.buffer);
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
