import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../../../chat-llm.service';
import { ChatMessageEntity } from '../../../entities/chat-message.entity';
import { ChatSemanticDocumentsRoute } from '../../../routing/chat-semantic-router.types';
import { parseJsonObject } from '../../../planning/chat-turn-json.utils';
import { DocumentIntentPlan } from './document-intent-plan.types';
import { normalizeDocumentIntentPlan } from './document-intent-plan-normalizer';
import {
  buildDocumentIntentPlannerSystemPrompt,
  buildDocumentIntentPlannerUserPrompt,
} from './document-intent-planner-prompt';

export interface BuildDocumentIntentPlanInput {
  question: string;
  responseLanguage: string | null;
  documentsRoute: ChatSemanticDocumentsRoute;
  messages?: ChatMessageEntity[];
}

@Injectable()
export class DocumentIntentPlannerService {
  constructor(private readonly chatLlmService: ChatLlmService) {}

  async plan(input: BuildDocumentIntentPlanInput): Promise<DocumentIntentPlan | null> {
    let rawResult: string | null;

    try {
      rawResult = await this.chatLlmService.completeText({
        systemPrompt: buildDocumentIntentPlannerSystemPrompt(),
        userPrompt: buildDocumentIntentPlannerUserPrompt(input),
        temperature: 0,
        maxTokens: 900,
      });
    } catch {
      return null;
    }

    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    return normalizeDocumentIntentPlan(parsed);
  }
}
