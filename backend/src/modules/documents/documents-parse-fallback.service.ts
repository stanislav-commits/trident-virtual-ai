import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RagService } from '../../integrations/rag/rag.service';
import { DocumentEntity } from './entities/document.entity';
import { DocumentDocClass } from './enums/document-doc-class.enum';
import { DocumentParseStatus } from './enums/document-parse-status.enum';
import { buildDocumentMetadataFromEntity } from './documents-profile.helpers';
import {
  classifyManualParserFailure,
  normalizeErrorMessage,
} from './parsing/document-parser-failure-classifier';
import {
  buildEffectiveParserConfig,
  DocumentFallbackParsingProfileDefinition,
  getManualStableFallbackProfile,
  getParsingProfileForDocClass,
} from './parsing/document-parsing-profiles';

type FallbackStatus = 'queued' | 'succeeded' | 'failed';

const FALLBACK_ATTEMPTED_KEY = 'fallbackAttempted';
const FALLBACK_PROFILE_KEY = 'fallbackProfile';
const FALLBACK_STATUS_KEY = 'fallbackStatus';

@Injectable()
export class DocumentsParseFallbackService {
  private readonly logger = new Logger(DocumentsParseFallbackService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly ragService: RagService,
  ) {}

  async queueManualParserFallback(
    document: DocumentEntity,
    failure: unknown,
  ): Promise<boolean> {
    const classification = classifyManualParserFailure(failure);

    if (!classification.eligible || !classification.reason) {
      return false;
    }

    if (!this.canAttemptManualFallback(document)) {
      return false;
    }

    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      return false;
    }

    const failureMessage = normalizeErrorMessage(failure);
    const fallbackProfile = getManualStableFallbackProfile();
    const startedAt = new Date();
    const originalParserConfig = this.getCurrentParserConfig(document);
    const originalProfile = this.getOriginalProfile(document, originalParserConfig);

    await this.ragService.updateRemoteDocumentConfig(
      document.ragflowDatasetId,
      document.ragflowDocumentId,
      {
        metadata: document.metadataJson ?? buildDocumentMetadataFromEntity(document),
        parsingProfile: fallbackProfile,
      },
    );

    this.applyFallbackRuntimeConfig(document, fallbackProfile);
    document.parserConfigJson = {
      ...buildEffectiveParserConfig(fallbackProfile),
      [FALLBACK_ATTEMPTED_KEY]: true,
      [FALLBACK_PROFILE_KEY]: fallbackProfile.parseProfile,
      [FALLBACK_STATUS_KEY]: 'queued',
      fallbackReason: classification.reason,
      fallbackStartedAt: startedAt.toISOString(),
      fallbackOriginalError: failureMessage,
      originalProfile,
      originalParserConfig,
      statusMessage: 'Retrying automatically with safer manual profile',
    };
    document.parseStatus = DocumentParseStatus.PENDING_PARSE;
    document.parseError =
      'Retrying automatically with safer manual profile after RAGFlow parser ' +
      `failure: ${classification.reason}.`;
    document.parseProgressPercent = null;
    document.chunkCount = null;
    document.parsedAt = null;
    document.lastSyncedAt = startedAt;

    await this.documentsRepository.save(document);
    this.logger.log(
      `Queued manual parser fallback for document ${document.id} ` +
        `with profile ${fallbackProfile.parseProfile} after ${classification.reason}.`,
    );

    return true;
  }

  hasFallbackAttempted(document: DocumentEntity): boolean {
    const config = this.asRecord(document.parserConfigJson);

    return config?.[FALLBACK_ATTEMPTED_KEY] === true;
  }

  markFallbackSucceeded(document: DocumentEntity): void {
    this.updateFallbackStatus(
      document,
      'succeeded',
      'Fallback profile attempted',
    );
  }

  markFallbackFailed(document: DocumentEntity, failure: unknown): void {
    this.updateFallbackStatus(
      document,
      'failed',
      'Failed after fallback retry',
      normalizeErrorMessage(failure),
    );
  }

  formatFailureAfterFallbackIfAttempted(
    document: DocumentEntity,
    failure: unknown,
  ): string {
    const failureMessage = normalizeErrorMessage(failure);

    if (!this.hasFallbackAttempted(document)) {
      return failureMessage;
    }

    const profile = this.asRecord(document.parserConfigJson)?.[
      FALLBACK_PROFILE_KEY
    ];
    const profileLabel = typeof profile === 'string' ? profile : 'manual_stable';

    return `Failed after fallback retry (${profileLabel}): ${failureMessage}`;
  }

  private canAttemptManualFallback(document: DocumentEntity): boolean {
    return (
      document.docClass === DocumentDocClass.MANUAL &&
      this.isPdfDocument(document) &&
      !this.hasFallbackAttempted(document)
    );
  }

  private isPdfDocument(document: DocumentEntity): boolean {
    return (
      document.mimeType.toLowerCase() === 'application/pdf' ||
      document.originalFileName.toLowerCase().endsWith('.pdf')
    );
  }

  private applyFallbackRuntimeConfig(
    document: DocumentEntity,
    profile: DocumentFallbackParsingProfileDefinition,
  ): void {
    document.chunkMethod = profile.chunkMethod;
    document.pdfParser = profile.pdfParser;
    document.autoKeywords = profile.autoKeywords;
    document.autoQuestions = profile.autoQuestions;
    document.chunkSize = profile.chunkSize;
    document.delimiter = profile.delimiter;
    document.overlapPercent = profile.overlapPercent;
    document.pageIndexEnabled = profile.pageIndexEnabled;
    document.childChunksEnabled = profile.childChunksEnabled;
    document.imageTableContextWindow =
      profile.tableContextSize ?? profile.imageContextSize ?? null;
  }

  private getCurrentParserConfig(document: DocumentEntity): Record<string, unknown> {
    return (
      this.asRecord(document.parserConfigJson) ??
      buildEffectiveParserConfig(getParsingProfileForDocClass(document.docClass))
    );
  }

  private getOriginalProfile(
    document: DocumentEntity,
    parserConfig: Record<string, unknown>,
  ): string {
    const configuredProfile = parserConfig.parseProfile;

    return typeof configuredProfile === 'string'
      ? configuredProfile
      : document.parseProfile;
  }

  private updateFallbackStatus(
    document: DocumentEntity,
    status: FallbackStatus,
    statusMessage: string,
    failureMessage?: string,
  ): void {
    if (!this.hasFallbackAttempted(document)) {
      return;
    }

    document.parserConfigJson = {
      ...(this.asRecord(document.parserConfigJson) ?? {}),
      [FALLBACK_STATUS_KEY]: status,
      fallbackFinishedAt: new Date().toISOString(),
      fallbackFinalError: failureMessage,
      statusMessage,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }
}
