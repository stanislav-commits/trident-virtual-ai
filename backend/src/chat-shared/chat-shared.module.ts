import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemPromptModule } from '../system-prompt/system-prompt.module';
import { LlmService } from './llm/llm.service';
import { ChatQueryPlannerService } from './query/chat-query-planner.service';
import { ChatSessionService } from './session/chat-session.service';

@Module({
  imports: [PrismaModule, SystemPromptModule],
  providers: [LlmService, ChatQueryPlannerService, ChatSessionService],
  exports: [LlmService, ChatQueryPlannerService, ChatSessionService],
})
export class ChatSharedModule {}
