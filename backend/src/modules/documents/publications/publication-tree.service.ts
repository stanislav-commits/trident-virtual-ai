import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import pdfParse from 'pdf-parse';
import { AuthenticatedUser } from '../../../core/auth/auth.types';
import { AdminEventBus } from '../../admin-events/admin-event.bus';
import { DocumentsService } from '../documents.service';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { UploadedDocumentFile } from '../ingestion/documents-upload.types';
import { DocumentEntity } from '../entities/document.entity';
import { PublicationNodeEntity } from '../entities/publication-node.entity';
import { PublicationShelfEntity } from '../entities/publication-shelf.entity';
import { VisionExtractionService } from '../extraction/vision-extraction.service';

/** Below this the extracted text is OCR debris — the Parse button appears. */
export const TEXT_QUALITY_FLOOR = 0.7;

/**
 * Whether attaching a scan queues the vision pass by itself.
 *
 * Set PUBLICATIONS_AUTO_PARSE=false while the library is being built: a load
 * attaches hundreds of scans at once and each would bill a vision pass for a
 * structure still being rearranged. Parse by hand keeps working either way.
 *
 * Read on each call, not once at module load — this file is imported while the
 * module graph is built, before ConfigModule has put .env into process.env, so
 * a constant here captured the default and the switch did nothing.
 */
function autoParseOnUpload(): boolean {
  return process.env.PUBLICATIONS_AUTO_PARSE !== 'false';
}

/**
 * An assembled AI document past this size parses slowly in RAGFlow and
 * dominates retrieval, so the default boundary walks DOWN the tree until the
 * subtree fits.
 */
const MAX_AI_DOCUMENT_BYTES = 1_400_000;

export interface PublicationNodeDto {
  id: string;
  parentId: string | null;
  category: string;
  nodeType: string;
  jurisdiction: string | null;
  number: string | null;
  title: string;
  sortOrder: number;
  hasContent: boolean;
  /** The file this row was built from, as the loader recorded it. It is how a
   *  row is matched back to its original when the file has to be attached. */
  sourceRef: string | null;
  documentId: string | null;
  fileName: string | null;
  isAiDocument: boolean;
  aiDocumentId: string | null;
  textQuality: number | null;
  parseState: string;
  childCount: number;
  /** Descendants that need parsing — drives the "Parse 12" button on a branch. */
  needsParsingCount: number;
  children?: PublicationNodeDto[];
}

/** One node of an imported subtree — text inline, children nested. */
export interface ImportNode {
  number?: string | null;
  title: string;
  contentText?: string | null;
  textQuality?: number | null;
  sourceRef?: string | null;
  children?: ImportNode[];
}

export interface RailCategoryDto {
  category: string;
  jurisdiction: string | null;
  total: number;
  types: Array<{ nodeType: string; count: number }>;
}

/**
 * The publications library as a tree. Everything the admin does — add a
 * section anywhere, add an article, move, rename, delete, mark the AI
 * document boundary, re-transcribe a scan — is an operation on nodes; the
 * markdown the AI reads is ASSEMBLED from them, never the other way round.
 */
/** ISO-3166 alpha-2 for the flags the library holds. Extend as shelves land. */
const FLAG_NAMES: Record<string, string> = {
  BS: 'Bahamas',
  BM: 'Bermuda',
  KY: 'Cayman Islands',
  GB: 'United Kingdom',
  GI: 'Gibraltar',
  IM: 'Isle of Man',
  MH: 'Marshall Islands',
  MT: 'Malta',
};

function jurisdictionLabel(jurisdiction: string, publications: string[]): string {
  if (jurisdiction.startsWith('flag:')) {
    const code = jurisdiction.slice(5).toUpperCase();
    return FLAG_NAMES[code] ?? code;
  }
  if (jurisdiction.startsWith('class:')) {
    // One society owns one publication, and its own name is the best label.
    return publications[0] ?? jurisdiction.slice(6);
  }
  return jurisdiction === 'eu' ? 'European Union' : jurisdiction;
}

@Injectable()
export class PublicationTreeService {
  private readonly logger = new Logger(PublicationTreeService.name);

  constructor(
    @InjectRepository(PublicationNodeEntity)
    private readonly nodeRepository: Repository<PublicationNodeEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(PublicationShelfEntity)
    private readonly shelfRepository: Repository<PublicationShelfEntity>,
    private readonly documentsService: DocumentsService,
    private readonly visionExtraction: VisionExtractionService,
    private readonly adminEvents: AdminEventBus,
  ) {}

  private emitChange(action: 'created' | 'updated' | 'deleted'): void {
    this.adminEvents.emit({ domain: 'publications', action, shipId: null });
  }

  // ── Reading ────────────────────────────────────────────────────────────

  /**
   * The review queue: rows whose extracted text the score doubts, newest
   * doubts first, each with its text and whether an original is there to
   * compare against.
   *
   * Checking 38 000 nodes by opening them one at a time is not a job anybody
   * will do; checking the 1 800 the score flagged is. What leaves the queue
   * leaves it by a person's decision — accepted, or re-read by vision.
   */
  async reviewQueue(
    limit = 50,
    offset = 0,
    publication?: string,
  ): Promise<{ total: number; nodes: Awaited<ReturnType<PublicationTreeService['content']>>[] }> {
    // The count takes no limit/offset, so it cannot share the parameter list:
    // Postgres rejects a statement handed parameters it does not reference.
    // A photo has no text at all — no text is the worst score there is, and
    // those rows are exactly the ones vision exists for. Requiring text kept
    // 1 170 image files out of the queue that was meant to catch them.
    const doubted = `n.parse_state IN ('needed', 'failed')
        AND (n.content_text IS NOT NULL OR n.document_id IS NOT NULL)`;
    const filter = publication ? `${doubted} AND n.category = $1` : doubted;

    const rows = (await this.nodeRepository.query(
      `SELECT n.id FROM publication_nodes n
        WHERE ${filter}
        -- What can be judged now comes first. A photograph has no text to read
        -- against its original, so it waits for vision rather than standing at
        -- the head of the queue.
        ORDER BY (n.content_text IS NULL), n.text_quality ASC NULLS FIRST,
                 n.category, n.sort_order
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      publication ? [publication] : [],
    )) as Array<{ id: string }>;
    const [{ count }] = (await this.nodeRepository.query(
      `SELECT COUNT(*)::int AS count FROM publication_nodes n WHERE ${filter}`,
      publication ? [publication] : [],
    )) as Array<{ count: number }>;

    const nodes = await Promise.all(rows.map((row) => this.content(row.id)));
    return { total: count, nodes };
  }

  /** A person has read the text beside the original and it is good enough. */
  async acceptText(id: string): Promise<PublicationNodeDto> {
    const node = await this.requireNode(id);
    node.parseState = 'accepted';
    const saved = await this.nodeRepository.save(node);
    this.emitChange('updated');
    return (await this.toDtos([saved]))[0];
  }

  /**
   * Every jurisdiction the library actually holds, with the publications that
   * belong to it. This is what a vessel picks from, so the choice can never
   * name a flag or a society the library has nothing for.
   */
  async jurisdictions(): Promise<
    Array<{
      jurisdiction: string;
      kind: 'flag' | 'class' | 'other';
      label: string;
      publications: string[];
    }>
  > {
    const rows = await this.shelfRepository
      .createQueryBuilder('s')
      .select('s.jurisdiction', 'jurisdiction')
      .addSelect('ARRAY_AGG(DISTINCT s.publication)', 'publications')
      .where('s.jurisdiction IS NOT NULL')
      .groupBy('s.jurisdiction')
      .orderBy('s.jurisdiction', 'ASC')
      .getRawMany<{ jurisdiction: string; publications: string[] }>();

    return rows.map((row) => {
      const publications = [...row.publications].sort();
      const kind = row.jurisdiction.startsWith('flag:')
        ? ('flag' as const)
        : row.jurisdiction.startsWith('class:')
          ? ('class' as const)
          : ('other' as const);
      return {
        jurisdiction: row.jurisdiction,
        kind,
        // The name of the flag or the society, not the shelves under it: three
        // publications hang on flag:GB — the UK's own laws, the CoSWP and the
        // Medical Guide — and listing them made the option read as if a
        // British-flagged yacht were a code of practice.
        label: jurisdictionLabel(row.jurisdiction, publications),
        publications,
      };
    });
  }

  /**
   * The rail: publications and their categories. Built from the SHELVES so a
   * publication can exist before anything is in it, then merged with whatever
   * categories the nodes actually carry (older loads, or a node moved into a
   * category nobody declared).
   */
  async rail(): Promise<RailCategoryDto[]> {
    const shelves = await this.shelfRepository.find({
      order: { sortOrder: 'ASC', publication: 'ASC', category: 'ASC' },
    });
    const counts = await this.nodeRepository
      .createQueryBuilder('n')
      .select('n.category', 'category')
      .addSelect('n.node_type', 'nodeType')
      .addSelect('MIN(n.jurisdiction)', 'jurisdiction')
      .addSelect('COUNT(*)', 'count')
      .where('n.parent_id IS NULL')
      .groupBy('n.category')
      .addGroupBy('n.node_type')
      .getRawMany<{
        category: string;
        nodeType: string;
        jurisdiction: string | null;
        count: string;
      }>();

    const byPublication = new Map<string, RailCategoryDto>();
    const ensure = (
      publication: string,
      jurisdiction: string | null,
    ): RailCategoryDto => {
      const entry = byPublication.get(publication) ?? {
        category: publication,
        jurisdiction,
        total: 0,
        types: [],
      };
      byPublication.set(publication, entry);
      return entry;
    };

    for (const shelf of shelves) {
      const entry = ensure(shelf.publication, shelf.jurisdiction);
      entry.types.push({ nodeType: shelf.category, count: 0 });
    }
    for (const row of counts) {
      const entry = ensure(row.category, row.jurisdiction);
      const count = Number(row.count);
      const known = entry.types.find((t) => t.nodeType === row.nodeType);
      if (known) known.count = count;
      else entry.types.push({ nodeType: row.nodeType, count });
      entry.total += count;
    }
    return [...byPublication.values()];
  }

  /** Create a publication (a rail shelf), optionally with its first category. */
  async createShelf(input: {
    publication: string;
    category?: string | null;
    jurisdiction?: string | null;
  }): Promise<RailCategoryDto[]> {
    const publication = input.publication?.trim();
    if (!publication) {
      throw new BadRequestException('The publication needs a name.');
    }
    const category = (input.category ?? '').trim() || 'General';
    const last = await this.shelfRepository.findOne({
      where: {},
      order: { sortOrder: 'DESC' },
    });
    const existing = await this.shelfRepository.findOne({
      where: { publication, category },
    });
    if (!existing) {
      await this.shelfRepository.save(
        this.shelfRepository.create({
          publication,
          category,
          jurisdiction: input.jurisdiction?.trim() || null,
          sortOrder: (last?.sortOrder ?? 0) + 1,
        }),
      );
      this.emitChange('created');
    }
    return this.rail();
  }

  /**
   * Remove a shelf. An empty one goes quietly; one that still holds documents
   * needs `withContents`, because deleting a category of a hundred regulations
   * one row at a time is not a workflow anybody would finish.
   */
  async removeShelf(
    publication: string,
    category: string,
    user: AuthenticatedUser,
    withContents = false,
  ): Promise<void> {
    const roots = await this.nodeRepository.find({
      where: { category: publication, nodeType: category, parentId: IsNull() },
      select: { id: true },
    });
    if (roots.length && !withContents) {
      throw new BadRequestException(
        `"${category}" still holds ${roots.length} publication(s) — move or delete them first.`,
      );
    }
    for (const root of roots) await this.removeNode(root.id, user);
    await this.shelfRepository.delete({ publication, category });
    this.emitChange('deleted');
  }

  /**
   * Rename a publication, or one of its categories.
   *
   * The name lives in two places — the shelves that draw the rail and the
   * `category` every node carries — so both move together or the publication
   * splits in two.
   */
  async renameShelf(input: {
    publication: string;
    category?: string | null;
    name: string;
  }): Promise<RailCategoryDto[]> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('The new name cannot be empty.');
    const { publication, category } = input;

    if (category) {
      await this.shelfRepository.update({ publication, category }, { category: name });
      await this.nodeRepository.update(
        { category: publication, nodeType: category },
        { nodeType: name },
      );
    } else {
      await this.shelfRepository.update({ publication }, { publication: name });
      await this.nodeRepository.update({ category: publication }, { category: name });
    }
    this.emitChange('updated');
    return this.rail();
  }

  /** Remove a whole publication — every category it has, and their contents. */
  async removePublication(
    publication: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const roots = await this.nodeRepository.find({
      where: { category: publication, parentId: IsNull() },
      select: { id: true },
    });
    for (const root of roots) await this.removeNode(root.id, user);
    await this.shelfRepository.delete({ publication });
    this.emitChange('deleted');
  }

  /** How much a shelf or a whole publication would take with it. */
  async shelfContents(
    publication: string,
    category?: string,
  ): Promise<{ documents: number; nodes: number }> {
    const where = category
      ? { category: publication, nodeType: category }
      : { category: publication };
    const [documents, nodes] = await Promise.all([
      this.nodeRepository.count({ where: { ...where, parentId: IsNull() } }),
      this.nodeRepository.count({ where }),
    ]);
    return { documents, nodes };
  }

  /**
   * The roots of one rail cell. Children are NOT included — a Lloyd's set
   * holds thousands of descendants and the tree expands lazily.
   */
  async roots(category: string, nodeType?: string): Promise<PublicationNodeDto[]> {
    const where: Record<string, unknown> = { category, parentId: IsNull() };
    if (nodeType) where.nodeType = nodeType;
    const nodes = await this.nodeRepository.find({
      where,
      relations: { document: true },
      order: { sortOrder: 'ASC', title: 'ASC' },
    });
    return this.toDtos(nodes);
  }

  /**
   * Every source file the shelf holds.
   *
   * The importer matches on (parent, number, title), so two files that parse
   * to the same pair merge into one node — quietly, with the run still
   * reporting success. Three chapters were lost that way before the loader
   * started checking its own work against this list.
   */
  async sourceRefs(category: string): Promise<string[]> {
    const rows = (await this.nodeRepository.query(
      `SELECT DISTINCT source_ref FROM publication_nodes
        WHERE category = $1 AND source_ref IS NOT NULL`,
      [category],
    )) as Array<{ source_ref: string }>;
    return rows.map((r) => r.source_ref);
  }

  /** Where the next root on this shelf goes. */
  private async nextRootSortOrder(category: string, nodeType: string): Promise<number> {
    const row = (await this.nodeRepository.query(
      `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
         FROM publication_nodes
        WHERE parent_id IS NULL AND category = $1 AND node_type = $2`,
      [category, nodeType],
    )) as Array<{ next: number }>;
    return Number(row[0]?.next ?? 0);
  }

  /** One level down — what an expanded branch shows. */
  async children(parentId: string): Promise<PublicationNodeDto[]> {
    const nodes = await this.nodeRepository.find({
      where: { parentId },
      relations: { document: true },
      order: { sortOrder: 'ASC', number: 'ASC', title: 'ASC' },
    });
    return this.toDtos(nodes);
  }

  /** Flat search across the library, with the path of each hit. */
  async search(
    query: string,
    limit = 50,
  ): Promise<Array<PublicationNodeDto & { path: string[] }>> {
    const term = query.trim();
    if (term.length < 2) return [];
    const nodes = await this.nodeRepository
      .createQueryBuilder('n')
      .leftJoinAndSelect('n.document', 'document')
      .where('n.title ILIKE :term OR n.number ILIKE :term', {
        term: `%${term}%`,
      })
      .orderBy('n.category', 'ASC')
      .addOrderBy('n.sort_order', 'ASC')
      .limit(Math.min(200, Math.max(1, limit)))
      .getMany();

    const dtos = await this.toDtos(nodes);
    return Promise.all(
      dtos.map(async (dto) => ({ ...dto, path: await this.pathOf(dto.id) })),
    );
  }

  /**
   * The nearest original: this row's own file, else the closest ancestor that
   * has one. RINA and BV were imported as text, so only the book at the top of
   * the tree carries a PDF — and a reviewer asked to check a section against
   * "no original uploaded" cannot check anything.
   */
  private async originalFor(node: PublicationNodeEntity): Promise<{
    originalDocumentId: string | null;
    originalFileName: string | null;
    originalIsInherited: boolean;
    /** The node that names the source file, and what it names — so a file can
     *  be attached where it belongs rather than to every section under it. */
    sourceOwnerId: string | null;
    sourceOwnerRef: string | null;
  }> {
    const owner = (await this.nodeRepository.query(
      `
      WITH RECURSIVE up AS (
        SELECT id, parent_id, source_ref, 0 AS depth
          FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id, n.source_ref, up.depth + 1
          FROM publication_nodes n JOIN up ON n.id = up.parent_id
      )
      SELECT id, source_ref FROM up
       WHERE source_ref IS NOT NULL ORDER BY depth ASC LIMIT 1
      `,
      [node.id],
    )) as Array<{ id: string; source_ref: string }>;
    const source = {
      sourceOwnerId: owner[0]?.id ?? null,
      sourceOwnerRef: owner[0]?.source_ref ?? null,
    };
    if (node.documentId) {
      return {
        originalDocumentId: node.documentId,
        originalFileName: node.document?.originalFileName ?? null,
        originalIsInherited: false,
        ...source,
      };
    }
    const [row] = (await this.nodeRepository.query(
      `
      WITH RECURSIVE up AS (
        SELECT id, parent_id, document_id, 0 AS depth
          FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id, n.document_id, up.depth + 1
          FROM publication_nodes n JOIN up ON n.id = up.parent_id
      )
      SELECT up.document_id, d.original_file_name
        FROM up JOIN documents d ON d.id = up.document_id
       WHERE up.document_id IS NOT NULL
       ORDER BY up.depth ASC LIMIT 1
      `,
      [node.id],
    )) as Array<{ document_id: string; original_file_name: string }>;
    return {
      originalDocumentId: row?.document_id ?? null,
      originalFileName: row?.original_file_name ?? null,
      originalIsInherited: Boolean(row),
      ...source,
    };
  }

  /** Breadcrumb from the root down to (excluding) this node. */
  private async pathOf(nodeId: string): Promise<string[]> {
    const path: string[] = [];
    let current = await this.nodeRepository.findOne({ where: { id: nodeId } });
    let guard = 0;
    while (current?.parentId && guard++ < 12) {
      const parent: PublicationNodeEntity | null =
        await this.nodeRepository.findOne({ where: { id: current.parentId } });
      if (!parent) break;
      path.unshift([parent.number, parent.title].filter(Boolean).join(' '));
      current = parent;
    }
    return path;
  }

  private async toDtos(
    nodes: PublicationNodeEntity[],
  ): Promise<PublicationNodeDto[]> {
    if (!nodes.length) return [];
    const ids = nodes.map((n) => n.id);
    const childCounts = await this.countChildren(ids);
    const parsingCounts = await this.countNeedsParsing(ids);
    return nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      category: n.category,
      nodeType: n.nodeType,
      jurisdiction: n.jurisdiction,
      number: n.number,
      title: n.title,
      sortOrder: n.sortOrder,
      hasContent: Boolean(n.contentText),
      sourceRef: n.sourceRef,
      documentId: n.documentId,
      fileName: n.document ? n.document.originalFileName : null,
      isAiDocument: n.isAiDocument,
      aiDocumentId: n.aiDocumentId,
      textQuality: n.textQuality != null ? Number(n.textQuality) : null,
      parseState: n.parseState,
      childCount: childCounts.get(n.id) ?? 0,
      needsParsingCount: parsingCounts.get(n.id) ?? 0,
    }));
  }

  private async countChildren(ids: string[]): Promise<Map<string, number>> {
    const rows = await this.nodeRepository
      .createQueryBuilder('n')
      .select('n.parent_id', 'parentId')
      .addSelect('COUNT(*)', 'count')
      .where('n.parent_id IN (:...ids)', { ids })
      .groupBy('n.parent_id')
      .getRawMany<{ parentId: string; count: string }>();
    return new Map(rows.map((r) => [r.parentId, Number(r.count)]));
  }

  /**
   * Descendants (at any depth) whose text is unusable. One recursive query
   * instead of walking the tree in JS — a Lloyd's Part has 200+ leaves.
   */
  private async countNeedsParsing(ids: string[]): Promise<Map<string, number>> {
    const rows = await this.nodeRepository.query(
      `
      WITH RECURSIVE sub AS (
        SELECT id AS root_id, id FROM publication_nodes WHERE id = ANY($1)
        UNION ALL
        SELECT sub.root_id, n.id
          FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
      )
      SELECT sub.root_id AS "rootId", COUNT(*) AS count
        FROM sub JOIN publication_nodes n ON n.id = sub.id
       WHERE n.parse_state = 'needed'
       GROUP BY sub.root_id
      `,
      [ids],
    );
    return new Map(
      (rows as Array<{ rootId: string; count: string }>).map((r) => [
        r.rootId,
        Number(r.count),
      ]),
    );
  }

  /**
   * What a node actually holds, for the preview panel. A leaf shows its own
   * text; a branch shows the first lines of what is under it, so opening a
   * chapter tells you what is inside without expanding every article.
   */
  async content(id: string): Promise<{
    id: string;
    number: string | null;
    title: string;
    textQuality: number | null;
    parseState: string;
    hasFile: boolean;
    documentId: string | null;
    fileName: string | null;
    /** Where the original came from in the import library, if not uploaded. */
    sourceRef: string | null;
    /** The file to read this row against. A section imported as text has none
     *  of its own, but the book it belongs to does — without it the review
     *  screen asks a person to check a text against nothing. */
    originalDocumentId: string | null;
    originalFileName: string | null;
    originalIsInherited: boolean;
    sourceOwnerId: string | null;
    sourceOwnerRef: string | null;
    /** Publication › category › every branch above this row. A title like
     *  "continued (3 of 4)" says nothing on its own. */
    path: string[];
    text: string;
    truncated: boolean;
  }> {
    const node = await this.nodeRepository.findOne({
      where: { id },
      relations: { document: true },
    });
    if (!node) throw new NotFoundException('Publication node not found');
    const DIGEST_LIMIT = 400_000;

    let text = node.contentText ?? '';
    if (!text) {
      const rows = (await this.nodeRepository.query(
        `
        WITH RECURSIVE sub AS (
          SELECT id, parent_id, number, title, content_text, sort_order, 0 AS depth
            FROM publication_nodes WHERE id = $1
          UNION ALL
          SELECT n.id, n.parent_id, n.number, n.title, n.content_text,
                 n.sort_order, sub.depth + 1
            FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
        )
        SELECT number, title, content_text, depth FROM sub
         WHERE depth > 0
         ORDER BY depth, sort_order
         LIMIT 400
        `,
        [id],
      )) as Array<{
        number: string | null;
        title: string;
        content_text: string | null;
        depth: number;
      }>;
      text = rows
        .map((row) => {
          const heading = [row.number, row.title].filter(Boolean).join(' ');
          const body = (row.content_text ?? '').trim();
          return `${'#'.repeat(Math.min(6, row.depth + 1))} ${heading}\n\n${body}`;
        })
        .join('\n\n');
    }

    // A leaf's own text is returned whole — it is one article, and cutting it
    // mid-clause is exactly what makes a regulation useless to read. Only the
    // assembled digest of a large branch is capped.
    const isOwnText = Boolean(node.contentText);
    const capped = isOwnText ? text : text.slice(0, DIGEST_LIMIT);
    return {
      id: node.id,
      number: node.number,
      title: node.title,
      textQuality: node.textQuality != null ? Number(node.textQuality) : null,
      parseState: node.parseState,
      hasFile: Boolean(node.documentId),
      documentId: node.documentId,
      fileName: node.document ? node.document.originalFileName : null,
      sourceRef: node.sourceRef,
      ...(await this.originalFor(node)),
      // Publication › category › the branches above: a row called
      // "continued (3 of 4)" names nothing on its own.
      path: [node.category, node.nodeType, ...(await this.pathOf(node.id))],
      text: capped,
      truncated: !isOwnText && text.length > DIGEST_LIMIT,
    };
  }

  // ── Writing ────────────────────────────────────────────────────────────

  /**
   * Add a node. With `parentId` it is a section/article inside that node;
   * without one it is a new publication on the rail cell named by
   * `category` + `nodeType`.
   */
  async createNode(input: {
    parentId?: string | null;
    category?: string;
    nodeType?: string;
    jurisdiction?: string | null;
    number?: string | null;
    title: string;
    /** Insert before this sibling; appended when absent. */
    beforeSiblingId?: string | null;
  }): Promise<PublicationNodeDto> {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('The node needs a title.');

    let parent: PublicationNodeEntity | null = null;
    if (input.parentId) {
      parent = await this.requireNode(input.parentId);
    } else if (!input.category) {
      throw new BadRequestException(
        'A publication needs a category (or a parent node).',
      );
    }

    const node = this.nodeRepository.create({
      parentId: parent?.id ?? null,
      category: parent?.category ?? input.category!,
      nodeType: parent?.nodeType ?? input.nodeType ?? 'other',
      jurisdiction: parent?.jurisdiction ?? input.jurisdiction ?? null,
      number: input.number?.trim() || null,
      title,
      sortOrder: await this.nextSortOrder(parent?.id ?? null, input.beforeSiblingId),
    });
    const saved = await this.nodeRepository.save(node);
    this.emitChange('created');
    return (await this.toDtos([saved]))[0];
  }

  /**
   * Where the new node lands. Inserting before a sibling shifts the ones
   * after it, so an article can go in the middle of an act rather than only
   * at the end.
   */
  private async nextSortOrder(
    parentId: string | null,
    beforeSiblingId?: string | null,
  ): Promise<number> {
    if (beforeSiblingId) {
      const sibling = await this.requireNode(beforeSiblingId);
      await this.nodeRepository
        .createQueryBuilder()
        .update(PublicationNodeEntity)
        .set({ sortOrder: () => '"sort_order" + 1' })
        .where(
          parentId
            ? 'parent_id = :parentId AND sort_order >= :from'
            : 'parent_id IS NULL AND sort_order >= :from',
          { parentId, from: sibling.sortOrder },
        )
        .execute();
      return sibling.sortOrder;
    }
    const last = await this.nodeRepository.findOne({
      where: parentId ? { parentId } : { parentId: IsNull() },
      order: { sortOrder: 'DESC' },
    });
    return (last?.sortOrder ?? 0) + 1;
  }

  async updateNode(
    id: string,
    input: {
      number?: string | null;
      title?: string;
      nodeType?: string;
      contentText?: string;
    },
    user: AuthenticatedUser,
  ): Promise<PublicationNodeDto> {
    const node = await this.requireNode(id);
    const headingBefore = [node.number, node.title].filter(Boolean).join(' ');
    if (input.number !== undefined) node.number = input.number?.trim() || null;
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new BadRequestException('The node needs a title.');
      node.title = title;
    }
    if (input.nodeType !== undefined) node.nodeType = input.nodeType;
    // Text edited by hand is text a person has read: it leaves the review
    // queue and carries the score its own content earns.
    const textChanged =
      input.contentText !== undefined && input.contentText !== node.contentText;
    if (textChanged) {
      node.contentText = input.contentText ?? null;
      node.textQuality = String(textQuality(node.contentText ?? ''));
      node.parseState = 'accepted';
    }
    const saved = await this.nodeRepository.save(node);
    // Number and title become headings inside the assembled AI document, so a
    // rename leaves retrieval citing the old name until the document is built
    // again. Only the heading matters here — nodeType never reaches the text.
    if (
      textChanged ||
      [saved.number, saved.title].filter(Boolean).join(' ') !== headingBefore
    ) {
      await this.rebuildAiDocumentFor(saved, user);
    }
    this.emitChange('updated');
    return (await this.toDtos([saved]))[0];
  }

  /** Re-parent and/or re-order. Refuses to move a node inside itself. */
  async moveNode(
    id: string,
    input: { parentId?: string | null; beforeSiblingId?: string | null },
  ): Promise<PublicationNodeDto> {
    const node = await this.requireNode(id);
    const nextParentId =
      input.parentId === undefined ? node.parentId : input.parentId;

    if (nextParentId) {
      if (nextParentId === id) {
        throw new BadRequestException('A node cannot be its own parent.');
      }
      const ancestors = await this.ancestorIds(nextParentId);
      if (ancestors.includes(id)) {
        throw new BadRequestException(
          'That would move the node inside one of its own descendants.',
        );
      }
      const parent = await this.requireNode(nextParentId);
      // The rail cell is decided by the root — a moved subtree follows it.
      node.category = parent.category;
      node.nodeType = parent.nodeType;
      node.jurisdiction = parent.jurisdiction;
      await this.retagSubtree(id, parent.category, parent.nodeType, parent.jurisdiction);
    }
    node.parentId = nextParentId;
    node.sortOrder = await this.nextSortOrder(nextParentId, input.beforeSiblingId);
    const saved = await this.nodeRepository.save(node);
    this.emitChange('updated');
    return (await this.toDtos([saved]))[0];
  }

  private async ancestorIds(nodeId: string): Promise<string[]> {
    const rows = await this.nodeRepository.query(
      `
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id
          FROM publication_nodes n JOIN up ON up.parent_id = n.id
      )
      SELECT id FROM up
      `,
      [nodeId],
    );
    return (rows as Array<{ id: string }>).map((r) => r.id);
  }

  private async retagSubtree(
    rootId: string,
    category: string,
    nodeType: string,
    jurisdiction: string | null,
  ): Promise<void> {
    await this.nodeRepository.query(
      `
      WITH RECURSIVE sub AS (
        SELECT id FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
      )
      UPDATE publication_nodes
         SET category = $2, node_type = $3, jurisdiction = $4
       WHERE id IN (SELECT id FROM sub)
      `,
      [rootId, category, nodeType, jurisdiction],
    );
  }

  /** Delete a node and everything under it (FK cascade). */
  async removeNode(id: string, user: AuthenticatedUser): Promise<void> {
    const node = await this.requireNode(id);
    const docIds = await this.nodeRepository.query(
      `
      WITH RECURSIVE sub AS (
        SELECT id, document_id, ai_document_id FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.document_id, n.ai_document_id
          FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
      )
      SELECT document_id AS "documentId", ai_document_id AS "aiDocumentId" FROM sub
      `,
      [id],
    );
    await this.nodeRepository.delete({ id: node.id });
    for (const row of docIds as Array<{
      documentId: string | null;
      aiDocumentId: string | null;
    }>) {
      for (const docId of [row.documentId, row.aiDocumentId]) {
        if (docId) await this.safeDeleteDocument(docId, user);
      }
    }
    this.emitChange('deleted');
  }

  /**
   * Attach content to a node. A PDF is read for its text (which is what the
   * AI document is built from) AND kept as the original for viewing; .md and
   * .txt land as text directly.
   */
  async attachContent(
    id: string,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<PublicationNodeDto> {
    const node = await this.requireNode(id);
    if (!file?.buffer?.length) {
      throw new BadRequestException('The file is empty.');
    }
    const name = (file.originalname ?? '').toLowerCase();
    const isPdf = name.endsWith('.pdf') || file.mimetype === 'application/pdf';
    const isText =
      /\.(md|txt|markdown)$/.test(name) ||
      (file.mimetype ?? '').startsWith('text/');

    // Anything that is neither a PDF nor text is a figure — a diagram or a
    // scanned table. Reading its bytes as UTF-8 put raw PNG into content_text
    // and Postgres rejected the NUL bytes; it has no text until Parse reads
    // the picture.
    const extracted = isPdf
      ? ((await pdfParse(file.buffer)).text ?? '').trim()
      : isText
        ? file.buffer.toString('utf8').trim()
        : '';
    const quality = textQuality(extracted);
    node.textQuality = String(quality);
    node.parseState = quality < TEXT_QUALITY_FLOOR ? 'needed' : 'none';
    // Markdown for clean text; a scan keeps its raw layer for Parse to replace.
    node.contentText =
      (quality >= TEXT_QUALITY_FLOOR
        ? toMarkdown(extracted)
        : stripNulls(extracted)) || null;

    // Keep the original: a form IS the file, and a cited article should open
    // the paper the crew signs, not a text rendering of it.
    if (node.documentId) {
      await this.safeDeleteDocument(node.documentId, user);
      node.documentId = null;
    }
    const document = await this.documentsService.uploadPublication(
      {
        docClass: DocumentDocClass.PUBLICATION,
        // Whose rules these are, so retrieval can hand a vessel only the
        // shelves she sails under.
        jurisdiction: node.jurisdiction ?? undefined,
      },
      { ...file, originalname: file.originalname ?? `${node.title}.pdf` },
      user,
    );
    node.documentId = document.id;

    const saved = await this.nodeRepository.save(node);

    // A clean PDF is already markdown by now. A scan is not, and making the
    // operator notice a badge and press Parse for something the system can
    // see for itself is busywork — queue the vision pass on upload.
    //
    // Off while the library is being built: loading a publication attaches
    // hundreds of scans in a burst, and every one of them would bill a vision
    // pass for a structure that is still being rearranged. The badge still
    // shows what needs it, and Parse still works by hand.
    if (autoParseOnUpload() && saved.parseState === 'needed' && saved.documentId) {
      try {
        await this.parse(saved.id);
      } catch (error) {
        this.logger.warn(
          `Auto-parse for node ${saved.id} could not start: ${String(error)}`,
        );
      }
    }

    await this.rebuildAiDocumentFor(saved, user);
    this.emitChange('updated');
    return (await this.toDtos([saved]))[0];
  }

  // ── Bulk import ────────────────────────────────────────────────────────

  /**
   * Insert a subtree in one pass — how the Regs4Ships library lands (9 662
   * files). Text comes inline; originals are attached separately, so a whole
   * Lloyd's Part imports in one request instead of 227 uploads.
   *
   * Idempotent per (parent, number, title): re-running an import updates the
   * text of nodes that already exist instead of duplicating them.
   */
  async importSubtree(input: {
    parentId?: string | null;
    category?: string;
    nodeType?: string;
    jurisdiction?: string | null;
    nodes: ImportNode[];
  }): Promise<{ created: number; updated: number; rootIds: string[] }> {
    let parent: PublicationNodeEntity | null = null;
    if (input.parentId) parent = await this.requireNode(input.parentId);
    const category = parent?.category ?? input.category;
    if (!category) {
      throw new BadRequestException('Import needs a category or a parent node.');
    }
    const nodeType = parent?.nodeType ?? input.nodeType ?? 'other';
    const jurisdiction = parent?.jurisdiction ?? input.jurisdiction ?? null;

    const stats = { created: 0, updated: 0 };
    const rootIds: string[] = [];

    const insertLevel = async (
      nodes: ImportNode[],
      parentId: string | null,
    ): Promise<string[]> => {
      const ids: string[] = [];
      // A publication arrives one document per request, so numbering from zero
      // every time gave every root sort_order 0 and the shelf fell back to
      // alphabetical — MARPOL Annex I read 23, 2, 44, 47. Continue from what
      // the shelf already holds so the order the importer sends is the order
      // the shelf keeps.
      let order = parentId ? 0 : await this.nextRootSortOrder(category, nodeType);
      for (const raw of nodes) {
        const title = (raw.title ?? '').trim();
        if (!title) continue;
        const number = raw.number?.trim() || null;
        // Scoping by parent alone is not enough at the top level, where every
        // root shares parentId = null: MARPOL gives each annex its own
        // "Regulation 1 — Definitions", and four of them merged into one node
        // across annexes. Category and type are what separate them.
        const existing = await this.nodeRepository.findOne({
          where: {
            parentId: parentId ?? IsNull(),
            title,
            // An absent number has to mean "no number", not "any number".
            // Skipping the condition let a numberless node match the sibling
            // that HAS one — "Scope" found "Section 1 Scope" and was merged
            // into it, ten files at a time.
            number: number ?? IsNull(),
            ...(parentId ? {} : { category, nodeType }),
          },
        });
        const rawText = raw.contentText?.trim() || null;
        const quality =
          raw.textQuality != null
            ? raw.textQuality
            : rawText
              ? textQuality(rawText)
              : null;
        // Clean text becomes markdown; a scan stays as-is until Parse rewrites it.
        const text =
          rawText && (quality == null || quality >= TEXT_QUALITY_FLOOR)
            ? toMarkdown(rawText)
            : rawText ? stripNulls(rawText) : null;
        const node =
          existing ??
          this.nodeRepository.create({
            parentId,
            category,
            nodeType,
            jurisdiction,
            number,
            title,
          });
        node.sortOrder = order++;
        node.contentText = text;
        node.sourceRef = raw.sourceRef ?? node.sourceRef ?? null;
        node.textQuality = quality != null ? String(quality) : null;
        node.parseState =
          quality != null && quality < TEXT_QUALITY_FLOOR
            ? node.parseState === 'parsed'
              ? 'parsed'
              : 'needed'
            : node.parseState === 'parsed'
              ? 'parsed'
              : 'none';
        const saved = await this.nodeRepository.save(node);
        if (existing) stats.updated++;
        else stats.created++;
        ids.push(saved.id);
        if (raw.children?.length) await insertLevel(raw.children, saved.id);
      }
      return ids;
    };

    rootIds.push(...(await insertLevel(input.nodes, parent?.id ?? null)));
    this.emitChange('created');
    return { ...stats, rootIds };
  }

  /**
   * Nodes whose text is unusable and whose original was never uploaded — the
   * import brings text only, so Parse has nothing to read until the source
   * file is attached. The loader walks this list to fill the gap.
   */
  async pendingOriginals(
    limit = 500,
  ): Promise<Array<{ id: string; title: string; sourceRef: string | null }>> {
    const nodes = await this.nodeRepository.find({
      where: { parseState: 'needed', documentId: IsNull() },
      take: Math.min(2000, Math.max(1, limit)),
    });
    return nodes.map((n) => ({
      id: n.id,
      title: n.title,
      sourceRef: n.sourceRef,
    }));
  }

  // ── Parse (vision re-transcription) ────────────────────────────────────

  /**
   * Re-read a scan properly: the same per-page gpt-4o pipeline the equipment
   * manuals use, pointed at this node's original file. Only worth spending on
   * nodes whose extracted text is unusable — a clean text PDF is already
   * markdown by the time it lands here.
   *
   * Runs in the background queue; the node sits in `parsing` and the result
   * is collected by `collectParsed`, which the tree polls.
   */
  async parse(id: string): Promise<{ queued: number; skipped: string[] }> {
    const node = await this.requireNode(id);
    const targets = await this.parseTargets(node);
    const skipped: string[] = [];
    let queued = 0;

    for (const target of targets) {
      if (!target.documentId) {
        skipped.push(`${target.title}: no original file to read`);
        continue;
      }
      const document = await this.documentRepository.findOne({
        where: { id: target.documentId },
      });
      if (!document) {
        skipped.push(`${target.title}: original missing from the store`);
        continue;
      }
      document.extractionStatus = 'pending';
      await this.documentRepository.save(document);
      this.visionExtraction.queue(document.id);
      target.parseState = 'parsing';
      await this.nodeRepository.save(target);
      queued += 1;
    }
    if (queued) this.emitChange('updated');
    return { queued, skipped };
  }

  /**
   * This node when it holds a file, else every descendant that needs reading.
   *
   * It used to answer only for nodes the text-quality score had already
   * condemned, so a page that scored above the floor but came out scrambled
   * could not be re-read at all. The score is a heuristic; the operator looking
   * at the page is not.
   */
  private async parseTargets(
    node: PublicationNodeEntity,
  ): Promise<PublicationNodeEntity[]> {
    if (node.documentId) {
      return [node];
    }
    const rows = (await this.nodeRepository.query(
      `
      WITH RECURSIVE sub AS (
        SELECT id FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
      )
      SELECT n.id FROM sub JOIN publication_nodes n ON n.id = sub.id
       WHERE n.parse_state IN ('needed', 'failed')
      `,
      [node.id],
    )) as Array<{ id: string }>;
    if (!rows.length) return [];
    return this.nodeRepository.findByIds(rows.map((r) => r.id));
  }

  /**
   * Pull finished vision output into the nodes waiting on it. Called when the
   * tree is read, so a node flips to "Parsed by AI" without a job scheduler.
   */
  async collectParsed(user: AuthenticatedUser): Promise<number> {
    const waiting = await this.nodeRepository.find({
      where: { parseState: 'parsing' },
      relations: { document: true },
    });
    let collected = 0;
    for (const node of waiting) {
      const document = node.document;
      if (!document) {
        node.parseState = 'failed';
        await this.nodeRepository.save(node);
        continue;
      }
      if (document.extractionStatus === 'failed') {
        node.parseState = 'failed';
        await this.nodeRepository.save(node);
        continue;
      }
      if (document.extractionStatus !== 'done') continue;

      try {
        const markdown = await this.visionExtraction.readExtractedMarkdown(
          document,
        );
        if (markdown.trim()) {
          node.contentText = markdown.trim();
          node.textQuality = String(textQuality(markdown));
          node.parseState = 'parsed';
          collected += 1;
        } else {
          node.parseState = 'failed';
        }
      } catch (error) {
        this.logger.error(
          `Collecting parsed text for node ${node.id} failed: ${String(error)}`,
        );
        node.parseState = 'failed';
      }
      await this.nodeRepository.save(node);
      await this.rebuildAiDocumentFor(node, user);
    }
    if (collected) this.emitChange('updated');
    return collected;
  }

  // ── AI document boundary ───────────────────────────────────────────────

  /** Mark (or unmark) this node as the unit the AI index holds. */
  async setAiDocument(
    id: string,
    isAiDocument: boolean,
    user: AuthenticatedUser,
  ): Promise<PublicationNodeDto> {
    const node = await this.requireNode(id);
    node.isAiDocument = isAiDocument;
    if (!isAiDocument && node.aiDocumentId) {
      await this.safeDeleteDocument(node.aiDocumentId, user);
      node.aiDocumentId = null;
    }
    const saved = await this.nodeRepository.save(node);
    if (isAiDocument) await this.assembleAiDocument(saved, user);
    this.emitChange('updated');
    return (await this.toDtos([saved]))[0];
  }

  /**
   * Assemble this node's subtree into one markdown document and put it in the
   * store (replacing the previous assembly), so retrieval reads a chapter-
   * sized whole rather than 9 662 fragments.
   */
  async assembleAiDocument(
    node: PublicationNodeEntity,
    user: AuthenticatedUser,
  ): Promise<void> {
    const rows = (await this.nodeRepository.query(
      `
      WITH RECURSIVE sub AS (
        SELECT id, parent_id, number, title, content_text, source_ref,
               sort_order, 0 AS depth
          FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id, n.number, n.title, n.content_text, n.source_ref,
               n.sort_order, sub.depth + 1
          FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
      )
      SELECT * FROM sub ORDER BY depth, sort_order
      `,
      [node.id],
    )) as Array<{
      id: string;
      number: string | null;
      title: string;
      content_text: string | null;
      source_ref: string | null;
      depth: number;
    }>;

    const lines = [`# ${[node.number, node.title].filter(Boolean).join(' ')}`, ''];
    if (node.sourceRef) lines.push(sourceLine(node.sourceRef), '');
    for (const row of rows) {
      // The owner's own heading is already the title above — but its text is
      // not. A leaf marked as the AI document (a whole Act, a circular, an
      // IACS requirement) carries everything it has in content_text and has no
      // children at all, and skipping the row wholesale published 3 067
      // documents that were nothing but a title (2026-08-05).
      if (row.depth === 0) {
        if (row.content_text) lines.push(row.content_text.trim(), '');
        continue;
      }
      const heading = [row.number, row.title].filter(Boolean).join(' ');
      lines.push(`${'#'.repeat(Math.min(6, row.depth + 1))} ${heading}`, '');
      // The source file name is often the only place an amendment's adopting
      // resolution appears — "… (MSC.577(110)).pdf" — while the text itself
      // says nothing about which revision it is. Keep it beside the heading so
      // it survives chunking and reaches the model with the requirement.
      if (row.source_ref) lines.push(sourceLine(row.source_ref), '');
      if (row.content_text) lines.push(row.content_text.trim(), '');
    }
    const body = Buffer.from(lines.join('\n'), 'utf8');

    if (node.aiDocumentId) {
      await this.safeDeleteDocument(node.aiDocumentId, user);
      node.aiDocumentId = null;
    }
    const document = await this.documentsService.uploadPublication(
      {
        docClass: DocumentDocClass.PUBLICATION,
        // Whose rules these are, so retrieval can hand a vessel only the
        // shelves she sails under.
        jurisdiction: node.jurisdiction ?? undefined,
      },
      {
        buffer: body,
        originalname: aiDocumentFileName(node.number, node.title),
        mimetype: 'text/markdown',
        size: body.length,
      },
      user,
    );
    node.aiDocumentId = document.id;
    await this.nodeRepository.save(node);
  }

  /** After content changes, refresh the AI document this node belongs to. */
  private async rebuildAiDocumentFor(
    node: PublicationNodeEntity,
    user: AuthenticatedUser,
  ): Promise<void> {
    const owner = await this.aiDocumentAncestor(node.id);
    if (!owner) return;
    try {
      await this.assembleAiDocument(owner, user);
    } catch (error) {
      this.logger.error(
        `Reassembling AI document ${owner.id} failed: ${String(error)}`,
      );
    }
  }

  /** The nearest ancestor (or self) flagged as the AI document. */
  private async aiDocumentAncestor(
    nodeId: string,
  ): Promise<PublicationNodeEntity | null> {
    const ids = await this.ancestorIds(nodeId);
    if (!ids.length) return null;
    const nodes = await this.nodeRepository.findByIds(ids);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const id of ids) {
      const candidate = byId.get(id);
      if (candidate?.isAiDocument) return candidate;
    }
    return null;
  }

  /**
   * Default boundary for a freshly imported root: walk down while the subtree
   * is too big to be one document, and flag the largest nodes that fit.
   */
  async autoMarkAiDocuments(rootId: string): Promise<number> {
    const sizes = (await this.nodeRepository.query(
      `
      WITH RECURSIVE sub AS (
        SELECT id, parent_id FROM publication_nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id FROM publication_nodes n JOIN sub ON n.parent_id = sub.id
      ),
      sized AS (
        SELECT s.id, s.parent_id,
               (SELECT COALESCE(SUM(LENGTH(COALESCE(d.content_text, ''))), 0)
                  FROM publication_nodes d
                 WHERE d.id = s.id
                    OR d.parent_id = s.id
                    OR d.parent_id IN (SELECT id FROM publication_nodes WHERE parent_id = s.id)
               ) AS bytes
          FROM sub s
      )
      SELECT id, parent_id AS "parentId", bytes FROM sized
      `,
      [rootId],
    )) as Array<{ id: string; parentId: string | null; bytes: string }>;

    const byId = new Map(sizes.map((s) => [s.id, Number(s.bytes)]));
    const childrenOf = new Map<string, string[]>();
    for (const s of sizes) {
      if (!s.parentId) continue;
      childrenOf.set(s.parentId, [...(childrenOf.get(s.parentId) ?? []), s.id]);
    }

    const marked: string[] = [];
    const walk = (id: string): void => {
      const size = byId.get(id) ?? 0;
      const kids = childrenOf.get(id) ?? [];
      if (size <= MAX_AI_DOCUMENT_BYTES || !kids.length) {
        marked.push(id);
        return;
      }
      for (const kid of kids) walk(kid);
    };
    walk(rootId);

    if (marked.length) {
      await this.nodeRepository
        .createQueryBuilder()
        .update(PublicationNodeEntity)
        .set({ isAiDocument: true })
        .whereInIds(marked)
        .execute();
    }
    return marked.length;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async requireNode(id: string): Promise<PublicationNodeEntity> {
    const node = await this.nodeRepository.findOne({ where: { id } });
    if (!node) throw new NotFoundException('Publication node not found');
    return node;
  }

  private async safeDeleteDocument(
    documentId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    try {
      await this.documentsService.delete(documentId, user);
    } catch (error) {
      this.logger.warn(
        `Could not delete publication document ${documentId}: ${String(error)}`,
      );
    }
  }
}

/**
 * Postgres rejects NUL bytes in text outright ("invalid byte sequence for
 * encoding UTF8: 0x00") — some PDF text layers carry them, so every string
 * that reaches content_text goes through here.
 */
function stripNulls(text: string): string {
  return text.split('\u0000').join('');
}

/** Provenance line placed under a heading in the assembled AI document. */
function sourceLine(sourceRef: string): string {
  return `_Source: ${sourceRef.replace(/\.(pdf|md|txt|png|gif|docx?)$/i, '')}_`;
}

/**
 * File name for an assembled AI document.
 *
 * RAGFlow rejects anything over 255 bytes outright, and a Lloyd's Register
 * heading restored to its full form — book, then procedure, then section —
 * runs past that on its own (2026-08-05). The name is only a label: the same
 * heading opens the document, so trimming the middle costs nothing and keeps
 * both ends, which is where the book and the section live.
 */
const AI_DOCUMENT_NAME_BYTES = 200;

export function aiDocumentFileName(
  number: string | null,
  title: string,
): string {
  const full = [number, title].filter(Boolean).join(' ');
  if (Buffer.byteLength(`${full}.md`, 'utf8') <= AI_DOCUMENT_NAME_BYTES) {
    return `${full}.md`;
  }
  let head = full;
  while (Buffer.byteLength(`${head}.md`, 'utf8') > AI_DOCUMENT_NAME_BYTES) {
    head = head.slice(0, -1);
  }
  // Cut on a word so the tail reads as a name rather than a truncation.
  const keepTail = 60;
  const start = head.slice(0, head.length - keepTail).replace(/\s+\S*$/, '');
  const end = full.slice(-keepTail).replace(/^\S*\s+/, '');
  return `${start} … ${end}.md`;
}

/**
 * Raw pdftotext output → markdown.
 *
 * A text-layer PDF (SOLAS, a Malta act) extracts as fixed-width layout: hard
 * wraps mid-sentence, page furniture between paragraphs, headings indented
 * rather than marked. Left alone it reads badly for a human AND chunks badly
 * for retrieval, because a chunk boundary can land mid-sentence. This is a
 * deterministic cleanup — no model involved, so it costs nothing and runs on
 * every import. Scans are NOT put through it: their text is unreliable and the
 * Parse button rewrites them wholesale.
 */
export function toMarkdown(raw: string): string {
  const lines = stripNulls(raw).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (!paragraph.length) return;
    out.push(paragraph.join(' ').replace(/\s{2,}/g, ' ').trim());
    out.push('');
    paragraph = [];
  };

  for (const line of lines) {
    const text = line.replace(/\s+$/, '');
    const trimmed = text.trim();

    // Page furniture: a bare page number, or "Page 12 of 40".
    if (/^\(?\d{1,4}\)?$/.test(trimmed) || /^page\s+\d+(\s+of\s+\d+)?$/i.test(trimmed)) {
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }

    // Numbered structure ("Regulation 4", "PART I", "CHAPTER V", "Annex 2")
    // becomes a heading; short ALL-CAPS lines are headings too.
    const structural = /^(part|chapter|annex|appendix|section|regulation|article)\s+[0-9IVXLC]/i.test(
      trimmed,
    );
    const shouty =
      trimmed.length <= 70 &&
      /^[A-Z0-9][A-Z0-9 ,.'’\-—/()&]*$/.test(trimmed) &&
      /[A-Z]{3}/.test(trimmed);
    if (structural || shouty) {
      flush();
      out.push(`### ${trimmed.replace(/\s{2,}/g, ' ')}`, '');
      continue;
    }

    // A numbered clause starts its own paragraph rather than joining the last.
    if (/^(\d+(\.\d+)*|\.\d+|\([a-z0-9]+\))[\s.)]/i.test(trimmed)) {
      flush();
    }
    paragraph.push(trimmed);
  }
  flush();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 0..1 — how much this text looks like language rather than OCR debris.
 * Mirrors the import-side scorer so a file re-attached through the UI is
 * judged the same way as one that came through the bulk import.
 */
export function textQuality(text: string): number {
  const sample = text.slice(0, 20000);
  if (sample.trim().length < 40) return 0;
  const words = sample.match(/[A-Za-z]{2,}/g);
  if (!words?.length) return 0;
  const letters = (sample.match(/[A-Za-z]/g) ?? []).length;
  const weird = (sample.match(/[^\x20-\x7E\n\r\t\u00A0-\u024F\u2010-\u2027\u20AC\u00A3\u00B0\u00A7\u00B1\u00B5]/g) ?? [])
    .length;
  const avgWordLength = words.join('').length / words.length;
  let score = 1;
  if (letters / sample.length < 0.45) score -= 0.4;
  if (weird / sample.length > 0.02) score -= 0.4;
  if (avgWordLength < 3.2 || avgWordLength > 9) score -= 0.3;
  return Math.max(0, Math.round(score * 100) / 100);
}
