import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatContextService } from './chat-context.service';
import { LlmService } from './llm.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RagflowModule } from '../ragflow/ragflow.module';

@Module({
  imports: [PrismaModule, RagflowModule],
  controllers: [ChatController],
  providers: [ChatService, ChatContextService, LlmService],
  exports: [ChatService, ChatContextService, LlmService],
})
export class ChatModule {}
