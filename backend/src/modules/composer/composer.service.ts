import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SourceReferenceDto } from '../../common/dto/source-reference.dto';
import { CreateChatMessageDto } from '../chat/dto/create-chat-message.dto';
import { ChatResponseDto } from '../chat/dto/chat-response.dto';
import { ExecutionPlan } from '../planner/interfaces/execution-plan.interface';
import { ExecutorResult } from '../executors/interfaces/executor-result.interface';

@Injectable()
export class ComposerService {
  composeClarification(plan: ExecutionPlan): ChatResponseDto {
    return {
      requestId: randomUUID(),
      language: plan.responseLanguage,
      requiresClarification: true,
      clarificationQuestion: plan.clarificationQuestion,
      plan,
      results: [],
      citations: [],
      message: plan.clarificationQuestion ?? 'Please clarify the request.',
    };
  }

  composeAnswer(
    plan: ExecutionPlan,
    results: ExecutorResult[],
    input: CreateChatMessageDto,
  ): ChatResponseDto {
    const citations = this.collectCitations(results);
    const leadingLine =
      plan.responseLanguage === 'uk'
        ? 'Підготував чорнову відповідь на основі доступних джерел.'
        : 'Prepared a draft answer from the currently available sources.';
    const requestLabel = plan.responseLanguage === 'uk' ? 'Запит' : 'Request';
    const detailLines = results.map(
      (result, index) => `${index + 1}. [${result.source}] ${result.summary}`,
    );

    return {
      requestId: randomUUID(),
      language: plan.responseLanguage,
      requiresClarification: false,
      plan,
      results,
      citations,
      message: [leadingLine, `${requestLabel}: ${input.message}`, ...detailLines].join('\n'),
    };
  }

  private collectCitations(results: ExecutorResult[]): SourceReferenceDto[] {
    return results.flatMap((result) => result.references);
  }
}
