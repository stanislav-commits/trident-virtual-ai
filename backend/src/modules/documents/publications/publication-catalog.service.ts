import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import pdfParse from 'pdf-parse';
import { AuthenticatedUser } from '../../../core/auth/auth.types';
import { DocumentsService } from '../documents.service';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { PublicationCatalogEntity } from '../entities/publication-catalog.entity';
import { UploadedDocumentFile } from '../ingestion/documents-upload.types';
import { AdminEventBus } from '../../admin-events/admin-event.bus';

export interface PublicationCatalogItemDto {
  id: string;
  title: string;
  conditionalNote: string | null;
  sortOrder: number;
  documentId: string | null;
  fileName: string | null;
  parseStatus: string | null;
  category: string | null;
  jurisdiction: string | null;
  series: string | null;
  /** Section headings of the merged document (admin search fodder). */
  contents: string | null;
}

/**
 * The Publications Library catalog (fleet-wide). Lists the expected
 * publications and lets an admin attach the actual file to a slot. The file is
 * stored as a normal `publication`-class document on the platform ship (reusing
 * the Phase-3 upload path → Spaces on prod + the platform RAGFlow dataset), and
 * linked back to its catalog row.
 */
@Injectable()
export class PublicationCatalogService {
  constructor(
    @InjectRepository(PublicationCatalogEntity)
    private readonly catalogRepository: Repository<PublicationCatalogEntity>,
    private readonly documentsService: DocumentsService,
    private readonly adminEvents: AdminEventBus,
  ) {}

  /** Publications are fleet-wide (no ship) — shipId is null. */
  private emitChange(action: 'created' | 'updated' | 'deleted'): void {
    this.adminEvents.emit({
      domain: 'publications',
      action,
      shipId: null,
    });
  }

  async list(): Promise<PublicationCatalogItemDto[]> {
    const entries = await this.catalogRepository.find({
      relations: { document: true },
      order: { sortOrder: 'ASC' },
    });

    return entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      conditionalNote: entry.conditionalNote,
      sortOrder: entry.sortOrder,
      documentId: entry.document ? entry.document.id : null,
      fileName: entry.document ? entry.document.originalFileName : null,
      parseStatus: entry.document ? entry.document.parseStatus : null,
      category: entry.category,
      jurisdiction: entry.jurisdiction,
      series: entry.series,
      contents: entry.contents,
    }));
  }

  /**
   * Add a new expected publication to the catalog. Appends it after the current
   * last slot (max sortOrder + 1) so it lands at the bottom of the list.
   */
  async create(input: {
    title: string;
    conditionalNote?: string | null;
    category?: string | null;
    jurisdiction?: string | null;
    series?: string | null;
    contents?: string | null;
  }): Promise<PublicationCatalogItemDto> {
    // The bulk loader retries after network hiccups — a title that already
    // exists in the same category is the same slot, not a second one.
    const existing = await this.catalogRepository.findOne({
      where: { title: input.title, category: input.category ?? IsNull() },
    });
    if (existing) {
      return (await this.list()).find((item) => item.id === existing.id)!;
    }

    const last = await this.catalogRepository.findOne({
      where: {},
      order: { sortOrder: 'DESC' },
    });

    const entry = this.catalogRepository.create({
      title: input.title,
      conditionalNote: input.conditionalNote ?? null,
      category: input.category ?? null,
      jurisdiction: input.jurisdiction ?? null,
      series: input.series ?? null,
      contents: input.contents ?? null,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      documentId: null,
    });

    const saved = await this.catalogRepository.save(entry);
    this.emitChange('created');

    return (await this.list()).find((item) => item.id === saved.id)!;
  }

  /**
   * Upload (or replace) the file for one catalog slot. Forces the catalog
   * title as the document name so the library reads consistently regardless of
   * the uploaded file's own name.
   */
  async attachFile(
    catalogId: string,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<PublicationCatalogItemDto> {
    const entry = await this.requireEntry(catalogId);

    // Replace any previously attached file.
    if (entry.documentId) {
      await this.safeDeleteDocument(entry.documentId, user);
      entry.documentId = null;
      await this.catalogRepository.save(entry);
    }

    const ext = file.originalname?.match(/\.[^.]+$/)?.[0] ?? '';
    const named: UploadedDocumentFile = {
      ...file,
      originalname: `${entry.title}${ext}`,
    };

    const document = await this.documentsService.uploadPublication(
      { docClass: DocumentDocClass.PUBLICATION },
      named,
      user,
    );

    entry.documentId = document.id;
    await this.catalogRepository.save(entry);
    this.emitChange('updated');

    return (await this.list()).find((item) => item.id === entry.id)!;
  }

  /**
   * "Add article" (monthly refresh from the admin panel): append one new
   * section to an existing MERGED markdown publication — a new MS Notice
   * joins the "MS Notices" document without anyone rebuilding the library.
   * Accepts a PDF (text extracted server-side via pdf-parse) or a ready
   * .md/.txt body. The document file is replaced in place, so its id — and
   * every reference to it — survives, and RAGFlow re-parses just this one.
   */
  async appendSection(
    catalogId: string,
    heading: string,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<PublicationCatalogItemDto> {
    const entry = await this.requireEntry(catalogId);
    if (!entry.documentId) {
      throw new BadRequestException(
        'This slot has no publication yet — upload the document first.',
      );
    }
    const current = await this.documentsService.getFile(entry.documentId, user);
    const isMarkdown =
      (current.fileName ?? '').toLowerCase().endsWith('.md') ||
      current.contentType === 'text/markdown';
    if (!isMarkdown) {
      throw new BadRequestException(
        'Articles can only be appended to merged markdown publications. ' +
          'For original files (forms), replace the file instead.',
      );
    }
    if (!heading.trim()) {
      throw new BadRequestException('The article needs a heading.');
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException('The article file is empty.');
    }

    let bodyText: string;
    const uploadName = (file.originalname ?? '').toLowerCase();
    if (uploadName.endsWith('.pdf') || file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(file.buffer);
      bodyText = (parsed.text ?? '').trim();
      if (bodyText.length < 40) {
        throw new BadRequestException(
          'Could not read text from this PDF (likely a scan) — convert it ' +
            'to text or markdown first.',
        );
      }
    } else {
      bodyText = file.buffer.toString('utf8').trim();
    }

    const section = `\n## ${heading.trim()}\n\n${bodyText}\n`;
    const next = Buffer.concat([current.buffer, Buffer.from(section, 'utf8')]);

    // Replace through the normal attach path so storage, RAGFlow and the
    // document row all move together; then extend the searchable contents.
    const contents = entry.contents;
    const updated = await this.attachFile(
      catalogId,
      {
        buffer: next,
        originalname: current.fileName ?? `${entry.title}.md`,
        mimetype: 'text/markdown',
        size: next.length,
      },
      user,
    );
    const refreshed = await this.requireEntry(catalogId);
    refreshed.contents = `${contents ?? ''}\n${heading.trim()}`.trim().slice(0, 20000);
    await this.catalogRepository.save(refreshed);
    this.emitChange('updated');
    return { ...updated, contents: refreshed.contents };
  }

  /** Edit taxonomy / title of a slot (admin reconciliation + housekeeping). */
  async update(
    catalogId: string,
    input: {
      title?: string;
      conditionalNote?: string | null;
      category?: string | null;
      jurisdiction?: string | null;
      series?: string | null;
    },
  ): Promise<PublicationCatalogItemDto> {
    const entry = await this.requireEntry(catalogId);
    if (input.title !== undefined) entry.title = input.title;
    if (input.conditionalNote !== undefined) {
      entry.conditionalNote = input.conditionalNote;
    }
    if (input.category !== undefined) entry.category = input.category;
    if (input.jurisdiction !== undefined) entry.jurisdiction = input.jurisdiction;
    if (input.series !== undefined) entry.series = input.series;
    await this.catalogRepository.save(entry);
    this.emitChange('updated');
    return (await this.list()).find((item) => item.id === entry.id)!;
  }

  /** Remove a slot entirely (its attached document goes with it). */
  async remove(catalogId: string, user: AuthenticatedUser): Promise<void> {
    const entry = await this.requireEntry(catalogId);
    if (entry.documentId) {
      await this.safeDeleteDocument(entry.documentId, user);
    }
    await this.catalogRepository.delete({ id: entry.id });
    this.emitChange('deleted');
  }

  async detachFile(
    catalogId: string,
    user: AuthenticatedUser,
  ): Promise<PublicationCatalogItemDto> {
    const entry = await this.requireEntry(catalogId);

    if (entry.documentId) {
      await this.safeDeleteDocument(entry.documentId, user);
      entry.documentId = null;
      await this.catalogRepository.save(entry);
    }
    this.emitChange('updated');

    return (await this.list()).find((item) => item.id === entry.id)!;
  }

  private async requireEntry(id: string): Promise<PublicationCatalogEntity> {
    const entry = await this.catalogRepository.findOne({ where: { id } });
    if (!entry) {
      throw new NotFoundException('Publication catalog entry not found');
    }
    return entry;
  }

  private async safeDeleteDocument(
    documentId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    try {
      await this.documentsService.delete(documentId, user);
    } catch {
      // Document may already be gone; the FK is ON DELETE SET NULL so the
      // catalog row stays consistent regardless.
    }
  }
}
