import { Injectable } from '@nestjs/common';
import { SourceReferenceDto } from '../../common/dto/source-reference.dto';
import { RagService } from '../../integrations/rag/rag.service';
import { SearchDocumentsDto } from './dto/search-documents.dto';

@Injectable()
export class DocumentsService {
  constructor(private readonly ragService: RagService) {}

  async search(input: SearchDocumentsDto): Promise<{
    summary: string;
    data: Record<string, unknown>;
    references: SourceReferenceDto[];
  }> {
    return {
      summary:
        'Documentation search flow is connected to the module boundary. Semantic retrieval and citation extraction are the next implementation step.',
      data: {
        normalizedQuestion: input.question,
        shipId: input.shipId ?? null,
        category: input.category ?? null,
        rag: this.ragService.getStatus(),
      },
      references: [
        {
          source: 'documents',
          title: 'Documentation corpus',
          snippet: 'RAG retrieval is not implemented yet.',
        },
      ],
    };
  }
}
