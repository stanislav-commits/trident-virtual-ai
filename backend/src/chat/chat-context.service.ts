import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';

interface RAGFlowSearchResult {
  id: string;
  doc_id: string;
  doc_name: string;
  content: string;
  meta?: Record<string, unknown>;
}

interface ContextCitation {
  shipManualId?: string;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
}

@Injectable()
export class ChatContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
  ) {}

  async findContextForQuery(
    shipId: string,
    query: string,
    topK: number = 5,
  ): Promise<{
    citations: ContextCitation[];
    ragflowRequestId?: string;
  }> {
    const ship = await this.prisma.ship.findUnique({
      where: { id: shipId },
      include: {
        manuals: {
          select: { id: true, ragflowDocumentId: true, filename: true },
        },
      },
    });

    if (!ship) throw new NotFoundException('Ship not found');

    if (!ship.ragflowDatasetId) {
      return { citations: [] };
    }

    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow service is not available');
    }

    try {
      // RAGFlow API call to search dataset
      const results = await this.ragflow.searchDataset(
        ship.ragflowDatasetId,
        query,
        topK,
      );

      // Map RAGFlow results to citations with ShipManual references
      const citations = results
        .slice(0, topK)
        .map((result: RAGFlowSearchResult) => {
          const manual = ship.manuals.find(
            (m) => m.ragflowDocumentId === result.doc_id,
          );

          return {
            shipManualId: manual?.id,
            chunkId: result.id,
            score: 0.85, // placeholder; RAGFlow may return scores
            snippet: result.content.substring(0, 300),
            sourceTitle: result.doc_name || manual?.filename,
            pageNumber: (result.meta?.page_num as number) ?? undefined,
          };
        });

      return {
        citations,
        ragflowRequestId: undefined,
      };
    } catch (err) {
      throw new ServiceUnavailableException(
        `Failed to search context: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findContextForAdminQuery(
    query: string,
    topK: number = 5,
  ): Promise<ContextCitation[]> {
    // Admin search across all ship datasets
    const ships = await this.prisma.ship.findMany({
      where: {
        ragflowDatasetId: { not: null },
      },
      include: {
        manuals: {
          select: { id: true, ragflowDocumentId: true, filename: true },
        },
      },
    });

    if (!ships.length) return [];

    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow service is not available');
    }

    const allCitations: ContextCitation[] = [];

    for (const ship of ships) {
      try {
        const results = await this.ragflow.searchDataset(
          ship.ragflowDatasetId!,
          query,
          topK,
        );

        results.slice(0, topK).forEach((result: RAGFlowSearchResult) => {
          const manual = ship.manuals.find(
            (m) => m.ragflowDocumentId === result.doc_id,
          );

          allCitations.push({
            shipManualId: manual?.id,
            chunkId: result.id,
            score: 0.85,
            snippet: result.content.substring(0, 300),
            sourceTitle:
              `${result.doc_name} (${ship.name})` || manual?.filename,
            pageNumber: (result.meta?.page_num as number) ?? undefined,
          });
        });
      } catch {
        // Log and continue with next ship
      }
    }

    // Return top-k across all ships
    return allCitations
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK);
  }
}
