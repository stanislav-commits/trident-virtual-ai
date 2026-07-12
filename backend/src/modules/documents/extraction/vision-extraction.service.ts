import { formatError } from '../../../common/utils/error.utils';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { LlmService } from '../../../integrations/llm/llm.service';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { AssetDocumentLinkEntity } from '../../assets/entities/asset-document-link.entity';
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
export class VisionExtractionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VisionExtractionService.name);
  /** Serializes extraction jobs. */
  private queueTail: Promise<void> = Promise.resolve();

  /**
   * The queue is in-memory, so a restart mid-extraction used to strand the
   * whole backlog: the interrupted doc stayed 'running' forever and every
   * 'pending' doc lost its queue slot (this stalled 151 docs on prod after
   * a deploy). On boot, re-queue the survivors: 'running' docs are reset to
   * 'pending' (their extractor run died with the process) and everything
   * pending re-enters the queue in upload order.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) return;
    const stranded = await this.documentsRepository.find({
      where: { extractionStatus: In(['pending', 'running']) },
      select: ['id', 'extractionStatus'],
      order: { createdAt: 'ASC' },
    });
    if (stranded.length === 0) return;
    const interrupted = stranded.filter(
      (d) => d.extractionStatus === 'running',
    );
    if (interrupted.length > 0) {
      await this.documentsRepository.update(
        { id: In(interrupted.map((d) => d.id)) },
        { extractionStatus: 'pending' },
      );
    }
    this.logger.log(
      `Re-queueing ${stranded.length} extraction(s) after restart (${interrupted.length} interrupted mid-run)`,
    );
    for (const doc of stranded) {
      this.queue(doc.id);
    }
  }

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly uploadStorage: DocumentsUploadStorageService,
    private readonly remoteIngestionDispatcher: DocumentsRemoteIngestionDispatcherService,
    @InjectRepository(AssetEntity)
    private readonly assetsRepository: Repository<AssetEntity>,
    @InjectRepository(AssetDocumentLinkEntity)
    private readonly assetDocLinkRepository: Repository<AssetDocumentLinkEntity>,
    private readonly llmService: LlmService,
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
            formatError(error)
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
    if (
      !this.uploadStorage.isLocalSpoolKey(document.storageKey) &&
      !this.uploadStorage.isObjectStorageKey(document.storageKey)
    ) {
      await this.markFailed(
        document,
        'Original upload is no longer available in storage',
      );
      return;
    }

    document.extractionStatus = 'running';
    document.extractionError = null;
    await this.documentsRepository.save(document);
    this.logger.log(`Vision extraction started: ${document.originalFileName}`);

    // Staged temp PDF in the extractor's 01-input — removed in `finally` so the
    // spool never grows. With the Spaces provider the original lives in object
    // storage (readUpload streams it here only for the extractor run), so this
    // temp is the only on-disk copy and must not persist.
    let stagedInputPath: string | null = null;
    try {
      const buffer = await this.uploadStorage.readUpload(document.storageKey!);

      // 1. Stage the PDF into the extractor's input folder. Keep the
      //    original filename (the extractor's register uses it), just made
      //    filesystem-safe.
      const safeName = document.originalFileName.replace(/[/\\:]/g, '_');
      stagedInputPath = path.join(extractorDir, '01-input', safeName);
      await fs.writeFile(stagedInputPath, buffer);

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
      // The extractor's enriched title (md filename stem) carries the
      // brand/model — keep it as the H1 of the paginated rebuild: the
      // identification LLM and retrieval both need it up top (page 1 of
      // many manuals is packaging/safety with no brand mention).
      const enrichedTitle = newest.file.replace(/\.md$/i, '');
      const paginated = await this.buildPaginatedMarkdown(
        extractorDir,
        startedAt,
      );
      const mdContent = Buffer.from(
        paginated
          ? `# ${enrichedTitle}\n\n${paginated}`
          : await fs.readFile(path.join(mdDir, newest.file), 'utf8'),
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

      // Batch flow: when the uploader did NOT pick an asset, identify the
      // equipment from the extract and match it against the asset
      // register — rename + link on a confident match, mark [UNLINKED]
      // otherwise. Runs BEFORE the RAGFlow handoff so the remote document
      // gets the final name. MANUALS ONLY: procedures/forms are general
      // knowledge-base documents that never bind to an asset.
      try {
        if (document.docClass === 'manual') {
          await this.matchDocumentToAssets(document, mdContent.toString('utf8'));
        }
      } catch (error) {
        this.logger.warn(
          `Asset auto-match failed for ${document.originalFileName}: ${
            formatError(error)
          }`,
        );
      }

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
    } finally {
      // Always remove the staged temp PDF — the original is in storage
      // (spool or Spaces) and RAGFlow gets the markdown. Never let 01-input
      // accumulate, even on a failed/aborted run.
      if (stagedInputPath) {
        await fs.rm(stagedInputPath, { force: true }).catch(() => undefined);
      }
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

  /**
   * Identify the equipment from the extract's opening pages and match it
   * against the asset register. Confident match = model AND brand both
   * agree with a register row. PS/SB twin units share one manual, so ALL
   * confident matches get a pinned link; the document name then uses the
   * register's brand+model plus the LLM's equipment description (side
   * suffixes like "— Port" would be wrong for a shared manual).
   */
  private async matchDocumentToAssets(
    document: DocumentEntity,
    markdown: string,
  ): Promise<void> {
    const alreadyLinked = await this.assetDocLinkRepository.findOne({
      where: { documentId: document.id, linkType: 'pinned' },
    });
    if (alreadyLinked) return; // uploader picked the asset explicitly

    const head = markdown.slice(0, 4000);
    const identified = await this.llmService.createJsonChatCompletion<{
      manufacturer?: string | null;
      equipment?: string | null;
      models?: (string | null)[] | null;
      series?: string | null;
    }>({
      systemPrompt:
        'You read the opening pages of a ship equipment manual and identify the equipment. ' +
        'Return raw JSON: {"manufacturer": string|null, "equipment": short noun phrase|null, ' +
        '"models": string[] (every model number this manual covers — may be one or many), ' +
        '"series": string|null (the shared family/series name if it covers several models, e.g. "EOZDJ", else null)}. ' +
        'manufacturer/models must be EXACT strings from the text, no guessing.',
      userPrompt: head,
      temperature: 0,
      maxTokens: 300,
    });

    const manufacturer = identified?.manufacturer?.trim() || null;
    const equipment = identified?.equipment?.trim() || null;
    const models = (identified?.models ?? [])
      .map((m) => (m ? String(m).trim() : ''))
      .filter(Boolean);
    const series = identified?.series?.trim() || null;

    // 1) RENAME — always, independent of linking. Multi-model manuals name by
    //    equipment + brand (+ shared series, or a single model when there's
    //    exactly one), never by an arbitrary one of several models.
    const ext = document.originalFileName.match(/\.[^.]+$/)?.[0] ?? '.pdf';
    const newName = this.buildDocName(manufacturer, equipment, models, series, ext);
    if (newName) document.originalFileName = newName;
    if (manufacturer && !document.manufacturer) {
      document.manufacturer = manufacturer;
    }
    if (models.length === 1 && !document.model) document.model = models[0];
    if (equipment && !document.equipmentName) document.equipmentName = equipment;

    // 2) LINK — separate concern. Skip if the uploader already pinned an asset;
    //    otherwise pin EVERY ship asset whose model matches ANY covered model
    //    (twin/sister units, or several models sharing one manual).
    let matches: AssetEntity[] = [];
    if (!alreadyLinked && manufacturer && models.length) {
      matches = await this.assetsRepository
        .createQueryBuilder('a')
        .where('a.ship_id = :shipId', { shipId: document.shipId })
        .andWhere('(a.brand ILIKE :mfr OR :mfrLike ILIKE a.brand)', {
          mfr: `%${manufacturer}%`,
          mfrLike: `%${manufacturer}%`,
        })
        .andWhere("a.model IS NOT NULL AND a.model <> ''")
        .andWhere(
          new Brackets((qb) => {
            models.forEach((m, i) => {
              qb.orWhere(
                `(a.model ILIKE :m${i} OR :m${i} ILIKE '%' || a.model || '%')`,
                { [`m${i}`]: `%${m}%` },
              );
            });
          }),
        )
        // Retired equipment must not collect new manuals.
        .andWhere("a.display_name NOT ILIKE '[DEPRECATED]%'")
        .limit(12)
        .getMany();
      for (const asset of matches) {
        await this.assetDocLinkRepository.save({
          assetId: asset.id,
          documentId: document.id,
          linkType: 'pinned',
          createdByUserId: null,
        });
      }
    }

    await this.documentsRepository.save(document);
    this.logger.log(
      `Identified "${document.originalFileName}" (${models.length} model(s)) — linked ${matches.length} asset(s)`,
    );
  }

  /**
   * Build a stable document name from the identified equipment. Single model →
   * "Brand Model — Equipment"; several models → "Brand <Series> — Equipment"
   * or just "Brand — Equipment" so a multi-model manual isn't mislabelled with
   * one arbitrary model. Returns null when nothing was confidently identified
   * (then the original filename is kept).
   */
  private buildDocName(
    manufacturer: string | null,
    equipment: string | null,
    models: string[],
    series: string | null,
    ext: string,
  ): string | null {
    if (!manufacturer && !equipment) return null;
    let head = manufacturer ?? '';
    if (models.length === 1) head = `${head} ${models[0]}`.trim();
    else if (models.length > 1 && series) head = `${head} ${series}`.trim();
    const desc = equipment || 'manual';
    const prefix = head ? `${head} — ` : '';
    return `${prefix}${desc}${ext}`;
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
