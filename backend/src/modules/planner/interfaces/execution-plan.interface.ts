import { SourceType } from '../../../common/types/source-type';

export interface ExecutionStep {
  source: SourceType;
  reason: string;
  query: string;
}

export interface ExecutionPlan {
  intent: 'chat' | 'metrics' | 'documents' | 'web' | 'mixed';
  responseLanguage: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
  steps: ExecutionStep[];
}
