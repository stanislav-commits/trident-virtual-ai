import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { SearchDocumentsDto } from '../dto/search-documents.dto';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentParseStatus } from '../enums/document-parse-status.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';
import {
  ALL_DOCUMENT_CLASSES,
  DOCUMENT_RETRIEVAL_DEFAULT_CANDIDATE_K,
  DOCUMENT_RETRIEVAL_DEFAULT_TOP_K,
  DOCUMENT_TITLE_HINT_NARROWING_THRESHOLD,
  DocumentRetrievalFilterContext,
  DocumentRetrievalHints,
  matchesAnyRetrievalHint,
  scoreDocumentTitleHintMatch,
} from './documents-retrieval.types';

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

  applyLocalMetadataPrefilter(
    documents: DocumentEntity[],
    context: DocumentRetrievalFilterContext,
    languageHint: string | undefined,
  ): DocumentEntity[] {
    if (!context.hasMetadataHints) {
      return documents;
    }

    return documents.filter((document) => {
      const hintMatches = [
        context.hints.equipmentOrSystem.length
          ? matchesAnyRetrievalHint(
              document.equipmentOrSystem,
              context.hints.equipmentOrSystem,
            )
          : true,
        context.hints.manufacturer.length
          ? matchesAnyRetrievalHint(document.manufacturer, context.hints.manufacturer)
          : true,
        context.hints.model.length
          ? matchesAnyRetrievalHint(document.model, context.hints.model)
          : true,
        context.hints.contentFocus.length
          ? matchesAnyRetrievalHint(document.contentFocus, context.hints.contentFocus)
          : true,
        languageHint?.trim()
          ? matchesAnyRetrievalHint(document.language, [languageHint.trim()])
          : true,
        context.documentTitleHint
          ? scoreDocumentTitleHintMatch(
              document.originalFileName,
              context.documentTitleHint,
            ) >= DOCUMENT_TITLE_HINT_NARROWING_THRESHOLD
          : true,
      ];

      return hintMatches.every(Boolean);
    });
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
      return Array.from(new Set(input.candidateDocClasses));
    }

    if (input.category && this.isDocumentClass(input.category)) {
      return [input.category];
    }

    return [...ALL_DOCUMENT_CLASSES];
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
