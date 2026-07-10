import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AppLoggerService } from './core/logging/app-logger.service';

async function bootstrap() {
  // Disable the default 100kb body parser and register our own with a larger
  // limit — bulk endpoints (e.g. PMS import commit of hundreds of tasks) send
  // JSON bodies well over the default and were rejected with 413. Multipart
  // uploads go through multer and are unaffected.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ extended: true, limit: '15mb' }));
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
