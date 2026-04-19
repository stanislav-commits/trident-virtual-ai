import { Injectable } from '@nestjs/common';
import { ExecutionPlan } from '../planner/interfaces/execution-plan.interface';
import { ChatHistoryExecutorService } from './chat-history/chat-history-executor.service';
import { DocumentsExecutorService } from './documents/documents-executor.service';
import { ExecutionContext, ExecutorResult } from './interfaces/executor-result.interface';
import { MetricsExecutorService } from './metrics/metrics-executor.service';
import { WebExecutorService } from './web/web-executor.service';

@Injectable()
export class ExecutorsService {
  constructor(
    private readonly chatHistoryExecutor: ChatHistoryExecutorService,
    private readonly metricsExecutor: MetricsExecutorService,
    private readonly documentsExecutor: DocumentsExecutorService,
    private readonly webExecutor: WebExecutorService,
  ) {}

  async runPlan(plan: ExecutionPlan, context: ExecutionContext): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];

    for (const step of plan.steps) {
      if (step.source === 'chat-history') {
        results.push(await this.chatHistoryExecutor.execute(step.query));
        continue;
      }

      if (step.source === 'metrics') {
        results.push(await this.metricsExecutor.execute(step.query, context));
        continue;
      }

      if (step.source === 'documents') {
        results.push(await this.documentsExecutor.execute(step.query, context));
        continue;
      }

      results.push(await this.webExecutor.execute(step.query, context));
    }

    return results;
  }
}
