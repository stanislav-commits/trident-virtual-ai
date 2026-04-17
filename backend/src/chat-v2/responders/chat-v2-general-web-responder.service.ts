import { Inject, Injectable } from '@nestjs/common';
import { ChatV2Language } from '../chat-v2.types';
import { ChatV2TaskRoute } from '../routing/chat-v2-task-route.types';
import {
  ChatV2WebSearchProvider,
  ChatV2WebSearchResult,
} from '../web/chat-v2-web-search.provider';

@Injectable()
export class ChatV2GeneralWebResponderService {
  constructor(
    @Inject(ChatV2WebSearchProvider)
    private readonly webSearchProvider: ChatV2WebSearchProvider,
  ) {}

  respond(params: {
    route: ChatV2TaskRoute;
    userQuery: string;
    language: ChatV2Language;
  }): Promise<ChatV2WebSearchResult> {
    const { route, userQuery, language } = params;

    return this.webSearchProvider.search({
      query: route.webSearchQuery?.trim() || userQuery,
      originalUserQuery: userQuery,
      language,
    });
  }
}
