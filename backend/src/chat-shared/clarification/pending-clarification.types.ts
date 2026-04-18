export type PendingClarificationLanguageHint = string | null;

export type PendingClarificationDomain = 'metrics_v2';

export type PendingClarificationKind =
  | 'ambiguous_metrics'
  | 'group_not_confident'
  | 'exact_metric_not_found';

export interface PendingClarificationOption {
  id: string;
  label: string;
  metricKey?: string;
  businessConcept?: string;
  measurementKind?: string;
  source?: 'current' | 'historical';
}

export interface PendingClarification {
  id: string;
  domain: PendingClarificationDomain;
  kind: PendingClarificationKind;
  language: PendingClarificationLanguageHint;
  question: string;
  originalUserQuery: string;
  createdAtIso: string;
  requestId?: string;
  requestPlan?: Record<string, unknown>;
  options: PendingClarificationOption[];
}
