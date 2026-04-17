import { ChatCitation } from '../../chat/chat.types';
import { ChatV2Language } from '../chat-v2.types';

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
    language: ChatV2Language;
  }): Promise<ChatV2WebSearchResult>;
}
