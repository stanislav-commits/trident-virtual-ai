import { SourceReferenceDto } from '../../../common/dto/source-reference.dto';
import { SourceType } from '../../../common/types/source-type';

export interface ExecutionContext {
  message: string;
  locale?: string;
  sessionId?: string;
  shipId?: string;
  userId?: string;
}

export interface ExecutorResult {
  source: SourceType;
  summary: string;
  structuredData?: Record<string, unknown>;
  references: SourceReferenceDto[];
}
