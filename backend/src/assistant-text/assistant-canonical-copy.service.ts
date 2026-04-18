import { Injectable } from '@nestjs/common';
import {
  AssistantCopyKey,
  AssistantCopyParams,
} from './assistant-text.types';

type AssistantTemplateResolver = (params: AssistantCopyParams) => string;
type AssistantTemplateValue = string | AssistantTemplateResolver;

@Injectable()
export class AssistantCanonicalCopyService {
  private readonly catalog: Record<AssistantCopyKey, AssistantTemplateValue> = {
    'chat_history.no_previous_user_message':
      'There are no earlier messages from you in this chat yet.',
    'chat_history.no_previous_assistant_message':
      'There are no earlier assistant replies in this chat yet.',
    'chat_history.previous_user_message': ({ message }) =>
      `Your previous message was: "${message}".`,
    'chat_history.previous_assistant_message': ({ message }) =>
      `My previous reply was: "${message}".`,
    'chat_history.summary_empty':
      'There are no earlier messages in this chat to summarize yet.',
    'chat_history.clarification':
      'I understood this as a chat-history request, but I could not tell whether you wanted your previous message, my previous reply, or a short summary of this chat.',
    'metrics.current_heading': 'Current metrics:',
    'metrics.historical_heading': 'Historical metrics:',
    'metrics.vessel_position_heading': 'Current vessel position:',
    'metrics.total_label': 'Total',
    'metrics.period_label': 'Period',
    'metrics.location_label': 'Location',
    'metrics.coordinates_label': 'Coordinates',
    'metrics.missing_ship':
      'I understood this as a metrics request, but this chat is not attached to a specific ship. Select a vessel for new chats and start a new conversation.',
    'metrics.clarification.options_intro': 'I found these candidate metrics:',
    'metrics.clarification.options_reply':
      'Reply with the number or the name of the metric you want.',
    'metrics.clarification.selection_not_matched':
      'I could not match that selection to the saved options. Reply with the number or the name of the metric you want.',
    'fallback.unknown_task':
      'I understood this as a task, but I could not yet determine whether it should be answered from chat history, with web search, or as a ship-related request.',
    'fallback.unsupported_ship_task':
      'I understood this as a ship-related task, but the required ship-specific routing is not available yet.',
    'fallback.metrics.empty_plan':
      'I understood this as a metrics request, but I could not yet build a reliable retrieval plan for the metrics.',
    'fallback.metrics.group_not_confident':
      'I could not confidently determine which grouped metrics to use for this request.',
    'fallback.metrics.exact_metric_not_found':
      'I could not determine which exact metric matches this request.',
    'fallback.metrics.ambiguous_metrics':
      'I found several similar metrics that could match this request. Which one do you want?',
    'fallback.metrics.generic':
      'I need a small clarification to choose the correct metric.',
  };

  t(key: AssistantCopyKey, params: AssistantCopyParams = {}): string {
    const template = this.catalog[key];
    return typeof template === 'function' ? template(params) : template;
  }
}
