import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { ManualSemanticEnrichmentService } from '../semantic/manual-semantic-enrichment.service';
import { TagLinksService } from '../tags/tag-links.service';

@Injectable()
export class ManualsParseScheduler {
  private readonly logger = new Logger(ManualsParseScheduler.name);
  private readonly retryableFailurePatterns = [
    'internal server error while chunking',
    "coordinate 'lower' is less than 'upper'",
    'coordinate lower is less than upper',
  ];
  private readonly batchSize = this.readIntEnv(
    'RAGFLOW_PARSE_DOCUMENT_BATCH_SIZE',
    5,
    1,
    20,
  );
  private readonly maxRunningDocuments = this.readIntEnv(
    'RAGFLOW_PARSE_MAX_RUNNING_DOCUMENTS',
    5,
    1,
    50,
  );
  private readonly resubmitCooldownMs = this.readIntEnv(
    'RAGFLOW_PARSE_RESUBMIT_COOLDOWN_MS',
    60000,
    1000,
    600000,
  );
  private readonly failureRetryCooldownMs = this.readIntEnv(
    'RAGFLOW_PARSE_FAILURE_RETRY_COOLDOWN_MS',
    120000,
    1000,
    3600000,
  );
  private readonly failureRetryMaxAttempts = this.readIntEnv(
    'RAGFLOW_PARSE_FAILURE_MAX_RETRIES',
    1,
    0,
    5,
  );
  private readonly contentTaggingCooldownMs = this.readIntEnv(
    'RAGFLOW_CONTENT_TAGGING_COOLDOWN_MS',
    600000,
    1000,
    86400000,
  );

  private isDraining = false;
  private drainRequested = false;
  private readonly recentlySubmitted = new Map<string, number>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly recentlyContentTagged = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    @Optional() private readonly tagLinks?: TagLinksService,
    @Optional()
    private readonly manualSemanticEnrichment?: ManualSemanticEnrichmentService,
  ) {}

  notifyPendingDocuments(): void {
    this.requestDrain();
  }

  @Interval(15000)
  async drainPendingDocuments(): Promise<void> {
    await this.requestDrain();
  }

  private readIntEnv(
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < min || parsed > max) return fallback;
    return parsed;
  }

  private async requestDrain(): Promise<void> {
    if (!this.ragflow.isConfigured()) return;

    if (this.isDraining) {
      this.drainRequested = true;
      return;
    }

    this.isDraining = true;
    try {
      do {
        this.drainRequested = false;
        this.cleanupCooldowns();
        await this.drainDatasetsOnce();
      } while (this.drainRequested);
    } finally {
      this.isDraining = false;
    }
  }

  private cleanupCooldowns(): void {
    const now = Date.now();
    for (const [documentId, until] of this.recentlySubmitted.entries()) {
      if (until <= now) {
        this.recentlySubmitted.delete(documentId);
      }
    }
    for (const [documentId, until] of this.recentlyContentTagged.entries()) {
      if (until <= now) {
        this.recentlyContentTagged.delete(documentId);
      }
    }
  }

  private async drainDatasetsOnce(): Promise<void> {
    const ships = await this.prisma.ship.findMany({
      where: {
        ragflowDatasetId: { not: null },
        manuals: { some: {} },
      },
      select: {
        id: true,
        ragflowDatasetId: true,
      },
    });

    for (const ship of ships) {
      if (!ship.ragflowDatasetId) continue;

      try {
        await this.drainShip(ship.id, ship.ragflowDatasetId);
      } catch (err) {
        this.logger.warn(
          `Failed to drain manual parse queue for ship ${ship.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async drainShip(shipId: string, datasetId: string): Promise<void> {
    const manuals = await this.prisma.shipManual.findMany({
      where: { shipId },
      orderBy: { uploadedAt: 'asc' },
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        category: true,
        semanticProfile: true,
        semanticProfileStatus: true,
        semanticProfileVersion: true,
        semanticProfileUpdatedAt: true,
      },
    });

    if (!manuals.length) return;

    const docs = await this.ragflow.listDocuments(
      datasetId,
      manuals.map((manual) => manual.ragflowDocumentId),
    );
    this.cleanupRetryAttempts(docs);
    const now = Date.now();

    const runByDocumentId = new Map(docs.map((doc) => [doc.id, doc.run]));
    const retryableFailureIds = new Set(
      docs.filter((doc) => this.isRetryableFailure(doc)).map((doc) => doc.id),
    );
    const contentTaggableDocumentIds = new Set(
      docs
        .filter(
          (doc) =>
            doc.run === 'DONE' &&
            doc.chunk_count > 0 &&
            (this.recentlyContentTagged.get(doc.id) ?? 0) <= now,
        )
        .map((doc) => doc.id),
    );
    const manualByDocumentId = new Map(
      manuals.map((manual) => [manual.ragflowDocumentId, manual]),
    );
    const semanticEnrichableDocumentIds = new Set(
      docs
        .filter((doc) => {
          if (doc.run !== 'DONE' || doc.chunk_count <= 0) {
            return false;
          }
          const manual = manualByDocumentId.get(doc.id);
          return manual && this.manualSemanticEnrichment
            ? this.manualSemanticEnrichment.shouldRefreshProfile(manual)
            : false;
        })
        .map((doc) => doc.id),
    );

    if (this.tagLinks && contentTaggableDocumentIds.size > 0) {
      const manualIdsForContentTagging = manuals
        .filter((manual) =>
          contentTaggableDocumentIds.has(manual.ragflowDocumentId),
        )
        .map((manual) => manual.id);

      if (manualIdsForContentTagging.length > 0) {
        const refreshResult = await this.tagLinks.autoLinkManuals(
          manualIdsForContentTagging,
        );
        for (const documentId of contentTaggableDocumentIds) {
          this.recentlyContentTagged.set(
            documentId,
            now + this.contentTaggingCooldownMs,
          );
        }
        this.logger.debug(
          `Manual content tag refresh ship=${shipId} processed=${refreshResult.processed} linked=${refreshResult.linked} untouched=${refreshResult.untouched} cleared=${refreshResult.cleared}`,
        );
      }
    }

    if (
      this.manualSemanticEnrichment &&
      semanticEnrichableDocumentIds.size > 0
    ) {
      for (const documentId of semanticEnrichableDocumentIds) {
        const manual = manualByDocumentId.get(documentId);
        if (!manual) {
          continue;
        }
        await this.manualSemanticEnrichment.refreshManualProfile({
          shipId,
          datasetId,
          manual,
        });
      }
    }

    const runningCount = docs.filter((doc) => doc.run === 'RUNNING').length;
    const capacity = Math.max(0, this.maxRunningDocuments - runningCount);
    if (capacity === 0) return;
    const pendingDocumentIds = manuals
      .map((manual) => manual.ragflowDocumentId)
      .filter((documentId) => {
        const run = runByDocumentId.get(documentId) ?? null;
        const isPending = run === 'UNSTART' || run === null;
        const cooldownUntil = this.recentlySubmitted.get(documentId) ?? 0;
        return isPending && cooldownUntil <= now;
      });

    const retryableFailedDocumentIds =
      this.failureRetryMaxAttempts > 0
        ? manuals
            .map((manual) => manual.ragflowDocumentId)
            .filter((documentId) => {
              if (!retryableFailureIds.has(documentId)) {
                return false;
              }

              const attempts = this.retryAttempts.get(documentId) ?? 0;
              if (attempts >= this.failureRetryMaxAttempts) {
                return false;
              }

              const cooldownUntil = this.recentlySubmitted.get(documentId) ?? 0;
              return cooldownUntil <= now;
            })
        : [];

    if (!pendingDocumentIds.length && !retryableFailedDocumentIds.length)
      return;

    const batch = [...pendingDocumentIds, ...retryableFailedDocumentIds].slice(
      0,
      Math.min(this.batchSize, capacity),
    );
    if (!batch.length) return;

    await this.ragflow.parseDocuments(datasetId, batch);

    batch.forEach((documentId) => {
      const cooldownUntil = retryableFailureIds.has(documentId)
        ? now + this.failureRetryCooldownMs
        : now + this.resubmitCooldownMs;
      this.recentlySubmitted.set(documentId, cooldownUntil);

      if (retryableFailureIds.has(documentId)) {
        this.retryAttempts.set(
          documentId,
          (this.retryAttempts.get(documentId) ?? 0) + 1,
        );
      }
    });

    this.logger.debug(
      `Queued manual parsing batch for ship ${shipId}: ${batch.length} document(s) started (running=${runningCount}, capacity=${capacity})`,
    );

    const retriedDocumentIds = batch.filter((documentId) =>
      retryableFailureIds.has(documentId),
    );
    if (retriedDocumentIds.length > 0) {
      this.logger.warn(
        `Retrying ${retriedDocumentIds.length} manual parse failure(s) for ship ${shipId} after known RAGFlow chunking error`,
      );
    }
  }

  private cleanupRetryAttempts(
    docs: Array<{ id: string; run: string; progress_msg: string }>,
  ): void {
    for (const doc of docs) {
      if (!this.isRetryableFailure(doc)) {
        this.retryAttempts.delete(doc.id);
      }
    }
  }

  private isRetryableFailure(doc: {
    run: string;
    progress_msg: string;
  }): boolean {
    if (doc.run !== 'FAIL') {
      return false;
    }

    const progress = doc.progress_msg?.trim().toLowerCase();
    if (!progress) {
      return false;
    }

    return this.retryableFailurePatterns.some((pattern) =>
      progress.includes(pattern),
    );
  }
}
