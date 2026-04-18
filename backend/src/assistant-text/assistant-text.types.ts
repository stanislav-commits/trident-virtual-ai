export type AssistantCopyKey =
  | 'chat_history.no_previous_user_message'
  | 'chat_history.no_previous_assistant_message'
  | 'chat_history.previous_user_message'
  | 'chat_history.previous_assistant_message'
  | 'chat_history.summary_empty'
  | 'chat_history.clarification'
  | 'metrics.current_heading'
  | 'metrics.historical_heading'
  | 'metrics.vessel_position_heading'
  | 'metrics.total_label'
  | 'metrics.period_label'
  | 'metrics.location_label'
  | 'metrics.coordinates_label'
  | 'metrics.missing_ship'
  | 'metrics.clarification.options_intro'
  | 'metrics.clarification.options_reply'
  | 'metrics.clarification.selection_not_matched'
  | 'fallback.unknown_task'
  | 'fallback.unsupported_ship_task'
  | 'fallback.metrics.empty_plan'
  | 'fallback.metrics.group_not_confident'
  | 'fallback.metrics.exact_metric_not_found'
  | 'fallback.metrics.ambiguous_metrics'
  | 'fallback.metrics.generic';

export type AssistantCopyParams = Record<string, string | number>;

export type AssistantTextLanguage = string | null | undefined;
