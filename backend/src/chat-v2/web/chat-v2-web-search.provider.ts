import { ChatCitation } from '../../chat-shared/chat.types';

export interface ChatV2WebSearchResult {
  content: string;
  responseId?: string;
  citations: ChatCitation[];
  webSearchQuery: string;
  sourceCount: number;
}

export abstract class ChatV2WebSearchProvider {
  abstract search(params: {
    query: string;
    originalUserQuery: string;
    language?: string | null;
  }): Promise<ChatV2WebSearchResult>;
}
