import { ChatMessageEntity } from '../entities/chat-message.entity';
import { ChatConversationContext } from './chat-conversation-context.types';

export function formatConversationSummary(summary: string | null): string {
  return summary?.trim() || 'No persisted conversation summary yet.';
}

export function formatMessageTranscript(messages: ChatMessageEntity[]): string {
  const transcript = messages
    .filter((message) => !message.deletedAt)
    .map(
      (message) =>
        `${message.role.toUpperCase()}: ${message.content.trim() || '[empty]'}`,
    )
    .join('\n\n');

  return transcript || 'No recent messages.';
}

export function formatConversationContext(
  context: ChatConversationContext,
): string {
  return [
    'Conversation summary:',
    formatConversationSummary(context.summary),
    '',
    'Recent messages:',
    formatMessageTranscript(context.recentMessages),
  ].join('\n');
}
