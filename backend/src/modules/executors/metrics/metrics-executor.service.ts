import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../metrics/metrics.service';
import { ExecutionContext, ExecutorResult } from '../interfaces/executor-result.interface';

@Injectable()
export class MetricsExecutorService {
  constructor(private readonly metricsService: MetricsService) {}

  async execute(query: string, context: ExecutionContext): Promise<ExecutorResult> {
    const preview = await this.metricsService.query({
      question: query,
      shipId: context.shipId,
    });

    return {
      source: 'metrics',
      summary: preview.summary,
      structuredData: preview.data,
      references: preview.references,
    };
  }
}
