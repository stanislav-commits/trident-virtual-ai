import { Injectable } from '@nestjs/common';
import { DocumentsService } from '../../documents/documents.service';
import { ExecutionContext, ExecutorResult } from '../interfaces/executor-result.interface';

@Injectable()
export class DocumentsExecutorService {
  constructor(private readonly documentsService: DocumentsService) {}

  async execute(query: string, context: ExecutionContext): Promise<ExecutorResult> {
    const preview = await this.documentsService.search({
      question: query,
      shipId: context.shipId,
    });

    return {
      source: 'documents',
      summary: preview.summary,
      structuredData: preview.data,
      references: preview.references,
    };
  }
}
