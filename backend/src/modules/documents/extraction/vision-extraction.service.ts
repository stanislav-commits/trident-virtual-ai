import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentsUploadStorageService } from '../ingestion/documents-upload-storage.service';
import { DocumentsRemoteIngestionDispatcherService } from '../ingestion/documents-remote-ingestion-dispatcher.service';

const execFileAsync = promisify(execFile);

/** 45 min: vision runs gpt-4o per page; big manuals take a while. */
const EXTRACTION_TIMEOUT_MS = 45 * 60 * 1000;

export type ExtractionStatus =
  | 'none'
  | 'pending'
  | 'running'
  | 'done'
  | 'failed';

/**
 * Bridge to the user's local vision extractor (~/Documents/trident-manuals):
 * copies the uploaded PDF into the extractor's 01-input, runs
 * `python -m trident run --vision --no-skip-existing --file <name>`, and
 * captures the produced markdown.
 *
 * Contract notes (verified against the extractor 2026-06-12):
 * - Output md lands in 02-work/vision-rebuild/md/<stem>.md, where stem may
 *   be an ENRICHED name (register matcher renames) — so we discover the
 *   md by mtime: any .md written after the run started is ours.
 * - --no-skip-existing makes the run deterministic even for already
 *   processed files: the per-page LLM cache turns a re-run into a cheap
 *   rewrite, and the rewrite bumps mtime so discovery always works.
 * - Jobs run strictly one at a time: the extractor keeps global state
 *   (register, cost tracker) that is not designed for concurrent runs.
 */
@Injectable()
export class VisionExtractionService {
  private readonly logger = new Logger(VisionExtractionService.name);
  /** Serializes extraction jobs. */
  private queueTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly uploadStorage: DocumentsUploadStorageService,
    private readonly remoteIngestionDispatcher: DocumentsRemoteIngestionDispatcherService,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.getExtractorDir());
  }

  private getExtractorDir(): string {
    return (
      this.configService.get<string>('integrations.visionExtractor.dir') ?? ''
    );
  }

  /**
   * Queue extraction for a document. The caller must have set
   * extractionStatus='pending' on the entity already (that is what gates
   * the remote-ingestion dispatcher). Resolves immediately; the job runs
   * in the background queue.
   */
  queue(documentId: string): void {
    this.queueTail = this.queueTail
      .then(() => this.runExtraction(documentId))
      .catch((error) => {
        this.logger.error(
          `Extraction job crashed for ${documentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  private async runExtraction(documentId: string): Promise<void> {
    const document = await this.documentsRepository.findOne({
      where: { id: documentId },
    });
    if (!document) return;

    const extractorDir = this.getExtractorDir();
    if (!extractorDir) {
      await this.markFailed(document, 'Vision extractor is not configured');
      return;
    }
    if (!this.uploadStorage.isLocalSpoolKey(document.storageKey)) {
      await this.markFailed(
        document,
        'Original upload is no longer in the local spool',
      );
      return;
    }

    document.extractionStatus = 'running';
    document.extractionError = null;
    await this.documentsRepository.save(document);
    this.logger.log(`Vision extraction started: ${document.originalFileName}`);

    try {
      const buffer = await this.uploadStorage.readUpload(document.storageKey!);

      // 1. Stage the PDF into the extractor's input folder. Keep the
      //    original filename (the extractor's register uses it), just made
      //    filesystem-safe.
      const safeName = document.originalFileName.replace(/[/\\:]/g, '_');
      const inputPath = path.join(extractorDir, '01-input', safeName);
      await fs.writeFile(inputPath, buffer);

      // 2. Run the pipeline for this one file.
      const startedAt = Date.now();
      const python = path.join(extractorDir, '.venv', 'bin', 'python');
      const fileFilter = safeName.replace(/\.pdf$/i, '');
      await execFileAsync(
        python,
        ['-m', 'trident', 'run', '--vision', '--no-skip-existing', '--file', fileFilter],
        {
          cwd: extractorDir,
          timeout: EXTRACTION_TIMEOUT_MS,
          maxBuffer: 32 * 1024 * 1024,
        },
      );

      // 3. Discover the produced markdown by mtime.
      const mdDir = path.join(extractorDir, '02-work', 'vision-rebuild', 'md');
      const entries = await fs.readdir(mdDir);
      let newest: { file: string; mtime: number } | null = null;
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const stat = await fs.stat(path.join(mdDir, entry));
        if (stat.mtimeMs >= startedAt - 2_000) {
          if (!newest || stat.mtimeMs > newest.mtime) {
            newest = { file: entry, mtime: stat.mtimeMs };
          }
        }
      }
      if (!newest) {
        throw new Error(
          'Extractor finished but produced no markdown (check 05-logs in the extractor project)',
        );
      }

      // Prefer rebuilding the markdown from the per-page result JSON so
      // every page carries an explicit "[Manual page N]" anchor — the AI
      // can then cite exact pages of the ORIGINAL PDF even though it only
      // reads the extract. Falls back to the assembled md when the JSON
      // is not found.
      const mdContent = Buffer.from(
        (await this.buildPaginatedMarkdown(extractorDir, startedAt)) ??
          (await fs.readFile(path.join(mdDir, newest.file), 'utf8')),
        'utf8',
      );

      // 4. Attach the markdown to the document in the local spool.
      const mdKey = await this.uploadStorage.saveExtractedMarkdown(
        document.id,
        mdContent,
      );

      document.extractedMdKey = mdKey;
      document.extractionStatus = 'done';
      document.extractionError = null;
      await this.documentsRepository.save(document);
      // Hand the document to RAGFlow right away (the dispatcher was
      // gating on the extraction; without this kick it waits for its
      // recovery interval).
      void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
      this.logger.log(
        `Vision extraction done: ${document.originalFileName} → ${newest.file} (${Math.round(
          (Date.now() - startedAt) / 1000,
        )}s)`,
      );
    } catch (error) {
      await this.markFailed(
        document,
        error instanceof Error ? error.message.slice(0, 1000) : String(error),
      );
    }
  }

  /**
   * Find the freshest VisionFileResult JSON from this run and join its
   * per-page markdown with page anchors. page_number is the printed page
   * of the ORIGINAL PDF — what the user needs to open it at the right
   * place.
   */
  private async buildPaginatedMarkdown(
    extractorDir: string,
    startedAtMs: number,
  ): Promise<string | null> {
    try {
      const stateDir = path.join(extractorDir, '02-work', 'vision-rebuild');
      const entries = await fs.readdir(stateDir);
      let newest: { file: string; mtime: number } | null = null;
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const stat = await fs.stat(path.join(stateDir, entry));
        if (stat.mtimeMs >= startedAtMs - 2_000) {
          if (!newest || stat.mtimeMs > newest.mtime) {
            newest = { file: entry, mtime: stat.mtimeMs };
          }
        }
      }
      if (!newest) return null;

      const raw = JSON.parse(
        await fs.readFile(path.join(stateDir, newest.file), 'utf8'),
      ) as {
        pages?: Array<{
          page_number?: number;
          status?: string;
          markdown?: string | null;
        }>;
      };
      const pages = (raw.pages ?? []).filter(
        (page) => page.status === 'ok' && page.markdown?.trim(),
      );
      if (!pages.length) return null;

      return pages
        .map((page) => {
          // Vision sometimes wraps output in ```markdown fences — strip.
          const body = page
            .markdown!.replace(/^\s*```(?:markdown)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim();
          return `[Manual page ${page.page_number}]\n\n${body}`;
        })
        .join('\n\n');
    } catch {
      return null;
    }
  }

  private async markFailed(
    document: DocumentEntity,
    message: string,
  ): Promise<void> {
    this.logger.warn(
      `Vision extraction failed for ${document.originalFileName}: ${message}`,
    );
    document.extractionStatus = 'failed';
    document.extractionError = message;
    await this.documentsRepository.save(document);
    // Failed extraction falls back to ingesting the original PDF so the
    // manual still becomes searchable.
    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
  }

  /** Admin-only raw markdown read. */
  async readExtractedMarkdown(document: DocumentEntity): Promise<string> {
    if (!document.extractedMdKey) {
      throw new Error('No extracted markdown for this document');
    }
    const buffer = await this.uploadStorage.readUpload(document.extractedMdKey);
    return buffer.toString('utf8');
  }
}
