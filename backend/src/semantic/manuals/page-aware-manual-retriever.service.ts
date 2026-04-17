import { Injectable, Logger } from '@nestjs/common';
import type { ChatCitation } from '../../chat/chat.types';
import { PrismaService } from '../../prisma/prisma.service';
import { RagflowService } from '../../ragflow/ragflow.service';

type RagflowChunk = Awaited<
  ReturnType<RagflowService['listDocumentChunks']>
>[number];

interface ScoredPageChunk {
  chunk: RagflowChunk;
  pageNumber?: number;
  score: number;
}

@Injectable()
export class PageAwareManualRetrieverService {
  private readonly logger = new Logger(PageAwareManualRetrieverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
  ) {}

  async retrieveLockedManualPage(params: {
    manualId: string;
    retrievalQuery: string;
    pageHint?: number | null;
    sectionHint?: string | null;
    limit?: number;
  }): Promise<ChatCitation[]> {
    if (!this.ragflow.isConfigured()) {
      return [];
    }

    const manual = await this.prisma.shipManual.findUnique({
      where: { id: params.manualId },
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        category: true,
        ship: { select: { ragflowDatasetId: true } },
      },
    });
    if (!manual?.ship.ragflowDatasetId) {
      return [];
    }

    const chunks = await this.ragflow.listDocumentChunks(
      manual.ship.ragflowDatasetId,
      manual.ragflowDocumentId,
      300,
    );
    const scored = this.scoreChunks({
      chunks,
      retrievalQuery: params.retrievalQuery,
      pageHint: params.pageHint,
      sectionHint: params.sectionHint,
    });
    const citations = scored.slice(0, params.limit ?? 8).map((entry) => ({
      shipManualId: manual.id,
      chunkId: `page-aware:${manual.id}:${entry.chunk.id}`,
      score: entry.score,
      pageNumber: entry.pageNumber,
      snippet: this.buildSnippet(entry.chunk.content ?? ''),
      sourceTitle: manual.filename,
      sourceCategory: manual.category,
      sourceMetadataCategory: this.extractMetadataValue(
        entry.chunk,
        'category',
      ),
      sourceMetadataCategoryLabel: this.extractMetadataValue(
        entry.chunk,
        'category_label',
      ),
    }));

    if (citations.length > 0) {
      this.logger.debug(
        `Page-aware retrieval manual=${manual.id} page=${params.pageHint ?? 'none'} section="${params.sectionHint ?? ''}" selected=${citations.map((citation) => `${citation.chunkId}@${citation.pageNumber ?? 'na'}`).join(',')}`,
      );
    }

    return citations;
  }

  private scoreChunks(params: {
    chunks: RagflowChunk[];
    retrievalQuery: string;
    pageHint?: number | null;
    sectionHint?: string | null;
  }): ScoredPageChunk[] {
    const queryTokens = this.extractQueryTokens(params.retrievalQuery);
    const normalizedSectionHint = params.sectionHint
      ? this.normalizeText(params.sectionHint)
      : '';
    const pageHint = params.pageHint ?? null;
    let scoped = params.chunks.map((chunk) => ({
      chunk,
      pageNumber: this.extractChunkPageNumber(chunk),
    }));

    if (pageHint !== null) {
      const exactPage = scoped.filter((entry) => entry.pageNumber === pageHint);
      scoped =
        exactPage.length > 0
          ? exactPage
          : scoped.filter(
              (entry) =>
                entry.pageNumber !== undefined &&
                Math.abs(entry.pageNumber - pageHint) <= 1,
            );
    } else if (normalizedSectionHint) {
      scoped = scoped.filter((entry) =>
        this.normalizeText(entry.chunk.content ?? '').includes(
          normalizedSectionHint,
        ),
      );
    } else {
      return [];
    }

    return scoped
      .map((entry) => {
        const normalizedContent = this.normalizeText(entry.chunk.content ?? '');
        let score = 1;
        if (pageHint !== null && entry.pageNumber !== undefined) {
          score += Math.max(0, 10 - Math.abs(entry.pageNumber - pageHint) * 4);
        }
        if (
          normalizedSectionHint &&
          normalizedContent.includes(normalizedSectionHint)
        ) {
          score += 8;
        }
        score += queryTokens.filter((token) =>
          normalizedContent.includes(token),
        ).length;
        return { ...entry, score };
      })
      .filter((entry) => entry.chunk.content?.trim())
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.pageNumber !== undefined && right.pageNumber !== undefined) {
          return left.pageNumber - right.pageNumber;
        }
        return left.chunk.id.localeCompare(right.chunk.id);
      });
  }

  private extractQueryTokens(query: string): string[] {
    const stopWords = new Set([
      'what',
      'where',
      'when',
      'which',
      'show',
      'give',
      'tell',
      'about',
      'this',
      'that',
      'manual',
      'page',
      'section',
      'the',
      'and',
      'for',
      'from',
      'with',
      'into',
      'of',
      'to',
      'in',
      'on',
    ]);

    return [
      ...new Set(
        this.normalizeText(query)
          .split(' ')
          .filter((token) => token.length > 2 && !stopWords.has(token)),
      ),
    ];
  }

  private extractChunkPageNumber(chunk: RagflowChunk): number | undefined {
    const value = chunk.meta?.page_num;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private extractMetadataValue(
    chunk: Pick<RagflowChunk, 'meta'>,
    key: string,
  ): string | undefined {
    const value = chunk.meta?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private buildSnippet(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    return normalized.length <= 4000 ? normalized : normalized.slice(0, 4000);
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_:./\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
