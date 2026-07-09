import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { SearchDocumentsDto } from '../../dto/search-documents.dto';
import { DocumentEntity } from '../../entities/document.entity';
import { DocumentDocClass } from '../../enums/document-doc-class.enum';
import { DocumentParseStatus } from '../../enums/document-parse-status.enum';
import { DocumentRetrievalQuestionType } from '../../enums/document-retrieval-question-type.enum';
import { PLATFORM_SHIP_ID } from '../../../ships/platform-ship.constants';
import {
  ALL_DOCUMENT_CLASSES,
  RETRIEVABLE_DOCUMENT_CLASSES,
  DOCUMENT_RETRIEVAL_DEFAULT_CANDIDATE_K,
  DOCUMENT_RETRIEVAL_DEFAULT_TOP_K,
  DOCUMENT_TITLE_HINT_NARROWING_THRESHOLD,
  DocumentRetrievalFilterContext,
  DocumentRetrievalHints,
  matchesAnyRetrievalHint,
  scoreDocumentTitleHintMatch,
} from '../documents-retrieval.types';

@Injectable()
export class DocumentsRetrievalFilterBuilder {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
  ) {}

  buildContext(input: SearchDocumentsDto): DocumentRetrievalFilterContext {
    const topK = this.normalizeLimit(input.topK, DOCUMENT_RETRIEVAL_DEFAULT_TOP_K, 20);
    const candidateK = this.normalizeLimit(
      input.candidateK,
      Math.max(DOCUMENT_RETRIEVAL_DEFAULT_CANDIDATE_K, topK * 3),
      50,
    );
    const requestedDocClasses = this.resolveCandidateDocClasses(input);
    const hints = this.normalizeHints(input);
    const documentTitleHint = input.documentTitleHint?.trim() || null;
    const requireDocumentTitleMatch = Boolean(
      input.requireDocumentTitleMatch && documentTitleHint,
    );

    return {
      topK,
      candidateK,
      requestedDocClasses,
      hints,
      hasMetadataHints: this.hasMetadataHints(
        hints,
        input.languageHint,
        documentTitleHint,
      ),
      allowMultiDocument: Boolean(
        input.allowMultiDocument ||
          input.questionType === DocumentRetrievalQuestionType.MULTI_DOCUMENT_COMPARE,
      ),
      documentTitleHint,
      requireDocumentTitleMatch,
    };
  }

  async loadUsableDocuments(
    shipId: string,
    ragflowDatasetId: string,
    docClasses: DocumentDocClass[],
  ): Promise<DocumentEntity[]> {
    return this.documentsRepository.find({
      where: {
        shipId,
        ragflowDatasetId,
        ragflowDocumentId: Not(IsNull()),
        parseStatus: DocumentParseStatus.PARSED,
        docClass: In(docClasses),
      },
      order: {
        sourcePriority: 'ASC',
        updatedAt: 'DESC',
      },
    });
  }

  /**
   * Fleet-wide Publications live under the hidden platform scope in their own
   * shared RAGFlow dataset. They are unioned into every vessel's retrieval so a
   * ship's chat sees its own KB PLUS the shared rules/regs (approach B).
   */
  async loadPublicationDocuments(
    platformDatasetId: string,
  ): Promise<DocumentEntity[]> {
    return this.documentsRepository.find({
      where: {
        shipId: PLATFORM_SHIP_ID,
        ragflowDatasetId: platformDatasetId,
        ragflowDocumentId: Not(IsNull()),
        parseStatus: DocumentParseStatus.PARSED,
        docClass: DocumentDocClass.PUBLICATION,
      },
      order: {
        sourcePriority: 'ASC',
        updatedAt: 'DESC',
      },
    });
  }

  applyLocalMetadataPrefilter(
    documents: DocumentEntity[],
    context: DocumentRetrievalFilterContext,
    languageHint: string | undefined,
  ): DocumentEntity[] {
    if (!context.hasMetadataHints) {
      return documents;
    }

    const titleMatchedDocuments = context.documentTitleHint
      ? documents.filter((document) =>
          this.matchesDocumentTitleHint(document, context.documentTitleHint),
        )
      : [];

    if (
      context.requireDocumentTitleMatch &&
      context.documentTitleHint &&
      !titleMatchedDocuments.length
    ) {
      return [];
    }

    if (titleMatchedDocuments.length) {
      const metadataMatchedTitleDocuments = titleMatchedDocuments.filter((document) =>
        this.matchesNonTitleMetadataHints(document, context, languageHint),
      );

      return metadataMatchedTitleDocuments.length
        ? metadataMatchedTitleDocuments
        : titleMatchedDocuments;
    }

    if (
      context.documentTitleHint &&
      !this.hasNonTitleMetadataHints(context, languageHint)
    ) {
      return [];
    }

    return documents.filter((document) =>
      this.matchesNonTitleMetadataHints(document, context, languageHint),
    );
  }

  indexByRagflowDocumentId(
    documents: DocumentEntity[],
  ): Map<string, DocumentEntity> {
    return new Map(
      documents
        .filter((document) => document.ragflowDocumentId)
        .map((document) => [document.ragflowDocumentId!, document]),
    );
  }

  private resolveCandidateDocClasses(input: SearchDocumentsDto): DocumentDocClass[] {
    if (input.candidateDocClasses?.length) {
      return this.excludeRetiredClasses(Array.from(new Set(input.candidateDocClasses)));
    }

    if (input.category && this.isDocumentClass(input.category)) {
      return this.excludeRetiredClasses([input.category]);
    }

    return [...RETRIEVABLE_DOCUMENT_CLASSES];
  }

  /**
   * Drop retired classes (e.g. historical_procedure) that must never be
   * retrieved, even if a caller or the router still requests them. Maintenance
   * is owned by the `pms` chat route reading the live Tasks register.
   */
  private excludeRetiredClasses(
    docClasses: DocumentDocClass[],
  ): DocumentDocClass[] {
    return docClasses.filter((docClass) =>
      RETRIEVABLE_DOCUMENT_CLASSES.includes(docClass),
    );
  }

  private normalizeLimit(
    value: number | undefined,
    fallback: number,
    max: number,
  ): number {
    return value !== undefined && Number.isInteger(value) && value > 0
      ? Math.min(value, max)
      : fallback;
  }

  private normalizeHints(input: SearchDocumentsDto): DocumentRetrievalHints {
    return {
      equipmentOrSystem: normalizeHintValues(input.equipmentOrSystemHints),
      manufacturer: normalizeHintValues(input.manufacturerHints),
      model: normalizeHintValues(input.modelHints),
      contentFocus: normalizeHintValues(input.contentFocusHints),
    };
  }

  private hasMetadataHints(
    hints: DocumentRetrievalHints,
    languageHint?: string,
    documentTitleHint?: string | null,
  ): boolean {
    return (
      hints.equipmentOrSystem.length > 0 ||
      hints.manufacturer.length > 0 ||
      hints.model.length > 0 ||
      hints.contentFocus.length > 0 ||
      Boolean(languageHint?.trim()) ||
      Boolean(documentTitleHint?.trim())
    );
  }

  private isDocumentClass(value: string): value is DocumentDocClass {
    return ALL_DOCUMENT_CLASSES.includes(value as DocumentDocClass);
  }

  private matchesDocumentTitleHint(
    document: DocumentEntity,
    documentTitleHint: string | null,
  ): boolean {
    return (
      scoreDocumentTitleHintMatch(
        document.originalFileName,
        documentTitleHint,
      ) >= DOCUMENT_TITLE_HINT_NARROWING_THRESHOLD
    );
  }

  private matchesNonTitleMetadataHints(
    document: DocumentEntity,
    context: DocumentRetrievalFilterContext,
    languageHint: string | undefined,
  ): boolean {
    // NOTE: contentFocus is intentionally NOT a hard prefilter discriminator.
    // It is a fuzzy, topical hint ("oil change interval", "maintenance
    // guidelines") that rarely matches a document's stored content_focus
    // verbatim. Because matchesAnyRetrievalHint needs the document field to
    // *contain* the hint string, an unset/short content_focus made
    // matchesAnyRetrievalHint return false, and the `.every(Boolean)` below then
    // dropped EVERY document whenever the query carried a contentFocus hint —
    // silently disabling equipment-based narrowing for the common case
    // (maintenance/"how often" questions always produce contentFocus hints).
    // contentFocus still contributes as a soft reranker bonus. Identity hints
    // (equipment / manufacturer / model / language) remain hard discriminators.
    const hintMatches = [
      context.hints.equipmentOrSystem.length
        ? // Match the equipment hint against the structured field OR the
          // descriptive file name. Our processed manuals are named with their
          // equipment roles spelled out ("... — Fuel Transfer Pump Bilge Pump"),
          // so the file name itself is a reliable equipment signal even when
          // equipment_or_system was never populated. This lets equipment-based
          // narrowing work across the whole corpus without hand-filling metadata.
          // Token-based (all hint words present, any order) so multi-word hints
          // like "zf gearbox" still match a field reading "... gearbox ... zf".
          matchesEquipmentHint(
            document.equipmentOrSystem,
            context.hints.equipmentOrSystem,
          ) ||
          matchesEquipmentHint(
            document.originalFileName,
            context.hints.equipmentOrSystem,
          )
        : true,
      // Manufacturer / model: same field-OR-filename, token-based match as
      // equipment. Most documents never had manufacturer/model columns filled,
      // so a strict field-only match would (via .every below) drop every
      // document whenever the query produced a manufacturer/model hint — the
      // same silent-disable that hid the equipment narrowing. The descriptive
      // file name ("ZF 305-3 — Port Gearbox ...") carries brand + model reliably.
      context.hints.manufacturer.length
        ? matchesEquipmentHint(document.manufacturer, context.hints.manufacturer) ||
          matchesEquipmentHint(document.originalFileName, context.hints.manufacturer)
        : true,
      context.hints.model.length
        ? matchesEquipmentHint(document.model, context.hints.model) ||
          matchesEquipmentHint(document.originalFileName, context.hints.model)
        : true,
      languageHint?.trim()
        ? matchesAnyRetrievalHint(document.language, [languageHint.trim()])
        : true,
    ];

    return hintMatches.every(Boolean);
  }

  private hasNonTitleMetadataHints(
    context: DocumentRetrievalFilterContext,
    languageHint: string | undefined,
  ): boolean {
    return (
      context.hints.equipmentOrSystem.length > 0 ||
      context.hints.manufacturer.length > 0 ||
      context.hints.model.length > 0 ||
      context.hints.contentFocus.length > 0 ||
      Boolean(languageHint?.trim())
    );
  }
}

// Token-based equipment-hint match: the document field matches a hint when it
// contains the full hint phrase OR contains every significant (>=2 char) token
// of that hint, in any order. Robust to word order / extra words so "zf gearbox"
// matches "marine gearbox transmission ... zf" and "fuel transfer pump" matches a
// file name listing "... Fuel Transfer Pump Emergency Bilge Pump". Used only for
// the equipment prefilter — identity-strong but order-insensitive.
function matchesEquipmentHint(
  value: string | null | undefined,
  hints: string[],
): boolean {
  const normalizedValue = value?.trim().toLowerCase();

  if (!normalizedValue || !hints.length) {
    return false;
  }

  return hints.some((hint) => {
    const normalizedHint = hint.trim().toLowerCase();

    if (!normalizedHint) {
      return false;
    }

    if (normalizedValue.includes(normalizedHint)) {
      return true;
    }

    const tokens = normalizedHint
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2);

    return (
      tokens.length > 0 &&
      tokens.every((token) => normalizedValue.includes(token))
    );
  });
}

function normalizeHintValues(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}
