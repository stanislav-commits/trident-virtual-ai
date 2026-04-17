import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { ShipsModule } from './ships/ships.module';
import { SystemPromptModule } from './system-prompt/system-prompt.module';
import { TagsModule } from './tags/tags.module';
import { UsersModule } from './users/users.module';
import { ChatModule } from './chat/chat.module';
import { ChatV2Module } from './chat-v2/chat-v2.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    ShipsModule,
    MetricsModule,
    SystemPromptModule,
    TagsModule,
    ChatModule,
    ChatV2Module,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
