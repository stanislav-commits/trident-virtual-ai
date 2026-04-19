import { SourceReferenceDto } from '../../../common/dto/source-reference.dto';
import { ExecutorResult } from '../../executors/interfaces/executor-result.interface';
import { ExecutionPlan } from '../../planner/interfaces/execution-plan.interface';

export class ChatResponseDto {
  requestId!: string;
  language!: string;
  requiresClarification!: boolean;
  clarificationQuestion?: string;
  message!: string;
  plan!: ExecutionPlan;
  results!: ExecutorResult[];
  citations!: SourceReferenceDto[];
}
