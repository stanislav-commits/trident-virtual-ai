import { Injectable } from '@nestjs/common';
import { SourceReferenceDto } from '../../common/dto/source-reference.dto';
import { WebSearchService } from '../../integrations/web-search/web-search.service';
import { WebSearchContextReference } from '../../integrations/web-search/web-search.types';
import { SearchWebDto } from './dto/search-web.dto';

@Injectable()
export class WebService {
  constructor(private readonly webSearchService: WebSearchService) {}

  async search(input: SearchWebDto): Promise<{
    summary: string;
    data: Record<string, unknown>;
    references: SourceReferenceDto[];
    contextReferences: WebSearchContextReference[];
  }> {
    const result = await this.webSearchService.search({
      question: input.question,
      locale: input.locale ?? undefined,
    });

    return {
      summary: result.answer,
      data: {
        normalizedQuestion: input.question,
        locale: input.locale ?? 'default',
        provider: result.provider,
        model: result.model,
        sourceCount: result.contextReferences.length,
      },
      references: result.references,
      contextReferences: result.contextReferences,
    };
  }
}
