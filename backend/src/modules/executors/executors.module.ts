import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { MetricsModule } from '../metrics/metrics.module';
import { WebModule } from '../web/web.module';
import { ChatHistoryExecutorService } from './chat-history/chat-history-executor.service';
import { DocumentsExecutorService } from './documents/documents-executor.service';
import { ExecutorsService } from './executors.service';
import { MetricsExecutorService } from './metrics/metrics-executor.service';
import { WebExecutorService } from './web/web-executor.service';

@Module({
  imports: [MetricsModule, DocumentsModule, WebModule],
  providers: [
    ChatHistoryExecutorService,
    MetricsExecutorService,
    DocumentsExecutorService,
    WebExecutorService,
    ExecutorsService,
  ],
  exports: [ExecutorsService],
})
export class ExecutorsModule {}
