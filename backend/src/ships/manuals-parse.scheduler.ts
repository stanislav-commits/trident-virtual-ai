import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';

@Injectable()
export class ManualsParseScheduler {
  private readonly logger = new Logger(ManualsParseScheduler.name);
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

  private isDraining = false;
  private drainRequested = false;
  private readonly recentlySubmitted = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
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
        ragflowDocumentId: true,
      },
    });

    if (!manuals.length) return;

    const docs = await this.ragflow.listDocuments(
      datasetId,
      manuals.map((manual) => manual.ragflowDocumentId),
    );
    const runByDocumentId = new Map(docs.map((doc) => [doc.id, doc.run]));

    const runningCount = docs.filter((doc) => doc.run === 'RUNNING').length;
    const capacity = Math.max(0, this.maxRunningDocuments - runningCount);
    if (capacity === 0) return;

    const now = Date.now();
    const pendingDocumentIds = manuals
      .map((manual) => manual.ragflowDocumentId)
      .filter((documentId) => {
        const run = runByDocumentId.get(documentId) ?? null;
        const isPending = run === 'UNSTART' || run === null;
        const cooldownUntil = this.recentlySubmitted.get(documentId) ?? 0;
        return isPending && cooldownUntil <= now;
      });

    if (!pendingDocumentIds.length) return;

    const batch = pendingDocumentIds.slice(
      0,
      Math.min(this.batchSize, capacity),
    );
    if (!batch.length) return;

    await this.ragflow.parseDocuments(datasetId, batch);

    const cooldownUntil = now + this.resubmitCooldownMs;
    batch.forEach((documentId) => {
      this.recentlySubmitted.set(documentId, cooldownUntil);
    });

    this.logger.debug(
      `Queued manual parsing batch for ship ${shipId}: ${batch.length} document(s) started (running=${runningCount}, capacity=${capacity})`,
    );
  }
}
