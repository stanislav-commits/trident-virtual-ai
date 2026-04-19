import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppLoggerService } from './core/logging/app-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(AppLoggerService);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);
  const corsOrigins = configService.get<string[]>('app.corsOrigins', [
    'http://localhost:3000',
    'http://localhost:5173',
  ]);

  app.useLogger(logger);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: corsOrigins.length === 1 && corsOrigins[0] === '*' ? true : corsOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.listen(port);
  logger.log(`Backend listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
