import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    }));
  }

  /**
   * Add a new expected publication to the catalog. Appends it after the current
   * last slot (max sortOrder + 1) so it lands at the bottom of the list.
   */
  async create(input: {
    title: string;
    conditionalNote?: string | null;
  }): Promise<PublicationCatalogItemDto> {
    const last = await this.catalogRepository.findOne({
      where: {},
      order: { sortOrder: 'DESC' },
    });

    const entry = this.catalogRepository.create({
      title: input.title,
      conditionalNote: input.conditionalNote ?? null,
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
