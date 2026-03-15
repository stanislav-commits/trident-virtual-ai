import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';

const DEFAULT_RAGFLOW_CONTEXT_TOP_K = (() => {
  const parsed = Number.parseInt(process.env.RAGFLOW_CONTEXT_TOP_K ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
})();

const DEFAULT_RAGFLOW_CONTEXT_CANDIDATE_K = (() => {
  const parsed = Number.parseInt(
    process.env.RAGFLOW_CONTEXT_CANDIDATE_K ?? '',
    10,
  );
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Math.max(DEFAULT_RAGFLOW_CONTEXT_TOP_K * 3, 24);
})();

const DEFAULT_RAGFLOW_CONTEXT_SNIPPET_CHARS = (() => {
  const parsed = Number.parseInt(
    process.env.RAGFLOW_CONTEXT_SNIPPET_CHARS ?? '',
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 300) return 1200;
  return Math.min(parsed, 4000);
})();

interface RAGFlowSearchResult {
  id: string;
  doc_id: string;
  doc_name: string;
  content: string;
  similarity?: number;
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
    topK: number = DEFAULT_RAGFLOW_CONTEXT_TOP_K,
    candidateK: number = DEFAULT_RAGFLOW_CONTEXT_CANDIDATE_K,
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
      const retrievalK = Math.max(topK, candidateK);
      const snippetCharLimit = this.getSnippetCharLimit(query);

      // RAGFlow API call to search dataset
      const results = await this.ragflow.searchDataset(
        ship.ragflowDatasetId,
        query,
        retrievalK,
      );

      // Map RAGFlow results to citations with ShipManual references
      const citations = this.dedupeCitations(
        results
        .map((result: RAGFlowSearchResult) => {
          const manual = ship.manuals.find(
            (m) => m.ragflowDocumentId === result.doc_id,
          );

          const rawContent = result.content ?? '';
          const snippet =
            rawContent.length > snippetCharLimit
              ? rawContent.slice(0, snippetCharLimit)
              : rawContent;

          return {
            shipManualId: manual?.id,
            chunkId: result.id,
            score: result.similarity ?? undefined,
            snippet,
            sourceTitle: result.doc_name || manual?.filename || 'Document',
            pageNumber: (result.meta?.page_num as number) ?? undefined,
          };
        }),
      ).slice(0, retrievalK);

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
    topK: number = DEFAULT_RAGFLOW_CONTEXT_TOP_K,
    candidateK: number = DEFAULT_RAGFLOW_CONTEXT_CANDIDATE_K,
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
    const retrievalK = Math.max(topK, candidateK);
    const snippetCharLimit = this.getSnippetCharLimit(query);

    for (const ship of ships) {
      try {
        const results = await this.ragflow.searchDataset(
          ship.ragflowDatasetId!,
          query,
          retrievalK,
        );

        results.forEach((result: RAGFlowSearchResult) => {
          const manual = ship.manuals.find(
            (m) => m.ragflowDocumentId === result.doc_id,
          );

          const docName = result.doc_name || manual?.filename || 'Document';
          const rawContent = result.content ?? '';
          const snippet =
            rawContent.length > snippetCharLimit
              ? rawContent.slice(0, snippetCharLimit)
              : rawContent;

          allCitations.push({
            shipManualId: manual?.id,
            chunkId: result.id,
            score: result.similarity ?? undefined,
            snippet,
            sourceTitle: `${docName} (${ship.name})`,
            pageNumber: (result.meta?.page_num as number) ?? undefined,
          });
        });
      } catch {
        // Log and continue with next ship
      }
    }

    // Return top-k across all ships
    return this.dedupeCitations(allCitations)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, retrievalK);
  }

  private dedupeCitations(citations: ContextCitation[]): ContextCitation[] {
    const seen = new Set<string>();
    const deduped: ContextCitation[] = [];

    for (const citation of citations) {
      const chunkKey = citation.chunkId?.trim();
      if (chunkKey) {
        const key = `chunk:${chunkKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(citation);
        continue;
      }

      const normalizedSnippet = (citation.snippet ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const key = [
        citation.sourceTitle ?? '',
        citation.pageNumber ?? '',
        normalizedSnippet,
      ].join('|');

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(citation);
    }

    return deduped;
  }

  private getSnippetCharLimit(query: string): number {
    if (
      /\b(reference\s*id|1p\d{2,}|spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|next\s*due|last\s*due|component\s*name|task\s*name|interval|parts?|spares?|part\s*numbers?|consumables?)\b/i.test(
        query,
      )
    ) {
      return Math.max(DEFAULT_RAGFLOW_CONTEXT_SNIPPET_CHARS, 7000);
    }

    return DEFAULT_RAGFLOW_CONTEXT_SNIPPET_CHARS;
  }
}
