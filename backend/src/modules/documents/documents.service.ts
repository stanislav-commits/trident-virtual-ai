import { formatError } from '../../common/utils/error.utils';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, In, Repository } from 'typeorm';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { RagService } from '../../integrations/rag/rag.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { PLATFORM_SHIP_ID } from '../ships/platform-ship.constants';
import {
  BulkDeleteDocumentsDto,
  BulkDeleteDocumentsResponseDto,
  DocumentDeleteResponseDto,
  DocumentRemoteDeleteStatus,
} from './dto/delete-documents.dto';
import { DocumentListResponseDto } from './dto/document-list-response.dto';
import { DocumentRetrievalResponseDto } from './dto/document-retrieval-response.dto';
import { DocumentResponseDto } from './dto/document-response.dto';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { ReparseDocumentDto } from './dto/reparse-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { UpdateDocumentClassificationDto } from './dto/update-document-classification.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { DocumentFormLinkEntity } from './entities/document-form-link.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';
import { parseDocCode } from './doc-code.util';
import { toDocumentResponse } from './mapping/documents.mapper';
import { DocumentsIngestionService } from './ingestion/documents-ingestion.service';
import { DocumentsUploadStorageService } from './ingestion/documents-upload-storage.service';
import {
  VisionExtractionService,
  isVisionEligible,
} from './extraction/vision-extraction.service';
import { DocumentDocClass } from './enums/document-doc-class.enum';
import { AssetEntity } from '../assets/entities/asset.entity';
import { AssetDocumentLinkEntity } from '../assets/entities/asset-document-link.entity';
import { DocumentsRemoteIngestionDispatcherService } from './ingestion/documents-remote-ingestion-dispatcher.service';
import { UploadedDocumentFile } from './ingestion/documents-upload.types';
import {
  applyMetadataOverrides,
  applyParsingProfile,
  buildDocumentMetadataFromEntity,
} from './ingestion/documents-profile.helpers';
import {
  buildEffectiveParserConfig,
  getParsingProfileForDocument,
} from './parsing/document-parsing-profiles';
import { DocumentsRetrievalService } from './retrieval/documents-retrieval.service';

export interface DocumentFilePayload {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

/** Asset side of a document link, as the KB edit modal needs it. */
export interface DocumentAssetLinkItem {
  id: string;
  assetIdInternal: string;
  displayName: string;
}

function toAssetLinkItem(asset: AssetEntity): DocumentAssetLinkItem {
  return {
    id: asset.id,
    assetIdInternal: asset.assetIdInternal,
    displayName: asset.displayName,
  };
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    private readonly documentsIngestionService: DocumentsIngestionService,
    private readonly uploadStorage: DocumentsUploadStorageService,
    @InjectRepository(AssetEntity)
    private readonly assetsRepository: Repository<AssetEntity>,
    @InjectRepository(AssetDocumentLinkEntity)
    private readonly assetDocLinkRepository: Repository<AssetDocumentLinkEntity>,
    @InjectRepository(DocumentFormLinkEntity)
    private readonly formLinkRepository: Repository<DocumentFormLinkEntity>,
    private readonly visionExtraction: VisionExtractionService,
    private readonly remoteIngestionDispatcher: DocumentsRemoteIngestionDispatcherService,
    private readonly documentsRetrievalService: DocumentsRetrievalService,
    private readonly ragService: RagService,
  ) {}

  async upload(
    input: UploadDocumentDto,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const ship = await this.resolveAccessibleShip(input.shipId, user);

    // Asset-register-driven naming: when an asset is provided, the
    // register (brand/model/onboard name) is the source of truth for the
    // document title and metadata — not the uploaded file's name.
    let linkedAsset: AssetEntity | null = null;
    if (input.assetId) {
      linkedAsset = await this.assetsRepository.findOne({
        where: { id: input.assetId, shipId: ship.id },
      });
      if (!linkedAsset) {
        throw new BadRequestException('Asset not found on this ship.');
      }
      const ext = file.originalname?.match(/\.[^.]+$/)?.[0] ?? '.pdf';
      const parts = [
        linkedAsset.brand,
        linkedAsset.model,
      ].filter(Boolean);
      const title = `${parts.join(' ')}${parts.length ? ' — ' : ''}${linkedAsset.displayName}`;
      file = { ...file, originalname: `${title}${ext}` };
      input = {
        ...input,
        manufacturer: input.manufacturer ?? linkedAsset.brand ?? undefined,
        model: input.model ?? linkedAsset.model ?? undefined,
        equipmentName: input.equipmentName ?? linkedAsset.displayName,
      };
    }

    const document = await this.documentsIngestionService.upload(
      input,
      file,
      user,
      ship,
    );

    if (linkedAsset) {
      await this.assetDocLinkRepository.save({
        assetId: linkedAsset.id,
        documentId: document.id,
        linkType: 'pinned',
        createdByUserId: user.id,
      });
    } else if (document.docClass === DocumentDocClass.PLAN) {
      // Drawings are named by code — auto-link them ONCE here, as REAL
      // pinned links (like the extractor does for manuals by brand+model).
      // After this it's all explicit/controllable; there is no live phantom
      // match anywhere (which used to link uncontrollable asset lists).
      await this.autoLinkPlanByDrawingCode(document, user.id);
    }

    // Text-bearing docs run through the local vision extractor BEFORE RAGFlow
    // sees them: the dispatcher skips pending/running extractions, and once the
    // markdown is attached it uploads the MD instead of the PDF. Vision is for
    // MANUALS (scans, diagrams, register naming): plans are a pure file store,
    // and procedures/forms are clean text PDFs that RAGFlow's own parser
    // handles — they go straight to remote ingestion.
    if (
      this.visionExtraction.isEnabled() &&
      isVisionEligible(input.docClass)
    ) {
      await this.documentsRepository.update(document.id, {
        extractionStatus: 'pending',
      });
      this.visionExtraction.queue(document.id);
      return document;
    }

    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
    return document;
  }

  /**
   * Fleet-wide Publications (MARPOL/IMO/rules) are owned by the hidden platform
   * scope row, not a vessel. Admins upload them here without picking a ship; the
   * platform ship id + `publication` class are forced server-side so the file
   * lands in the shared platform RAGFlow dataset. Every vessel's chat sees them
   * via the retrieval union (see DocumentsRetrievalService).
   */
  async uploadPublication(
    input: UploadDocumentDto,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    return this.upload(
      {
        ...input,
        shipId: PLATFORM_SHIP_ID,
        docClass: DocumentDocClass.PUBLICATION,
        assetId: undefined,
      },
      file,
      user,
    );
  }

  async listPublications(
    input: ListDocumentsQueryDto,
    user: AuthenticatedUser,
  ): Promise<DocumentListResponseDto> {
    return this.list(
      {
        ...input,
        shipId: PLATFORM_SHIP_ID,
        docClass: DocumentDocClass.PUBLICATION,
      },
      user,
    );
  }

  async list(
    input: ListDocumentsQueryDto,
    user: AuthenticatedUser,
  ): Promise<DocumentListResponseDto> {
    const shipId = await this.resolveListShipId(input.shipId, user);
    const where: FindOptionsWhere<DocumentEntity> = {};
    const pageSize = input.pageSize ?? 25;
    const requestedPage = input.page ?? 1;

    if (shipId) where.shipId = shipId;
    if (input.docClass) where.docClass = input.docClass;
    if (input.parseStatus) where.parseStatus = input.parseStatus;
    const trimmedName = input.name?.trim();
    if (trimmedName) {
      where.originalFileName = ILike(`%${escapeLikePattern(trimmedName)}%`);
    }

    const total = await this.documentsRepository.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const documents = await this.documentsRepository.find({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // Linked assets (pinned) per document — the table shows which units a
    // manual is attached to.
    const docIds = documents.map((document) => document.id);
    const linkRows: Array<{ document_id: string; display_name: string }> =
      docIds.length
        ? await this.assetDocLinkRepository.query(
            `SELECT l.document_id, a.display_name
             FROM asset_documents l JOIN assets a ON a.id = l.asset_id
             WHERE l.link_type = 'pinned' AND l.document_id = ANY($1)
             ORDER BY a.display_name`,
            [docIds],
          )
        : [];
    const linksByDoc = new Map<string, string[]>();
    for (const row of linkRows) {
      const list = linksByDoc.get(row.document_id) ?? [];
      list.push(row.display_name);
      linksByDoc.set(row.document_id, list);
    }

    return {
      items: documents.map((document) => ({
        ...toDocumentResponse(document),
        linkedAssets: linksByDoc.get(document.id) ?? [],
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async getById(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    return toDocumentResponse(await this.findAccessibleDocument(id, user));
  }

  /**
   * Forms & checklists that the given documents' TEXT references by
   * controlled code (SMS procedure says "…fill in JMS EM 002 01…" → the
   * uploaded form whose doc_code is "EM 002 01"). This is the SMS↔forms
   * join: procedures carry form_refs (scanned at upload), forms carry
   * doc_code (parsed from the filename) — resolved here at read time, so
   * upload order never matters. The code match is a STARTING POINT, not the
   * final word: an operator-excluded pair is dropped even if the code still
   * textually matches, and an operator-added manual link is included even
   * with no code match — see formLinksFor/addFormLink/removeFormLink, the
   * KB edit-modal counterpart of this same join.
   */
  async referencedForms(
    shipId: string,
    documentIds: string[],
  ): Promise<{ documentId: string; docCode: string | null; title: string }[]> {
    if (!documentIds.length) return [];
    const sources = await this.documentsRepository.find({
      where: { id: In(documentIds) },
      select: ['id', 'formRefs'],
    });
    const codes = [
      ...new Set(sources.flatMap((source) => source.formRefs ?? [])),
    ];

    const linkRows = await this.formLinkRepository.find({
      where: { sourceDocumentId: In(documentIds) },
    });
    const excludedFormIds = new Set(
      linkRows
        .filter((row) => row.linkType === 'excluded')
        .map((row) => row.formDocumentId),
    );
    const manualFormIds = linkRows
      .filter((row) => row.linkType === 'linked')
      .map((row) => row.formDocumentId);

    const [codeForms, manualForms] = await Promise.all([
      codes.length
        ? this.documentsRepository.find({
            where: { shipId, docClass: DocumentDocClass.FORM, docCode: In(codes) },
          })
        : Promise.resolve([]),
      manualFormIds.length
        ? this.documentsRepository.find({ where: { id: In(manualFormIds) } })
        : Promise.resolve([]),
    ]);

    const byId = new Map<string, DocumentEntity>();
    for (const form of codeForms) {
      if (!excludedFormIds.has(form.id)) byId.set(form.id, form);
    }
    for (const form of manualForms) {
      byId.set(form.id, form);
    }

    return [...byId.values()]
      .sort((a, b) => (a.docCode ?? a.originalFileName).localeCompare(b.docCode ?? b.originalFileName))
      .map((form) => ({
        documentId: form.id,
        docCode: form.docCode,
        title: form.originalFileName,
      }));
  }

  /**
   * The effective form links for ONE document, for the KB edit modal:
   * merges the automatic code-scan match with explicit manual overrides and
   * tags each item's origin so the operator can see what the code scan
   * found vs what they added by hand — and can remove either (removing a
   * code match records a suppression, it doesn't just hide it client-side).
   * Works in both directions off the SAME table: editing a procedure/
   * circular shows the forms it references; editing a FORM shows which
   * procedures/circulars reference it back.
   */
  async formLinksFor(
    id: string,
    user: AuthenticatedUser,
  ): Promise<{
    direction: 'forms' | 'referencedBy';
    items: {
      documentId: string;
      title: string;
      docCode: string | null;
      docClass: DocumentDocClass;
      origin: 'code' | 'manual';
    }[];
  }> {
    const document = await this.findAccessibleDocument(id, user);
    const isForm = document.docClass === DocumentDocClass.FORM;

    const rows = await this.formLinkRepository.find({
      where: isForm ? { formDocumentId: id } : { sourceDocumentId: id },
    });
    const otherIdOf = (row: DocumentFormLinkEntity) =>
      isForm ? row.sourceDocumentId : row.formDocumentId;
    const excludedIds = new Set(
      rows.filter((row) => row.linkType === 'excluded').map(otherIdOf),
    );
    const manualIds = rows
      .filter((row) => row.linkType === 'linked')
      .map(otherIdOf);

    let codeMatches: DocumentEntity[] = [];
    if (isForm) {
      if (document.docCode) {
        codeMatches = await this.documentsRepository
          .createQueryBuilder('d')
          .where('d.ship_id = :shipId', { shipId: document.shipId })
          .andWhere('d.doc_class IN (:...classes)', {
            classes: [DocumentDocClass.PROCEDURE, DocumentDocClass.CIRCULAR],
          })
          .andWhere('d.form_refs ? :code', { code: document.docCode })
          .getMany();
      }
    } else if (document.formRefs?.length) {
      codeMatches = await this.documentsRepository.find({
        where: {
          shipId: document.shipId,
          docClass: DocumentDocClass.FORM,
          docCode: In(document.formRefs),
        },
      });
    }

    const byId = new Map<
      string,
      { documentId: string; title: string; docCode: string | null; docClass: DocumentDocClass; origin: 'code' | 'manual' }
    >();
    for (const match of codeMatches) {
      if (excludedIds.has(match.id)) continue;
      byId.set(match.id, {
        documentId: match.id,
        title: match.originalFileName,
        docCode: match.docCode,
        docClass: match.docClass,
        origin: 'code',
      });
    }
    if (manualIds.length) {
      const manualDocs = await this.documentsRepository.find({
        where: { id: In(manualIds) },
      });
      for (const doc of manualDocs) {
        if (!byId.has(doc.id)) {
          byId.set(doc.id, {
            documentId: doc.id,
            title: doc.originalFileName,
            docCode: doc.docCode,
            docClass: doc.docClass,
            origin: 'manual',
          });
        }
      }
    }

    return {
      direction: isForm ? 'referencedBy' : 'forms',
      items: [...byId.values()].sort((a, b) => a.title.localeCompare(b.title)),
    };
  }

  /**
   * Pin a manual form↔procedure/circular link (the operator adding what the
   * code scan missed, or restoring a link they'd previously suppressed).
   * Exactly one of the two documents must be class FORM — that one becomes
   * form_document_id, the other source_document_id, regardless of which
   * side of the edit modal the operator is working from.
   *
   * When the pair is ALREADY a code match, no 'linked' row is written (it's
   * already showing via the scan) — only a prior suppression is cleared.
   * Writing a redundant 'linked' row here would let a later removeFormLink
   * just delete it and fall straight back to the still-matching scan,
   * silently undoing the removal — see removeFormLink.
   */
  async addFormLink(
    id: string,
    otherId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const { sourceId, formId, isCodeMatch } = await this.resolveFormLinkPair(
      id,
      otherId,
      user,
    );
    const existing = await this.formLinkRepository.findOne({
      where: { sourceDocumentId: sourceId, formDocumentId: formId },
    });
    if (isCodeMatch) {
      if (existing && existing.linkType === 'excluded') {
        await this.formLinkRepository.delete(existing.id);
      }
      return;
    }
    if (existing) {
      if (existing.linkType !== 'linked') {
        existing.linkType = 'linked';
        await this.formLinkRepository.save(existing);
      }
      return;
    }
    await this.formLinkRepository.save(
      this.formLinkRepository.create({
        sourceDocumentId: sourceId,
        formDocumentId: formId,
        linkType: 'linked',
        createdByUserId: user.id,
      }),
    );
  }

  /**
   * Remove a form↔procedure/circular link. If the pair is CURRENTLY a code
   * match, this ALWAYS ends in a persisted 'excluded' row — regardless of
   * whether a 'linked' row already existed — because a plain delete would
   * leave the code scan free to surface it again on the very next read.
   * Only when the pair is not a code match is a plain delete safe (nothing
   * left to suppress it FROM).
   */
  async removeFormLink(
    id: string,
    otherId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const { sourceId, formId, isCodeMatch } = await this.resolveFormLinkPair(
      id,
      otherId,
      user,
    );
    const existing = await this.formLinkRepository.findOne({
      where: { sourceDocumentId: sourceId, formDocumentId: formId },
    });
    if (isCodeMatch) {
      if (existing) {
        if (existing.linkType !== 'excluded') {
          existing.linkType = 'excluded';
          await this.formLinkRepository.save(existing);
        }
      } else {
        await this.formLinkRepository.save(
          this.formLinkRepository.create({
            sourceDocumentId: sourceId,
            formDocumentId: formId,
            linkType: 'excluded',
            createdByUserId: user.id,
          }),
        );
      }
      return;
    }
    if (existing) {
      await this.formLinkRepository.delete(existing.id);
    }
  }

  private async resolveFormLinkPair(
    id: string,
    otherId: string,
    user: AuthenticatedUser,
  ): Promise<{ sourceId: string; formId: string; isCodeMatch: boolean }> {
    if (id === otherId) {
      throw new BadRequestException('A document cannot link to itself.');
    }
    const [a, b] = await Promise.all([
      this.findAccessibleDocument(id, user),
      this.findAccessibleDocument(otherId, user),
    ]);
    if (a.shipId !== b.shipId) {
      throw new BadRequestException('Both documents must belong to the same ship.');
    }
    const aIsForm = a.docClass === DocumentDocClass.FORM;
    const bIsForm = b.docClass === DocumentDocClass.FORM;
    if (aIsForm === bIsForm) {
      throw new BadRequestException(
        'One document must be a form and the other a procedure or circular.',
      );
    }
    const source = aIsForm ? b : a;
    const form = aIsForm ? a : b;
    if (
      source.docClass !== DocumentDocClass.PROCEDURE &&
      source.docClass !== DocumentDocClass.CIRCULAR
    ) {
      throw new BadRequestException(
        'Forms can only be linked to a procedure or circular.',
      );
    }
    const isCodeMatch = Boolean(
      form.docCode && source.formRefs?.includes(form.docCode),
    );
    return { sourceId: source.id, formId: form.id, isCodeMatch };
  }

  /**
   * Rename a document. The display name lives in original_file_name (UI,
   * files-route lookup, citations) and, when the doc is in RAGFlow, on the
   * remote document too — the remote rename is best-effort: a RAGFlow hiccup
   * must not block fixing a local name.
   */
  async rename(
    id: string,
    rawName: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const name = rawName.trim();
    if (!name) throw new BadRequestException('Name must not be empty');
    if (name.length > 300) {
      throw new BadRequestException('Name must be 300 characters or fewer');
    }

    document.originalFileName = name;
    // The controlled code lives in the name — keep it in sync (renaming a
    // form to add its "EM 002 01" code is exactly how codes get fixed).
    document.docCode = parseDocCode(name);
    await this.documentsRepository.save(document);

    if (document.ragflowDatasetId && document.ragflowDocumentId) {
      try {
        await this.ragService.renameRemoteDocument(
          document.ragflowDatasetId,
          document.ragflowDocumentId,
          name,
        );
      } catch (error) {
        this.logger.warn(
          `RAGFlow rename failed for ${id} (local name updated): ${formatError(error)}`,
        );
      }
    }
    return toDocumentResponse(document);
  }

  /**
   * Which assets a document is connected to (KB edit modal). Returns ONLY the
   * REAL pinned links — created by the operator or, at upload, by the strict
   * one-time auto-link (manuals: brand+model; plans: drawing code). No live
   * phantom match anywhere: the old brand-only / drawing-code substring
   * matches returned dozens of uncontrollable assets and made the "Unlinked"
   * chip contradict the modal.
   */
  async listAssetLinks(
    id: string,
    user: AuthenticatedUser,
  ): Promise<{ pinned: DocumentAssetLinkItem[] }> {
    const document = await this.findAccessibleDocument(id, user);
    const links = await this.assetDocLinkRepository.find({
      where: { documentId: document.id, linkType: 'pinned' },
      relations: { asset: true },
    });
    return {
      pinned: links
        .filter((l) => l.asset)
        .map((l) => toAssetLinkItem(l.asset!)),
    };
  }

  /**
   * One-time drawing-ref auto-link for a plan: pin every asset whose DRAWING
   * NUMBER (drawing_ref, e.g. "510650a") appears in the plan's filename (a GA
   * / arrangement drawing legitimately covers many assets). Matches ONLY on
   * drawing_ref — drawing_code holds equipment codes (EL-06, UL, GEN) that
   * spuriously substring-match filenames. Idempotent (composite PK), skips
   * assets the operator already excluded. Returns how many links were created.
   */
  async autoLinkPlanByDrawingCode(
    document: { id: string; shipId: string; originalFileName: string },
    userId: string | null,
  ): Promise<number> {
    const excluded = await this.assetDocLinkRepository.find({
      where: { documentId: document.id, linkType: 'excluded' },
      select: { assetId: true },
    });
    const excludedIds = new Set(excluded.map((l) => l.assetId));

    const matches = await this.assetsRepository
      .createQueryBuilder('a')
      .where('a.ship_id = :shipId', { shipId: document.shipId })
      .andWhere(
        `a.drawing_ref IS NOT NULL AND a.drawing_ref != ''
          AND :fname ILIKE '%' || a.drawing_ref || '%'`,
        { fname: document.originalFileName },
      )
      .getMany();

    const toLink = matches.filter((a) => !excludedIds.has(a.id));
    if (toLink.length) {
      await this.assetDocLinkRepository.save(
        toLink.map((a) => ({
          assetId: a.id,
          documentId: document.id,
          linkType: 'pinned' as const,
          createdByUserId: userId,
        })),
      );
    }
    return toLink.length;
  }

  async updateClassification(
    id: string,
    input: UpdateDocumentClassificationDto,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const previousProfile = document.parseProfile;

    if (input.docClass) {
      document.docClass = input.docClass;
      // Honour vision-extracted markdown — otherwise reclassifying an extracted
      // manual overwrites its DB config with the coarse 'manual' page chunker.
      const profile = getParsingProfileForDocument(document);
      applyParsingProfile(document, profile);
      document.parserConfigJson = buildEffectiveParserConfig(profile);
    }

    applyMetadataOverrides(document, input);
    document.metadataJson = buildDocumentMetadataFromEntity(document);

    if (document.parseProfile !== previousProfile) {
      document.parseStatus = DocumentParseStatus.REPARSE_REQUIRED;
      document.parseError = null;
      document.parseProgressPercent = null;
    }

    return toDocumentResponse(await this.documentsRepository.save(document));
  }

  async reparse(
    id: string,
    user: AuthenticatedUser,
    input: ReparseDocumentDto = {},
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const reparsedDocument = await this.documentsIngestionService.reparse(
      document,
      input,
    );

    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
    return reparsedDocument;
  }

  async syncStatus(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);

    if (!document.ragflowDocumentId) {
      if (
        document.parseStatus === DocumentParseStatus.PENDING_CONFIG ||
        document.parseStatus === DocumentParseStatus.FAILED
      ) {
        return toDocumentResponse(document);
      }

      const queuedDocument =
        await this.documentsIngestionService.prepareRemoteIngestionRetry(document);
      void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
      return toDocumentResponse(queuedDocument);
    }

    return this.documentsIngestionService.syncStatus(document);
  }

  async retryIngestion(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const queuedDocument =
      await this.documentsIngestionService.prepareRemoteIngestionRetry(document);

    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
    return toDocumentResponse(queuedDocument);
  }

  async getFile(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentFilePayload> {
    const document = await this.findAccessibleDocument(id, user);

    // Extracted documents keep their ORIGINAL in storage (local spool or
    // Spaces) — RAGFlow only holds the markdown the AI reads — serve the
    // original here regardless of provider.
    if (
      (this.uploadStorage.isLocalSpoolKey(document.storageKey) ||
        this.uploadStorage.isObjectStorageKey(document.storageKey)) &&
      (await this.uploadStorage.hasUpload(document.storageKey))
    ) {
      return {
        buffer: await this.uploadStorage.readUpload(document.storageKey),
        contentType: document.mimeType || 'application/octet-stream',
        fileName: document.originalFileName,
      };
    }

    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      throw new BadRequestException('Document is not uploaded to RAGFlow yet.');
    }

    const remoteFile = await this.ragService.downloadDocumentFromDataset(
      document.ragflowDatasetId,
      document.ragflowDocumentId,
    );

    return {
      buffer: remoteFile.buffer,
      contentType:
        document.mimeType ||
        remoteFile.contentType ||
        'application/octet-stream',
      fileName: document.originalFileName,
    };
  }

  /** Admin-only: raw vision-extracted markdown for review. */
  async getExtractedMarkdown(
    id: string,
    user: AuthenticatedUser,
  ): Promise<{ markdown: string; fileName: string }> {
    const document = await this.findAccessibleDocument(id, user);
    if (!document.extractedMdKey) {
      throw new BadRequestException('No extracted markdown for this document.');
    }
    return {
      markdown: await this.visionExtraction.readExtractedMarkdown(document),
      fileName: document.originalFileName.replace(/\.[^.]+$/, '.md'),
    };
  }

  /** Admin-only: re-run vision extraction (e.g. after extractor fixes). */
  async rerunExtraction(id: string, user: AuthenticatedUser): Promise<void> {
    const document = await this.findAccessibleDocument(id, user);
    if (!this.visionExtraction.isEnabled()) {
      throw new BadRequestException('Vision extractor is not configured.');
    }
    await this.documentsRepository.update(document.id, {
      extractionStatus: 'pending',
      extractionError: null,
    });
    this.visionExtraction.queue(document.id);
  }

  async delete(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentDeleteResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    return this.deleteDocumentEntity(document);
  }

  async bulkDelete(
    input: BulkDeleteDocumentsDto,
    user: AuthenticatedUser,
  ): Promise<BulkDeleteDocumentsResponseDto> {
    const uniqueIds = Array.from(new Set(input.ids));
    const results: DocumentDeleteResponseDto[] = [];

    for (const id of uniqueIds) {
      try {
        const document = await this.findAccessibleDocument(id, user);
        results.push(await this.deleteDocumentEntity(document));
      } catch (error) {
        results.push({
          id,
          deleted: false,
          remoteDeleteStatus: 'failed',
          error: formatError(error),
        });
      }
    }

    return {
      requested: uniqueIds.length,
      deleted: results.filter((result) => result.deleted).length,
      failed: results.filter((result) => !result.deleted).length,
      results,
    };
  }

  async search(input: SearchDocumentsDto): Promise<DocumentRetrievalResponseDto> {
    return this.documentsRetrievalService.search(input);
  }

  private async deleteDocumentEntity(
    document: DocumentEntity,
  ): Promise<DocumentDeleteResponseDto> {
    let remoteDeleteStatus: DocumentRemoteDeleteStatus = 'skipped';

    if (document.ragflowDatasetId && document.ragflowDocumentId) {
      try {
        await this.ragService.deleteDocumentsFromDataset(document.ragflowDatasetId, [
          document.ragflowDocumentId,
        ]);
        remoteDeleteStatus = 'deleted';
      } catch (error) {
        if (!this.isAcceptableRemoteDeleteMiss(error)) {
          throw new BadGatewayException(
            `RAGFlow document delete failed; local document was not deleted. ${formatError(error)}`,
          );
        }

        remoteDeleteStatus = 'already_absent';
      }
    }

    await this.documentsRepository.delete({ id: document.id });
    await this.documentsIngestionService.deleteLocalUpload(document);

    return {
      id: document.id,
      deleted: true,
      remoteDeleteStatus,
    };
  }

  private isAcceptableRemoteDeleteMiss(error: unknown): boolean {
    const message = formatError(error).toLowerCase();

    return [
      'does not have the document',
      'document not found',
      'documents not found',
      'document was not found',
      'dataset not found',
      'does not own the dataset',
      'lacks permission for dataset',
    ].some((pattern) => message.includes(pattern));
  }


  private async resolveAccessibleShip(
    requestedShipId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<ShipEntity> {
    const shipId = this.resolveShipIdForMutation(requestedShipId, user);
    const ship = await this.shipsRepository.findOne({ where: { id: shipId } });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return ship;
  }

  private resolveShipIdForMutation(
    requestedShipId: string | undefined,
    user: AuthenticatedUser,
  ): string {
    if (user.role === UserRole.ADMIN) {
      if (!requestedShipId) {
        throw new BadRequestException('shipId is required for admin uploads.');
      }

      return requestedShipId;
    }

    if (!user.shipId) {
      throw new BadRequestException('User is not assigned to a ship.');
    }

    if (requestedShipId && requestedShipId !== user.shipId) {
      throw new NotFoundException('Ship not found');
    }

    return user.shipId;
  }

  private async resolveListShipId(
    requestedShipId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<string | undefined> {
    if (user.role === UserRole.ADMIN) {
      if (!requestedShipId) {
        return undefined;
      }

      const ship = await this.shipsRepository.findOne({
        where: { id: requestedShipId },
      });

      if (!ship) {
        throw new NotFoundException('Ship not found');
      }

      return requestedShipId;
    }

    if (!user.shipId) {
      throw new BadRequestException('User is not assigned to a ship.');
    }

    if (requestedShipId && requestedShipId !== user.shipId) {
      throw new NotFoundException('Ship not found');
    }

    return user.shipId;
  }

  private async findAccessibleDocument(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    const document = await this.documentsRepository.findOne({ where: { id } });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (user.role === UserRole.USER && user.shipId !== document.shipId) {
      throw new NotFoundException('Document not found');
    }

    return document;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
