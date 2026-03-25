import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemPromptController } from './system-prompt.controller';
import { SystemPromptService } from './system-prompt.service';

@Module({
  imports: [PrismaModule],
  controllers: [SystemPromptController],
  providers: [SystemPromptService],
  exports: [SystemPromptService],
})
export class SystemPromptModule {}
