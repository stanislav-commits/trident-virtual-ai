import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './core/auth/auth.module';
import configuration from './core/config/configuration';
import { validateEnvironment } from './core/config/validate-environment';
import { DatabaseModule } from './core/database/database.module';
import { HealthModule } from './core/health/health.module';
import { LoggingModule } from './core/logging/logging.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AdminModule } from './modules/admin/admin.module';
import { ChatModule } from './modules/chat/chat.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { ShipsModule } from './modules/ships/ships.module';
import { UsersModule } from './modules/users/users.module';
import { WebModule } from './modules/web/web.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      load: [configuration],
      validate: validateEnvironment,
    }),
    LoggingModule,
    DatabaseModule,
    IntegrationsModule,
    AuthModule,
    HealthModule,
    UsersModule,
    ShipsModule,
    MetricsModule,
    DocumentsModule,
    WebModule,
    ChatModule,
    AdminModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
