import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';
import { DocumentsParseDispatcherService } from './documents-parse-dispatcher.service';
import { DocumentsParseStatusSyncService } from './documents-parse-status-sync.service';

const DEFAULT_PARSE_DRAIN_INTERVAL_MS = 15_000;

@Injectable()
export class DocumentsParseDrainService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DocumentsParseDrainService.name);
  private drainPromise: Promise<void> | null = null;
  private drainAgain = false;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly configService: ConfigService,
    private readonly parseDispatcher: DocumentsParseDispatcherService,
    private readonly parseStatusSync: DocumentsParseStatusSyncService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      return;
    }

    setTimeout(() => {
      void this.wake();
    }, 1_000).unref?.();
  }

  onApplicationShutdown(): void {
    this.clearDrainTimer();
  }

  wake(): void {
    if (!this.isEnabled()) {
      return;
    }

    if (this.drainPromise) {
      this.drainAgain = true;
      return;
    }

    this.scheduleDrain(0);
  }

  private scheduleDrain(delayMs: number): void {
    this.clearDrainTimer();

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, delayMs);
    this.drainTimer.unref?.();
  }

  private clearDrainTimer(): void {
    if (!this.drainTimer) {
      return;
    }

    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private async drain(): Promise<void> {
    if (this.drainPromise) {
      this.drainAgain = true;
      return this.drainPromise;
    }

    this.drainPromise = this.runDrainLoop();

    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  private async runDrainLoop(): Promise<void> {
    do {
      this.drainAgain = false;

      try {
        const hasRemainingWork = await this.drainOnce();

        if (hasRemainingWork) {
          this.scheduleDrain(this.getDrainIntervalMs());
        }
      } catch (error) {
        this.logger.warn(
          `Document parse drain failed: ${this.formatError(error)}`,
        );
        this.scheduleDrain(this.getDrainIntervalMs());
      }
    } while (this.drainAgain);
  }

  private async drainOnce(): Promise<boolean> {
    if (!(await this.hasActionableParseWork())) {
      return false;
    }

    await this.syncActiveParses();
    await this.parseDispatcher.dispatchPendingParses();

    return this.hasActionableParseWork();
  }

  private async syncActiveParses(): Promise<void> {
    const activeDocuments = await this.documentsRepository.find({
      where: {
        parseStatus: DocumentParseStatus.PARSING,
        ragflowDatasetId: Not(IsNull()),
        ragflowDocumentId: Not(IsNull()),
      },
      order: {
        updatedAt: 'ASC',
      },
    });

    for (const document of activeDocuments) {
      try {
        await this.parseStatusSync.syncRemoteParseStatus(document);
      } catch (error) {
        this.logger.warn(
          `Document parse status sync failed for ${document.id}: ${this.formatError(error)}`,
        );
      }
    }
  }

  private async hasActionableParseWork(): Promise<boolean> {
    const count = await this.documentsRepository.count({
      where: [
        {
          parseStatus: DocumentParseStatus.PARSING,
          ragflowDatasetId: Not(IsNull()),
          ragflowDocumentId: Not(IsNull()),
        },
        {
          parseStatus: DocumentParseStatus.PENDING_PARSE,
          ragflowDatasetId: Not(IsNull()),
          ragflowDocumentId: Not(IsNull()),
        },
      ],
    });

    return count > 0;
  }

  private isEnabled(): boolean {
    return this.configService.get<boolean>('documents.parseDrainEnabled', true);
  }

  private getDrainIntervalMs(): number {
    const configuredValue = this.configService.get<number>(
      'documents.parseDrainIntervalMs',
      DEFAULT_PARSE_DRAIN_INTERVAL_MS,
    );

    return Number.isInteger(configuredValue) && configuredValue > 0
      ? configuredValue
      : DEFAULT_PARSE_DRAIN_INTERVAL_MS;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
