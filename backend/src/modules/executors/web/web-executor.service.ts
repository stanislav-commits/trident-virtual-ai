import { Injectable } from '@nestjs/common';
import { WebService } from '../../web/web.service';
import { ExecutionContext, ExecutorResult } from '../interfaces/executor-result.interface';

@Injectable()
export class WebExecutorService {
  constructor(private readonly webService: WebService) {}

  async execute(query: string, context: ExecutionContext): Promise<ExecutorResult> {
    const preview = await this.webService.search({
      question: query,
      locale: context.locale,
    });

    return {
      source: 'web',
      summary: preview.summary,
      structuredData: preview.data,
      references: preview.references,
    };
  }
}
