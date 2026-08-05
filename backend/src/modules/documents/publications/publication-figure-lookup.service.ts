import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';

export interface CitedFigure {
  nodeId: string;
  title: string;
  /** The image file itself — the node's own document, never the AI document. */
  documentId: string;
}

/**
 * Finds the figures behind an answer.
 *
 * Rulebook figures live as image nodes whose text is a vision-written
 * description starting with "[Figure]". Retrieval sees only that description —
 * it is assembled into the AI document like any other node — so when a chunk
 * of it is cited, the answer is describing a drawing the user cannot see.
 * This maps the cited chunk text back to the node that owns the image, so the
 * chat can attach the drawing itself.
 *
 * Matching is by content, not by id: a chunk is a slice of assembled markdown
 * and carries no node identity. Each figure's description opens with prose
 * specific enough to be a fingerprint ("six different pipe joint
 * configurations (a through f)…"), so a normalized prefix of it appearing in
 * the chunk is the join. Two windows are tried — the opening and a second
 * slice further in — because the chunker is free to cut a description in half.
 */
@Injectable()
export class PublicationFigureLookupService {
  private readonly logger = new Logger(PublicationFigureLookupService.name);

  /** All figure fingerprints, small enough to keep warm (≈750 rows). */
  private cache: {
    at: number;
    rows: { nodeId: string; title: string; documentId: string; prints: string[] }[];
  } | null = null;

  private static readonly CACHE_MS = 5 * 60_000;
  private static readonly PRINT_CHARS = 90;
  private static readonly MAX_PER_ANSWER = 4;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async figuresInChunks(chunkTexts: string[]): Promise<CitedFigure[]> {
    const haystacks = chunkTexts
      .map((text) => normalize(text))
      .filter((text) => text.includes('[figure]'));
    if (!haystacks.length) {
      return [];
    }

    let rows: NonNullable<typeof this.cache>['rows'];
    try {
      rows = await this.loadFigures();
    } catch (error) {
      // Sources without their drawings are still sources.
      this.logger.warn(`Figure lookup failed: ${formatError(error)}`);
      return [];
    }

    const found: CitedFigure[] = [];
    const seen = new Set<string>();
    for (const haystack of haystacks) {
      for (const row of rows) {
        if (seen.has(row.nodeId)) continue;
        if (row.prints.some((print) => haystack.includes(print))) {
          seen.add(row.nodeId);
          found.push({
            nodeId: row.nodeId,
            title: row.title,
            documentId: row.documentId,
          });
          if (found.length >= PublicationFigureLookupService.MAX_PER_ANSWER) {
            return found;
          }
        }
      }
    }
    return found;
  }

  private async loadFigures() {
    const now = Date.now();
    if (this.cache && now - this.cache.at < PublicationFigureLookupService.CACHE_MS) {
      return this.cache.rows;
    }

    const raw: { id: string; title: string; documentId: string; head: string }[] =
      await this.dataSource.query(`
        SELECT id, title, document_id AS "documentId",
               left(content_text, 400) AS head
          FROM publication_nodes
         WHERE content_text LIKE '[Figure]%' AND document_id IS NOT NULL
      `);

    const rows = raw.map((row) => {
      const body = normalize(row.head).replace(/^\[figure\]\s*/, '');
      const prints = [
        body.slice(0, PublicationFigureLookupService.PRINT_CHARS),
        body.slice(120, 120 + PublicationFigureLookupService.PRINT_CHARS),
      ].filter((print) => print.length >= 40);
      return { nodeId: row.id, title: row.title, documentId: row.documentId, prints };
    });

    this.cache = { at: now, rows };
    return rows;
  }
}

/** Chunkers rewrap lines and markdown loses its hashes; letters survive. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[#*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
