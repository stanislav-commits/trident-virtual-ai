import { Injectable } from '@nestjs/common';
import { ExecutorResult } from '../interfaces/executor-result.interface';

@Injectable()
export class ChatHistoryExecutorService {
  async execute(query: string): Promise<ExecutorResult> {
    return {
      source: 'chat-history',
      summary:
        'Chat history executor is wired, but session persistence is not added yet. For now it only preserves the conversational channel as a valid planner target.',
      structuredData: {
        query,
        persistence: 'pending',
      },
      references: [
        {
          source: 'chat-history',
          title: 'Conversation memory',
          snippet: 'Persistence is not connected yet.',
        },
      ],
    };
  }
}
