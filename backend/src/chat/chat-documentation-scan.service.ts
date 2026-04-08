import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import {
  DEFAULT_SHIP_MANUAL_CATEGORY,
  parseShipManualCategory,
  type ShipManualCategory,
} from '../ships/manual-category';
import { ChatCitation } from './chat.types';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { type ChatDocumentSourceCategory } from './chat-query-planner.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';

interface DocumentScanManual {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  category: ShipManualCategory;
}

interface DocumentScanContext {
  ragflowDatasetId: string;
  manuals: DocumentScanManual[];
  score: number;
}

interface RagflowChunk {
  id: string;
  content: string;
  similarity?: number;
  meta?: Record<string, unknown>;
  positions?: unknown;
}

interface EnrichedChunk {
  chunk: RagflowChunk;
  rawContent: string;
  content: string;
  haystack: string;
  pageNumber?: number;
  minY?: number;
}

interface PdfPageTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface IntervalHeaderColumn {
  label: string;
  x: number;
  minY: number;
  maxY: number;
}

interface IntervalMaintenanceSnippet {
  heading?: string;
  intervalLabel: string;
  items: string[];
}

@Injectable()
export class ChatDocumentationScanService {
  private readonly logger = new Logger(ChatDocumentationScanService.name);
  private pdfJsModulePromise: Promise<any> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflowService: RagflowService,
    private readonly queryService: ChatDocumentationQueryService,
    private readonly referenceExtractionService: ChatReferenceExtractionService,
  ) {}

  async expandReferenceDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    const referenceIds = [
      ...new Set(
        (queryContext.match(/\b1p\d{2,}\b/gi) ?? []).map((match) =>
          match.toLowerCase(),
        ),
      ),
    ];
    if (referenceIds.length !== 1) return [];

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        `Reference document chunk scan skipped: no contexts available for ${referenceIds[0]}`,
      );
      return [];
    }

    const [referenceId] = referenceIds;
    const wantsProcedure =
      /\b(tasks?|included|include|procedure|steps?|checklist|replace|inspect|clean|check|adjust|overhaul|sample|test)\b/i.test(
        userQuery,
      );
    const wantsParts = this.queryService.isPartsQuery(userQuery);
    const wantsNextDue = this.queryService.isNextDueLookupQuery(userQuery);
    const relevancePattern = wantsParts
      ? /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|wear\s*kit|filter|impeller|belt|anode|coolant|pump|part#?)\b/i
      : wantsProcedure
        ? /\b(replace|inspect|clean|check|adjust|overhaul|sample|test|checklist|wear\s*kit|filter|impeller|belt|anode|coolant|pump)\b/i
        : wantsNextDue
          ? /\b(interval|last\s*due|next\s*due|reference\s*id|task\s*name|component\s*name)\b/i
          : /\b(component\s*name|task\s*name|responsible|interval|last\s*due|next\s*due|spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|replace|inspect|clean|check|adjust|overhaul|sample|test|wear\s*kit|filter|impeller|belt|anode|coolant|pump)\b/i;

    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForDocumentScan(
        scanContext.manuals,
        citations,
        { preferMaintenanceDocs: true },
      ).slice(0, 4);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );
          const enrichedChunks = chunks.map((chunk) => {
            const rawContent = this.trimSnippetBeforeForeignReference(
              chunk.content ?? '',
              referenceId,
            );
            const content = this.referenceExtractionService.focusReferenceSnippet(
              rawContent,
              referenceId,
            );
            return {
              chunk,
              rawContent,
              content,
              haystack: `${manual.filename}\n${content}`.toLowerCase(),
              pageNumber: this.extractChunkPageNumber(chunk),
              minY: this.extractChunkMinY(chunk.positions),
            };
          });

          const anchorChunks = enrichedChunks.filter((entry) =>
            entry.haystack.includes(referenceId),
          );
          if (anchorChunks.length === 0) continue;

          const bestAnchorChunk = [...anchorChunks].sort(
            (a, b) =>
              this.scoreReferenceAnchorChunk(referenceId, b) -
              this.scoreReferenceAnchorChunk(referenceId, a),
          )[0];
          const anchorPages =
            bestAnchorChunk.pageNumber !== undefined
              ? [bestAnchorChunk.pageNumber]
              : [
                  ...new Set(
                    anchorChunks
                      .map((entry) => entry.pageNumber)
                      .filter((page): page is number => page !== undefined),
                  ),
                ];

          const pageScopedChunks =
            anchorPages.length > 0
              ? enrichedChunks.filter(
                  (entry) =>
                    entry.pageNumber !== undefined &&
                    anchorPages.includes(entry.pageNumber),
                )
              : enrichedChunks;

          const sortedPageChunks = [...pageScopedChunks].sort((a, b) => {
            if (a.pageNumber !== undefined && b.pageNumber !== undefined) {
              if (a.pageNumber !== b.pageNumber) {
                return a.pageNumber - b.pageNumber;
              }
            }

            if (
              a.minY !== undefined &&
              b.minY !== undefined &&
              a.minY !== b.minY
            ) {
              return a.minY - b.minY;
            }

            const scoreA = a.haystack.includes(referenceId) ? 2 : 1;
            const scoreB = b.haystack.includes(referenceId) ? 2 : 1;
            if (scoreA !== scoreB) return scoreB - scoreA;

            return (b.chunk.similarity ?? 0) - (a.chunk.similarity ?? 0);
          });

          const sortedRelevantChunks = this.selectReferenceRelevantChunks(
            referenceId,
            sortedPageChunks,
            bestAnchorChunk,
            relevancePattern,
          );
          if (sortedRelevantChunks.length === 0) {
            continue;
          }

          this.logger.debug(
            `Reference chunk window ${referenceId}: anchor=${bestAnchorChunk.chunk.id}, page=${bestAnchorChunk.pageNumber ?? 'na'}, y=${bestAnchorChunk.minY ?? 'na'}, selected=${sortedRelevantChunks
              .map(
                (entry) =>
                  `${entry.chunk.id}@${entry.pageNumber ?? 'na'}:${entry.minY ?? 'na'}`,
              )
              .join(', ')}`,
          );

          const focusedSnippets = sortedRelevantChunks.map(
            (entry) => entry.content,
          );
          const rawSnippets = sortedRelevantChunks.map(
            (entry) => entry.rawContent,
          );
          let combinedSnippet =
            this.referenceExtractionService.buildReferenceCombinedSnippet(
              referenceId,
              focusedSnippets,
            );
          if (!combinedSnippet) {
            combinedSnippet =
              this.referenceExtractionService.buildReferenceCombinedSnippet(
                referenceId,
                rawSnippets,
              );
            if (combinedSnippet) {
              this.logger.debug(
                `Reference combined snippet ${referenceId}: recovered from raw chunk content`,
              );
            }
          }
          if (combinedSnippet) {
            this.logger.debug(
              `Reference combined snippet ${referenceId}: ${combinedSnippet
                .replace(/\s+/g, ' ')
                .slice(0, 320)}`,
            );
            collected.push({
              shipManualId: manual.id,
              chunkId: `ref-scan:${manual.id}:${referenceId}:${bestAnchorChunk.pageNumber ?? 'na'}`,
              score: 1.02,
              pageNumber: bestAnchorChunk.pageNumber,
              snippet: combinedSnippet,
              sourceTitle: manual.filename,
            });
          } else {
            this.logger.debug(
              `Reference combined snippet ${referenceId}: not reconstructed from selected window`,
            );
          }

          collected.push(
            ...sortedRelevantChunks.slice(0, 10).map((entry) =>
              this.mapDocumentChunkToCitation(
                manual,
                entry.chunk,
                entry.haystack.includes(referenceId) ? 1 : 0.95,
                entry.content,
              ),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Reference document chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    this.logger.debug(
      `Reference document chunk scan completed: ref=${referenceId}, contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  async expandMaintenanceAssetDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    const normalized = queryContext.toLowerCase();
    if (
      !(
        this.queryService.isNextDueLookupQuery(userQuery) ||
        this.queryService.isProcedureQuery(userQuery) ||
        this.queryService.isPartsQuery(userQuery) ||
        /\b(maintenance|service|tasks?|included)\b/i.test(userQuery)
      ) ||
      !/\b(generator|genset|main\s+generator)\b/i.test(normalized)
    ) {
      return [];
    }

    const directionalSide = this.queryService.detectDirectionalSide(normalized);
    if (!directionalSide) return [];

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        `Maintenance document chunk scan skipped: no contexts available for ${directionalSide} generator`,
      );
      return [];
    }

    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForDocumentScan(
        scanContext.manuals,
        citations,
        { preferMaintenanceDocs: true },
      ).slice(0, 4);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );

          const relevantChunks = chunks.filter((chunk) => {
            const scheduleSnippet =
              this.referenceExtractionService.extractGeneratorScheduleSnippet(
                chunk.content ?? '',
                directionalSide,
                queryContext,
              );
            if (!scheduleSnippet) {
              return false;
            }

            const haystack = `${manual.filename}\n${scheduleSnippet}`;
            return /\b(reference\s*id|last\s*due|next\s*due|interval|task\s*name|component\s*name|1p\d{2,})\b/i.test(
              haystack,
            );
          });

          collected.push(
            ...relevantChunks.map((chunk) =>
              this.mapDocumentChunkToCitation(
                manual,
                chunk,
                0.99,
                this.referenceExtractionService.extractGeneratorScheduleSnippet(
                  chunk.content ?? '',
                  directionalSide,
                  queryContext,
                ) ??
                  chunk.content ??
                  '',
              ),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Maintenance document chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    this.logger.debug(
      `Maintenance document chunk scan completed: side=${directionalSide}, contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  async expandManualIntervalMaintenanceChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    if (!this.queryService.isIntervalMaintenanceQuery(queryContext)) {
      return [];
    }

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        'Manual interval maintenance chunk scan skipped: no contexts available',
      );
      return [];
    }

    const intervalPhrases =
      this.queryService.extractMaintenanceIntervalSearchPhrases(queryContext);
    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForDocumentScan(
        scanContext.manuals,
        citations,
        { preferMaintenanceDocs: true },
      ).slice(0, 4);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );
          const scoredChunks = chunks
            .map((chunk) => {
              const score = this.scoreManualIntervalMaintenanceChunk(
                queryContext,
                manual.filename,
                chunk.content ?? '',
                intervalPhrases,
              );
              return {
                chunk,
                score,
                pageNumber: this.extractChunkPageNumber(chunk),
                minY: this.extractChunkMinY(chunk.positions),
              };
            })
            .filter((entry) => entry.score > 0)
            .sort((left, right) => {
              if (right.score !== left.score) {
                return right.score - left.score;
              }
              if (
                left.pageNumber !== undefined &&
                right.pageNumber !== undefined &&
                left.pageNumber !== right.pageNumber
              ) {
                return left.pageNumber - right.pageNumber;
              }
              if (
                left.minY !== undefined &&
                right.minY !== undefined &&
                left.minY !== right.minY
              ) {
                return left.minY - right.minY;
              }
              return left.chunk.id.localeCompare(right.chunk.id);
            });

          if (scoredChunks.length === 0) {
            continue;
          }

          const { bestChunk, selectedChunks, citationPageNumber } =
            this.selectBestIntervalMaintenancePageChunks(scoredChunks);

          const structuredSnippet =
            await this.buildStructuredIntervalMaintenanceSnippetFromPdfPage(
              scanContext.ragflowDatasetId,
              manual,
              citationPageNumber,
              queryContext,
              intervalPhrases,
            );
          const combinedSnippet =
            structuredSnippet ??
            this.buildCombinedChunkSnippet(
              selectedChunks.map((entry) => entry.chunk.content ?? ''),
            );

          if (structuredSnippet) {
            this.logger.debug(
              `Manual interval maintenance snippet reconstructed from PDF page ${citationPageNumber} for ${manual.filename}`,
            );
          }

          collected.push({
            shipManualId: manual.id,
            chunkId: `manual-interval-scan:${manual.id}:${citationPageNumber ?? bestChunk.chunk.id}`,
            score: Math.max(bestChunk.score, 1.03),
            pageNumber: citationPageNumber,
            snippet: combinedSnippet,
            sourceTitle: manual.filename,
            sourceCategory: manual.category,
          });

          collected.push(
            ...selectedChunks.slice(0, 3).map((entry) =>
              this.mapDocumentChunkToCitation(
                manual,
                entry.chunk,
                Math.max(0.92, entry.score / 100),
              ),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Manual interval maintenance chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    this.logger.debug(
      `Manual interval maintenance chunk scan completed: contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  async expandCertificateExpiryDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    if (!this.isBroadCertificateSoonQuery(queryContext)) {
      return [];
    }

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        'Certificate document chunk scan skipped: no contexts available',
      );
      return [];
    }

    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this
        .selectCandidateManualsForCertificateScan(scanContext.manuals, citations)
        .slice(0, 16);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );

          const relevantChunks = chunks
            .map((chunk) => {
              const content = chunk.content ?? '';
              const haystack = `${manual.filename}\n${content}`.toLowerCase();
              const expiries = this.extractExplicitCertificateExpiryTimestamps(
                content,
              );
              return {
                chunk,
                content,
                haystack,
                expiries,
              };
            })
            .filter(
              (entry) =>
                /\b(valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|will\s+expire\s+on|scadenza)\b/i.test(
                  entry.haystack,
                ) &&
                (this.isLikelyStandaloneCertificateManual(manual.filename) ||
                  this.hasStrongCertificateSnippetSignals(entry.haystack)),
            )
            .sort((left, right) => {
              const leftFuture =
                left.expiries.some((expiry) => expiry >= Date.now()) ? 1 : 0;
              const rightFuture =
                right.expiries.some((expiry) => expiry >= Date.now()) ? 1 : 0;
              if (rightFuture !== leftFuture) {
                return rightFuture - leftFuture;
              }

              const leftSoonest =
                left.expiries.find((expiry) => expiry >= Date.now()) ??
                left.expiries[0] ??
                Number.MAX_SAFE_INTEGER;
              const rightSoonest =
                right.expiries.find((expiry) => expiry >= Date.now()) ??
                right.expiries[0] ??
                Number.MAX_SAFE_INTEGER;
              if (leftSoonest !== rightSoonest) {
                return leftSoonest - rightSoonest;
              }

              return (right.chunk.similarity ?? 0) - (left.chunk.similarity ?? 0);
            })
            .slice(0, 3);

          collected.push(
            ...relevantChunks.map((entry) =>
              this.mapDocumentChunkToCitation(
                manual,
                entry.chunk,
                1.01,
                entry.content,
                'CERTIFICATES',
              ),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Certificate document chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const futureCollectedCount = collected.filter((citation) =>
          this.extractExplicitCertificateExpiryTimestamps(citation.snippet ?? '').some(
            (expiry) => expiry >= Date.now(),
          ),
        ).length;
        if (futureCollectedCount >= 5) {
          break;
        }
      }
    }

    this.logger.debug(
      `Certificate document chunk scan completed: contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  async expandPersonnelDirectoryDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    if (!this.queryService.isPersonnelDirectoryQuery(queryContext)) {
      return [];
    }

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        'Personnel directory document chunk scan skipped: no contexts available',
      );
      return [];
    }

    const anchorTerms = this.queryService.extractContactAnchorTerms(queryContext);
    const wantsRoleInventory = this.queryService.isRoleInventoryQuery(queryContext);
    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForContactScan(
        scanContext.manuals,
        citations,
      ).slice(0, 6);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );

          const relevantChunks = chunks
            .filter((chunk) => {
              const content = (chunk.content ?? '').replace(/\s+/g, ' ').trim();
              if (!content) {
                return false;
              }
              return this.isLikelyPersonnelDirectoryChunk(
                manual.filename,
                content,
                anchorTerms,
                wantsRoleInventory,
              );
            })
            .slice(0, 12);

          collected.push(
            ...relevantChunks.map((chunk) =>
              this.mapDocumentChunkToCitation(manual, chunk, 1.0),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Personnel directory document chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    this.logger.debug(
      `Personnel directory document chunk scan completed: contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  async expandTankCapacityDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    if (!this.queryService.isTankCapacityLookupQuery(queryContext)) {
      return [];
    }

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        'Tank capacity document chunk scan skipped: no contexts available',
      );
      return [];
    }

    const requiresFuel = /\bfuel\b/i.test(queryContext);
    const requiresWater = /\bwater\b/i.test(queryContext);
    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForTankCapacityScan(
        scanContext.manuals,
        citations,
      ).slice(0, 8);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );

          const relevantChunks = chunks
            .filter((chunk) => {
              const content = (chunk.content ?? '').replace(/\s+/g, ' ').trim();
              return this.isRelevantTankCapacityChunk(
                manual.filename,
                content,
                requiresFuel,
                requiresWater,
              );
            })
            .slice(0, 16);

          collected.push(
            ...relevantChunks.map((chunk) =>
              this.mapDocumentChunkToCitation(manual, chunk, 1.0),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Tank capacity document chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (collected.length === 0) {
        collected.push(
          ...(await this.collectTankCapacitySearchFallbackCitations(
            scanContext,
            queryContext,
            requiresFuel,
            requiresWater,
          )),
        );
      }
    }

    this.logger.debug(
      `Tank capacity document chunk scan completed: contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  async expandAuditChecklistDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    if (!this.queryService.isAuditChecklistLookupQuery(queryContext)) {
      return [];
    }

    const scanContexts = await this.loadDocumentScanContexts(
      shipId,
      citations,
      allowedDocumentCategories,
      allowedManualIds,
    );
    if (scanContexts.length === 0) {
      this.logger.debug(
        'Audit checklist document chunk scan skipped: no contexts available',
      );
      return [];
    }

    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForAuditScan(
        scanContext.manuals,
        citations,
      ).slice(0, 8);
      scannedManualCount += candidateManuals.length;

      for (const manual of candidateManuals) {
        try {
          const chunks = await this.ragflowService.listDocumentChunks(
            scanContext.ragflowDatasetId,
            manual.ragflowDocumentId,
            300,
          );

          const relevantChunks = chunks
            .filter((chunk) => {
              const content = (chunk.content ?? '').replace(/\s+/g, ' ').trim();
              if (!content) {
                return false;
              }

              const haystack = `${manual.filename}\n${content}`.toLowerCase();
              if (!/\b(audit|compliance|inspection|survey|checklist)\b/i.test(haystack)) {
                return false;
              }
              
              if (
                !/\b(pass|fail|finding|status|ok|yes|no|defect|corrective\s+action|signature|date|checked)\b/i.test(
                  haystack,
                ) &&
                !/\b(item|point|question)\b/i.test(haystack)
              ) {
                return false;
              }

              return true;
            })
            .slice(0, 16);

          collected.push(
            ...relevantChunks.map((chunk) =>
              this.mapDocumentChunkToCitation(manual, chunk, 1.0),
            ),
          );
        } catch (error) {
          this.logger.warn(
            `Audit checklist document chunk scan skipped for ${manual.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    this.logger.debug(
      `Audit checklist document chunk scan completed: contexts=${scanContexts.length}, manuals=${scannedManualCount}, collected=${collected.length}`,
    );

    return collected;
  }

  private async loadDocumentScanContexts(
    shipId: string | null,
    citations: ChatCitation[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<DocumentScanContext[]> {
    const contexts: DocumentScanContext[] = [];
    const allowedManualIdSet =
      allowedManualIds && allowedManualIds.length > 0
        ? new Set(allowedManualIds)
        : null;

    if (shipId) {
      const ship = await this.prisma.ship.findUnique({
        where: { id: shipId },
        select: {
          ragflowDatasetId: true,
          manuals: {
            select: {
              id: true,
              ragflowDocumentId: true,
              filename: true,
              category: true,
            },
          },
        },
      });

      const shipManuals = ship
        ? this.filterScanManualsByAllowedCategories(
            ship.manuals,
            allowedDocumentCategories,
            allowedManualIdSet,
          )
        : [];

      if (ship?.ragflowDatasetId && shipManuals.length > 0) {
        contexts.push({
          ragflowDatasetId: ship.ragflowDatasetId,
          manuals: shipManuals,
          score: Number.MAX_SAFE_INTEGER,
        });
      }
    }

    const citedManualIds = new Set(
      citations
        .map((citation) => citation.shipManualId)
        .filter((manualId): manualId is string => Boolean(manualId)),
    );
    const normalizedSourceHints = [
      ...new Set(
        citations
          .map((citation) =>
            this.queryService.normalizeSourceTitleHint(citation.sourceTitle),
          )
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase()),
      ),
    ];

    if (citedManualIds.size === 0 && normalizedSourceHints.length === 0) {
      return contexts;
    }

    const ships = await this.prisma.ship.findMany({
      where: { ragflowDatasetId: { not: null } },
      select: {
        ragflowDatasetId: true,
        manuals: {
          select: {
            id: true,
            ragflowDocumentId: true,
            filename: true,
            category: true,
          },
        },
      },
    });

    for (const ship of ships) {
      if (!ship.ragflowDatasetId) continue;

      const manuals = this.filterScanManualsByAllowedCategories(
        ship.manuals,
        allowedDocumentCategories,
        allowedManualIdSet,
      );
      if (manuals.length === 0) continue;

      const score = this.scoreDocumentScanContext(
        manuals,
        citedManualIds,
        normalizedSourceHints,
      );
      if (score <= 0) continue;

      if (
        contexts.some(
          (context) => context.ragflowDatasetId === ship.ragflowDatasetId,
        )
      ) {
        continue;
      }

      contexts.push({
        ragflowDatasetId: ship.ragflowDatasetId,
        manuals,
        score,
      });
    }

    return contexts.sort((a, b) => b.score - a.score).slice(0, 4);
  }

  private filterScanManualsByAllowedCategories(
    manuals: Array<{
      id: string;
      ragflowDocumentId: string | null;
      filename: string;
      category?: string | null;
    }>,
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: Set<string> | null,
  ): DocumentScanManual[] {
    const allowedCategories =
      allowedDocumentCategories && allowedDocumentCategories.length > 0
        ? new Set(allowedDocumentCategories)
        : null;

    return manuals
      .map((manual) => {
        if (!manual.ragflowDocumentId) {
          return null;
        }
        if (allowedManualIds && !allowedManualIds.has(manual.id)) {
          return null;
        }

        const category = this.normalizeDocumentCategory(manual.category);
        if (allowedCategories && !allowedCategories.has(category)) {
          return null;
        }

        return {
          id: manual.id,
          ragflowDocumentId: manual.ragflowDocumentId,
          filename: manual.filename,
          category,
        };
      })
      .filter((manual): manual is DocumentScanManual => Boolean(manual));
  }

  private normalizeDocumentCategory(
    category?: string | null,
  ): ShipManualCategory {
    return (
      parseShipManualCategory(category) ?? DEFAULT_SHIP_MANUAL_CATEGORY
    );
  }

  private scoreDocumentScanContext(
    manuals: DocumentScanManual[],
    citedManualIds: Set<string>,
    normalizedSourceHints: string[],
  ): number {
    const shouldFilterBySource = normalizedSourceHints.length > 0;
    const sourceMatches = manuals.reduce((count, manual) => {
      if (citedManualIds.has(manual.id)) return count + 2;

      const normalizedFilename = this.queryService.normalizeSourceTitleHint(
        manual.filename,
      );
      if (
        normalizedFilename &&
        normalizedSourceHints.includes(normalizedFilename.toLowerCase())
      ) {
        return count + 2;
      }

      if (
        normalizedFilename &&
        normalizedSourceHints.some((hint) =>
          normalizedFilename.toLowerCase().includes(hint),
        )
      ) {
        return count + 1;
      }

      return count;
    }, 0);

    if (shouldFilterBySource) {
      return sourceMatches * 10;
    }

    return manuals.some((manual) =>
      /\b(maintenance|tasks?|schedule|service|spare|parts?)\b/i.test(
        manual.filename,
      ),
    )
      ? 1
      : 0;
  }

  private selectCandidateManualsForDocumentScan(
    manuals: DocumentScanManual[],
    citations: ChatCitation[],
    options?: { preferMaintenanceDocs?: boolean },
  ): DocumentScanManual[] {
    const citedManualIds = new Set(
      citations
        .map((citation) => citation.shipManualId)
        .filter((manualId): manualId is string => Boolean(manualId)),
    );
    const citedSourceHints = new Set(
      citations
        .map((citation) =>
          this.queryService.normalizeSourceTitleHint(citation.sourceTitle),
        )
        .filter((hint): hint is string => Boolean(hint))
        .map((hint) => hint.toLowerCase()),
    );

    const citedManuals = manuals.filter((manual) => {
      if (citedManualIds.has(manual.id)) return true;
      const normalizedFilename = this.queryService.normalizeSourceTitleHint(
        manual.filename,
      );
      return normalizedFilename
        ? citedSourceHints.has(normalizedFilename.toLowerCase())
        : false;
    });

    const maintenanceManuals = manuals.filter((manual) =>
      /\b(maintenance|tasks?|schedule|service|spare|parts?)\b/i.test(
        manual.filename,
      ),
    );

    const ordered = options?.preferMaintenanceDocs
      ? [...citedManuals, ...maintenanceManuals, ...manuals]
      : [...citedManuals, ...manuals];

    const seen = new Set<string>();
    return ordered.filter((manual) => {
      const key = `${manual.id}::${manual.ragflowDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private selectCandidateManualsForCertificateScan(
    manuals: DocumentScanManual[],
    citations: ChatCitation[],
  ): DocumentScanManual[] {
    const baseOrdered = this.selectCandidateManualsForDocumentScan(
      manuals,
      citations,
    );
    const standaloneCertificateLike = baseOrdered
      .filter((manual) =>
        this.isLikelyStandaloneCertificateManual(manual.filename),
      )
      .sort((left, right) => {
        const leftScore = this.scoreCertificateScanManual(left.filename);
        const rightScore = this.scoreCertificateScanManual(right.filename);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }

        return (
          baseOrdered.findIndex((manual) => manual.id === left.id) -
          baseOrdered.findIndex((manual) => manual.id === right.id)
        );
      });
    if (standaloneCertificateLike.length > 0) {
      return standaloneCertificateLike;
    }

    const certificateLike = baseOrdered
      .filter((manual) =>
        this.isCertificateScanCandidateManual(manual.filename),
      )
      .sort((left, right) => {
        const leftScore = this.scoreCertificateScanManual(left.filename);
        const rightScore = this.scoreCertificateScanManual(right.filename);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }

        return (
          baseOrdered.findIndex((manual) => manual.id === left.id) -
          baseOrdered.findIndex((manual) => manual.id === right.id)
        );
      });
    const ordered = certificateLike.length > 0 ? certificateLike : baseOrdered;
    const seen = new Set<string>();

    return ordered.filter((manual) => {
      const key = `${manual.id}::${manual.ragflowDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private selectCandidateManualsForContactScan(
    manuals: DocumentScanManual[],
    citations: ChatCitation[],
  ): DocumentScanManual[] {
    const baseOrdered = this.selectCandidateManualsForDocumentScan(
      manuals,
      citations,
    );
    const contactLike = baseOrdered
      .filter((manual) => this.isContactScanCandidateManual(manual.filename))
      .sort((left, right) => {
        const leftScore = this.scoreContactScanManual(left.filename);
        const rightScore = this.scoreContactScanManual(right.filename);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }

        return (
          baseOrdered.findIndex((manual) => manual.id === left.id) -
          baseOrdered.findIndex((manual) => manual.id === right.id)
        );
      });
    const ordered = contactLike.length > 0 ? contactLike : baseOrdered;
    const seen = new Set<string>();

    return ordered.filter((manual) => {
      const key = `${manual.id}::${manual.ragflowDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private selectCandidateManualsForTankCapacityScan(
    manuals: DocumentScanManual[],
    citations: ChatCitation[],
  ): DocumentScanManual[] {
    const baseOrdered = this.selectCandidateManualsForDocumentScan(
      manuals,
      citations,
    );
    const tankLike = baseOrdered
      .filter((manual) => this.isTankCapacityScanCandidateManual(manual.filename))
      .sort((left, right) => {
        const leftScore = this.scoreTankCapacityScanManual(left.filename);
        const rightScore = this.scoreTankCapacityScanManual(right.filename);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }

        return (
          baseOrdered.findIndex((manual) => manual.id === left.id) -
          baseOrdered.findIndex((manual) => manual.id === right.id)
        );
      });
    const ordered = tankLike.length > 0 ? tankLike : baseOrdered;
    const seen = new Set<string>();

    return ordered.filter((manual) => {
      const key = `${manual.id}::${manual.ragflowDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async collectTankCapacitySearchFallbackCitations(
    scanContext: DocumentScanContext,
    queryContext: string,
    requiresFuel: boolean,
    requiresWater: boolean,
  ): Promise<ChatCitation[]> {
    const manualByDocumentId = new Map(
      scanContext.manuals.map((manual) => [manual.ragflowDocumentId, manual]),
    );

    for (const query of this.buildTankCapacityFallbackQueries(
      queryContext,
      requiresFuel,
      requiresWater,
    )) {
      try {
        const results = await this.ragflowService.searchDataset(
          scanContext.ragflowDatasetId,
          query,
          18,
        );
        const matched = results
          .map((result) => {
            const manual = manualByDocumentId.get(result.doc_id);
            if (!manual) {
              return null;
            }

            const content = (result.content ?? '').replace(/\s+/g, ' ').trim();
            if (
              !this.isRelevantTankCapacityChunk(
                manual.filename,
                content,
                requiresFuel,
                requiresWater,
              )
            ) {
              return null;
            }

            return this.mapDocumentChunkToCitation(
              manual,
              {
                id: result.id,
                content: result.content,
                similarity: result.similarity,
                meta: result.meta,
                positions: result.positions,
              },
              1.02,
            );
          })
          .filter((citation): citation is ChatCitation => Boolean(citation));

        if (matched.length > 0) {
          this.logger.debug(
            `Tank capacity search fallback matched ${matched.length} chunk(s) for query="${query}"`,
          );
          return matched;
        }
      } catch (error) {
        this.logger.warn(
          `Tank capacity search fallback failed for query="${query}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return [];
  }

  private buildTankCapacityFallbackQueries(
    queryContext: string,
    requiresFuel: boolean,
    requiresWater: boolean,
  ): string[] {
    const queries = new Set<string>();
    const normalizedQuery = queryContext.replace(/\s+/g, ' ').trim();
    if (normalizedQuery) {
      queries.add(normalizedQuery);
    }

    queries.add('list of tank capacities');
    queries.add('tank capacity table');

    if (requiresFuel) {
      queries.add('fuel tank capacity');
      queries.add('fuel tank sounding table');
      queries.add('fuel oil tanks capacity');
    } else if (requiresWater) {
      queries.add('fresh water tank capacity');
      queries.add('water tank capacity table');
    }

    return [...queries];
  }

  private selectCandidateManualsForAuditScan(
    manuals: DocumentScanManual[],
    citations: ChatCitation[],
  ): DocumentScanManual[] {
    const baseOrdered = this.selectCandidateManualsForDocumentScan(
      manuals,
      citations,
    );
    const auditLike = baseOrdered
      .filter((manual) => this.isAuditScanCandidateManual(manual.filename))
      .sort((left, right) => {
        const leftScore = this.scoreAuditScanManual(left.filename);
        const rightScore = this.scoreAuditScanManual(right.filename);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }

        return (
          baseOrdered.findIndex((manual) => manual.id === left.id) -
          baseOrdered.findIndex((manual) => manual.id === right.id)
        );
      });
    const ordered = [...auditLike, ...baseOrdered];
    const seen = new Set<string>();

    return ordered.filter((manual) => {
      const key = `${manual.id}::${manual.ragflowDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private scoreContactScanManual(filename: string): number {
    const normalized = filename.toLowerCase();
    let score = 0;

    if (/\bcontact\s+details\b/.test(normalized)) {
      score += 60;
    }
    if (/\b(company\s+contact|contact|directory|phone|email)\b/.test(normalized)) {
      score += 30;
    }
    if (/\b(crew\s+list|emergency\s+contact)\b/.test(normalized)) {
      score += 10;
    }
    if (
      /\b(manual|guide|guidelines|handbook|instruction|procedure|schedule|history)\b/.test(
        normalized,
      )
    ) {
      score -= 20;
    }

    return score;
  }

  private isContactScanCandidateManual(filename: string): boolean {
    return /\b(contact|directory|phone|email|crew\s+list)\b/i.test(filename);
  }

  private isLikelyPersonnelDirectoryChunk(
    filename: string,
    content: string,
    anchorTerms: string[],
    wantsRoleInventory: boolean,
  ): boolean {
    const haystack = `${filename}\n${content}`.toLowerCase();
    const emailMatches =
      content.match(/\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/gi) ??
      [];
    const phoneMatches =
      content.match(/\+\s*\d[\d\s()./-]{5,}\d\b/g) ?? [];
    const personLikeMatches =
      content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) ?? [];
    const hasDirectoryTitle =
      /\b(contact\s+details|contact\s+list|company\s+contact|directory|crew\s+list|emergency\s+contact)\b/i.test(
        haystack,
      );
    const hasDenseDirectoryStructure =
      emailMatches.length >= 2 ||
      phoneMatches.length >= 2 ||
      (emailMatches.length >= 1 && personLikeMatches.length >= 2);
    const hasStrongRoleSignals =
      /\b(fleet\s+manager|technical\s+manager|operations\s+director|commercial\s+director|director|dpa|cso|manager)\b/i.test(
        haystack,
      ) &&
      (emailMatches.length >= 1 || phoneMatches.length >= 1);
    const hasOperationalNoise =
      /\b(ntvrp|response\s+plan|qualified\s+individual|checklist|appendix|national\s+response\s+center|oil\s+spill|figure\s+\d|section\s+\d|owner\/operator|charterer|port\s+agents?)\b/i.test(
        haystack,
      );

    if (!(hasDirectoryTitle || hasDenseDirectoryStructure || hasStrongRoleSignals)) {
      return false;
    }

    if (hasOperationalNoise && !(hasDirectoryTitle || hasDenseDirectoryStructure)) {
      return false;
    }

    if (wantsRoleInventory || anchorTerms.length === 0) {
      return true;
    }

    return anchorTerms.some((term) => haystack.includes(term));
  }

  private scoreTankCapacityScanManual(filename: string): number {
    const normalized = filename.toLowerCase();
    let score = 0;

    if (/\b(tank|tanks|sounding)\b/.test(normalized)) {
      score += 40;
    }
    if (/\b(capacity|capacities|table|tables)\b/.test(normalized)) {
      score += 30;
    }
    if (/\b(fuel|diesel|water|waste|holding)\b/.test(normalized)) {
      score += 20;
    }
    if (
      /\b(manual|guide|guidelines|handbook|instruction|procedure|schedule|history)\b/.test(
        normalized,
      )
    ) {
      score -= 10;
    }

    return score;
  }

  private isTankCapacityScanCandidateManual(filename: string): boolean {
    return /\b(tank|tanks|sounding|capacity|capacities)\b/i.test(filename);
  }

  private isRelevantTankCapacityChunk(
    filename: string,
    content: string,
    requiresFuel: boolean,
    requiresWater: boolean,
  ): boolean {
    if (!content) {
      return false;
    }

    const haystack = `${filename}\n${content}`.toLowerCase();
    if (!/\btank\b/i.test(haystack)) {
      return false;
    }
    if (!this.containsTankCapacityLikeRow(content)) {
      return false;
    }
    if (
      requiresFuel &&
      !/\b(fuel|fueloil|fuel\s+oil|diesel)\b/i.test(haystack)
    ) {
      return false;
    }
    if (
      requiresWater &&
      !/\b(fresh\s*water|freshwater|water)\b/i.test(haystack)
    ) {
      return false;
    }

    return true;
  }

  private containsTankCapacityLikeRow(text: string): boolean {
    if (
      /\b((?:(?:fuel|diesel|day|service|settling|storage|fresh\s*water|water|grey|gray|black|waste|holding)\s+)?tank(?:\s+[a-z0-9./-]{1,12}){0,2})(?:\s+(?:capacity|cap\.?|volume))?\s*[:=-]?\s*(\d[\d, .]*\s*(?:l|liters?|litres?|m3|m³|gal|gallons?))\b/i.test(
        text,
      )
    ) {
      return true;
    }

    const normalized = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hasTableHeader =
      /\b(list\s+of\s+tank\s+capacities|tank\s+capacities|fuel\s*oil\s*tanks?|fresh\s*water|capacity\s*\((?:it|lt|l|liter|litre|m3|m³|gal|gallons?)\))\b/i.test(
        normalized,
      );
    const hasStructuredRow =
      /<tr>\s*<t[dh][^>]*>\s*[^<]+<\/t[dh]>\s*<t[dh][^>]*>\s*[^<]*tank[^<]*<\/t[dh]>[\s\S]{0,140}?<t[dh][^>]*>\s*\d[\d,. ]*\s*<\/t[dh]>/i.test(
        text,
      ) ||
      /\b(?:fo|fw|do|co)\d{1,2}[./-]?\s*(?:ps|stbd|sb|p|s)?\b[\s\S]{0,80}\btank\b[\s\S]{0,60}\b\d[\d,. ]{2,}\b/i.test(
        normalized,
      );

    return hasTableHeader && hasStructuredRow;
  }

  private scoreAuditScanManual(filename: string): number {
    const normalized = filename.toLowerCase();
    let score = 0;

    if (/\b(audit|compliance|survey|inspection)\b/.test(normalized)) {
      score += 40;
    }
    if (/\b(checklist|checklists|report|defect)\b/.test(normalized)) {
      score += 30;
    }
    if (/\b(manual|guide|guidelines|handbook|instruction)\b/.test(normalized)) {
      score -= 10;
    }

    return score;
  }

  private isAuditScanCandidateManual(filename: string): boolean {
    return /\b(audit|audits|compliance|survey|surveys|inspection|inspections|checklist|checklists)\b/i.test(filename);
  }

  private scoreCertificateScanManual(filename: string): number {
    const normalized = filename.toLowerCase();
    let score = 0;

    if (
      /\b(certificate|certificato|approval|license|licence|class|solas|med|iopp|load\s*line|loadline|radio|mlc|declaration)\b/.test(
        normalized,
      )
    ) {
      score += 50;
    }

    if (
      /\b(product\s+design\s+assessment|manufacturing\s+assessment|type\s+approval|module\s+[a-z]|fire|suppression|liferaft|life\s*raft|safety|pollution|commercial|approval|license|licence)\b/.test(
        normalized,
      )
    ) {
      score += 30;
    }

    if (/\bsurvey\b/.test(normalized) && !/\bguidelines?\b/.test(normalized)) {
      score += 10;
    }

    if (/\b(registry|cor\b|certificate\s+of\s+registry)\b/.test(normalized)) {
      score -= 40;
    }

    if (/\bprivate\b/.test(normalized)) {
      score -= 10;
    }

    if (
      /\b(manual|guide|guidelines|handbook|instruction|report|record|history|details|administration|checklist|list)\b/.test(
        normalized,
      )
    ) {
      score -= 35;
    }

    return score;
  }

  private isCertificateScanCandidateManual(filename: string): boolean {
    const normalized = filename.toLowerCase();
    if (
      /\b(certificate|certificato|approval|license|licence|registry|cor\b|declaration|class|solas|med|iopp|load\s*line|loadline|radio|mlc)\b/.test(
        normalized,
      )
    ) {
      return true;
    }

    return /\bsurvey\b/.test(normalized) && !/\bguidelines?\b/.test(normalized);
  }

  private isLikelyStandaloneCertificateManual(filename: string): boolean {
    const normalized = filename.toLowerCase();
    if (
      /\b(manual|guide|guidelines|handbook|instruction|report|record|history|details|administration|checklist|list)\b/.test(
        normalized,
      )
    ) {
      return false;
    }

    return /\b(certificate|certificato|approval|license|licence|registry|cor\b|declaration|class|solas|med|survey|iopp|load\s*line|loadline|radio|mlc)\b/.test(
      normalized,
    );
  }

  private hasStrongCertificateSnippetSignals(text: string): boolean {
    return /\b(this\s+certificate|certificate\s+no\.?|certificateof|certificate\s+of|ec\s+type-?examination|type\s+approval|product\s+design\s+assessment|manufacturing\s+assessment|declaration\s+of\s+conformity|radio\s+station\s+communication\s+license|issued\s+under\s+the\s+authority|certificato\s+mod\.?|module\s+[a-z])\b/i.test(
      text,
    );
  }

  private mapDocumentChunkToCitation(
    manual: Pick<DocumentScanManual, 'id' | 'filename' | 'category'>,
    chunk: RagflowChunk,
    fallbackScore: number,
    snippetOverride?: string,
    sourceCategory?: string,
  ): ChatCitation {
    return {
      shipManualId: manual.id,
      chunkId: chunk.id,
      score: chunk.similarity ?? fallbackScore,
      pageNumber: this.extractChunkPageNumber(chunk),
      snippet: snippetOverride ?? chunk.content ?? '',
      sourceTitle: manual.filename,
      sourceCategory: sourceCategory ?? manual.category,
      sourceMetadataCategory: this.extractChunkMetadataValue(
        chunk,
        'category',
      ),
      sourceMetadataCategoryLabel: this.extractChunkMetadataValue(
        chunk,
        'category_label',
      ),
    };
  }

  private scoreManualIntervalMaintenanceChunk(
    query: string,
    filename: string,
    content: string,
    intervalPhrases: string[],
  ): number {
    const haystack = `${filename}\n${content}`.toLowerCase();
    const hasMaintenanceTerms =
      /\b(mainten[a-z]*|service|periodic|inspection|checks?|tasks?|schedule)\b/i.test(
        haystack,
      );
    const hasActionTerms =
      /\b(replace|inspect|check|clean|change|verify|adjust|test|sample|drain|grease)\b/i.test(
        haystack,
      );
    const hasIntervalTerms =
      /\b(before\s+starting|first\s+check\s+after|every\s+\d{2,6}|hours?|hrs?|monthly|annual|annually|maintenance\s+as\s+needed)\b/i.test(
        haystack,
      );

    if (!hasMaintenanceTerms && !(hasActionTerms && hasIntervalTerms)) {
      return 0;
    }

    let score = 0;

    if (hasMaintenanceTerms) {
      score += 6;
    }
    if (hasActionTerms) {
      score += 4;
    }
    if (hasIntervalTerms) {
      score += 6;
    }
    if (
      /\b(periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals?|maintenance\s+as\s+needed)\b/i.test(
        haystack,
      )
    ) {
      score += 12;
    }
    if (
      /\b(general|fuel\s+system|lubrication\s+system|cooling\s+system|gas\s+intake|electrical\s+system|engine\s+and\s+assembly|remote\s+control\s+system)\b/i.test(
        haystack,
      )
    ) {
      score += 5;
    }
    if (/<table\b/i.test(content)) {
      score += 4;
    }

    const intervalMatches = intervalPhrases.filter((phrase) =>
      haystack.includes(phrase.toLowerCase()),
    ).length;
    score += intervalMatches * 10;

    if (
      intervalMatches === 0 &&
      /\b(fuel\s+circuit|diesel\s+fuel\s+inlet|fuel\s+outlet|inside\s+diameter|non-?return\s+valve|opening)\b/i.test(
        haystack,
      )
    ) {
      score -= 8;
    }

    if (
      intervalMatches === 0 &&
      /\b\d{2,6}\s*(?:mm|mbar|bar|psi|v|volt|volts|amp|amps|a|kw|kva|rpm|c)\b/i.test(
        haystack,
      ) &&
      !hasMaintenanceTerms
    ) {
      score -= 6;
    }

    if (
      /\b(generator|genset|diesel)\b/i.test(query) &&
      /\b(generator|genset|diesel)\b/i.test(haystack)
    ) {
      score += 2;
    }

    return score;
  }

  private buildCombinedChunkSnippet(snippets: string[]): string {
    const normalized = snippets
      .map((snippet) => snippet.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const snippet of normalized) {
      if (seen.has(snippet)) continue;
      seen.add(snippet);
      unique.push(snippet);
    }

    return unique.join('\n').slice(0, 3600);
  }

  private async buildStructuredIntervalMaintenanceSnippetFromPdfPage(
    ragflowDatasetId: string,
    manual: DocumentScanManual,
    pageNumber: number | undefined,
    query: string,
    intervalPhrases: string[],
  ): Promise<string | null> {
    if (
      pageNumber === undefined ||
      !/\.pdf\b/i.test(manual.filename) ||
      typeof this.ragflowService.downloadDocument !== 'function'
    ) {
      return null;
    }

    try {
      const downloaded = await this.ragflowService.downloadDocument(
        ragflowDatasetId,
        manual.ragflowDocumentId,
      );
      if (
        !/pdf/i.test(downloaded.contentType) &&
        !/\.pdf\b/i.test(downloaded.filename)
      ) {
        return null;
      }

      const textItems = await this.loadPdfPageTextItems(
        downloaded.buffer,
        pageNumber,
      );
      const extracted = this.extractIntervalMaintenanceItemsFromTextItems(
        textItems,
        query,
        intervalPhrases,
      );
      if (!extracted || extracted.items.length === 0) {
        return null;
      }

      return this.renderIntervalMaintenanceSnippet(extracted);
    } catch (error) {
      this.logger.debug(
        `Structured interval maintenance PDF fallback skipped for ${manual.filename} page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async loadPdfPageTextItems(
    buffer: Buffer,
    pageNumber: number,
  ): Promise<PdfPageTextItem[]> {
    const pdfjs = await this.loadPdfJsModule();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      isEvalSupported: false,
    });
    const document = await loadingTask.promise;

    try {
      if (pageNumber < 1 || pageNumber > document.numPages) {
        return [];
      }

      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();

      return textContent.items
        .filter(
          (
            item,
          ): item is {
            str: string;
            transform: number[];
            width?: number;
            height?: number;
          } =>
            typeof item?.str === 'string' && Array.isArray(item.transform),
        )
        .map((item) => ({
          text: item.str,
          x: Number(item.transform[4] ?? 0),
          y: Number(item.transform[5] ?? 0),
          width: Number(item.width ?? 0),
          height: Number(item.height ?? 0),
        }))
        .filter((item) => item.text.trim().length > 0);
    } finally {
      await document.destroy?.();
    }
  }

  private async loadPdfJsModule(): Promise<any> {
    if (!this.pdfJsModulePromise) {
      this.pdfJsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    }

    return this.pdfJsModulePromise;
  }

  private extractIntervalMaintenanceItemsFromTextItems(
    textItems: PdfPageTextItem[],
    query: string,
    intervalPhrases: string[],
  ): IntervalMaintenanceSnippet | null {
    if (textItems.length === 0) {
      return null;
    }

    const headerSeedItems = textItems.filter((item) =>
      this.isLikelyIntervalHeaderText(item.text),
    );
    if (headerSeedItems.length === 0) {
      return null;
    }
    const headerBoundaryItems = headerSeedItems.filter(
      (item) => !this.isLikelyIntervalTableTitleText(item.text),
    );
    const headerBottomY =
      Math.min(
        ...(headerBoundaryItems.length > 0
          ? headerBoundaryItems
          : headerSeedItems
        ).map((item) => item.y),
      ) - 8;
    const headerItems = textItems.filter((item) => item.y >= headerBottomY);
    const headerColumns = this.extractIntervalHeaderColumns(headerItems);
    const targetColumn = this.selectTargetIntervalHeaderColumn(
      headerColumns,
      query,
      intervalPhrases,
    );
    if (!targetColumn) {
      return null;
    }

    const sortedColumns = [...headerColumns].sort((left, right) => left.x - right.x);
    const targetIndex = sortedColumns.findIndex(
      (column) => column.x === targetColumn.x && column.label === targetColumn.label,
    );
    if (targetIndex < 0) {
      return null;
    }

    const leftBoundary =
      targetIndex === 0
        ? targetColumn.x - 20
        : (sortedColumns[targetIndex - 1].x + targetColumn.x) / 2;
    const rightBoundary =
      targetIndex === sortedColumns.length - 1
        ? targetColumn.x + 20
        : (targetColumn.x + sortedColumns[targetIndex + 1].x) / 2;
    const firstIntervalBoundary = Math.max(0, sortedColumns[0].x - 24);

    const rowClusters = this.clusterPdfRows(
      textItems.filter((item) => item.y < headerBottomY),
      3.5,
    );
    const rawRows = rowClusters
      .map((rowItems) => {
        const sortedRowItems = [...rowItems].sort((left, right) => left.x - right.x);
        const description = this.normalizeIntervalMaintenanceItemDescription(
          this.normalizePdfExtractedText(
            sortedRowItems
              .filter(
                (item) =>
                  item.x < leftBoundary - 8 &&
                  !this.isIntervalTableMarker(item.text),
              )
              .map((item) => item.text),
          ),
        );
        if (!description) {
          return null;
        }

        const hasTargetMarker = sortedRowItems.some(
          (item) =>
            this.isIntervalTableMarker(item.text) &&
            item.x >= leftBoundary &&
            item.x < rightBoundary,
        );
        const hasAnyIntervalMarker = sortedRowItems.some(
          (item) =>
            this.isIntervalTableMarker(item.text) &&
            item.x >= firstIntervalBoundary,
        );
        const isSectionHeading =
          !hasAnyIntervalMarker &&
          this.isLikelyIntervalTableSectionHeading(description);

        return {
          description,
          hasTargetMarker,
          hasAnyIntervalMarker,
          isSectionHeading,
        };
      })
      .filter(
        (
          row,
        ): row is {
          description: string;
          hasTargetMarker: boolean;
          hasAnyIntervalMarker: boolean;
          isSectionHeading: boolean;
        } => row !== null,
      );

    const logicalRows: Array<{
      description: string;
      hasTargetMarker: boolean;
      hasAnyIntervalMarker: boolean;
      isSectionHeading: boolean;
    }> = [];

    for (const row of rawRows) {
      const previous = logicalRows[logicalRows.length - 1];
      if (
        previous &&
        this.shouldMergeIntervalTableContinuation(previous.description, row)
      ) {
        previous.description = this.normalizePdfExtractedText([
          previous.description,
          row.description,
        ]);
        previous.description = this.normalizeIntervalMaintenanceItemDescription(
          previous.description,
        );
        previous.hasTargetMarker ||= row.hasTargetMarker;
        previous.hasAnyIntervalMarker ||= row.hasAnyIntervalMarker;
        continue;
      }

      logicalRows.push({ ...row });
    }

    const items = [...new Set(
      logicalRows
        .filter((row) => row.hasTargetMarker && !row.isSectionHeading)
        .map((row) => row.description)
        .filter((value) => value.length > 0),
    )];
    if (items.length === 0) {
      return null;
    }

    return {
      heading: this.extractIntervalTableHeading(textItems),
      intervalLabel: targetColumn.label,
      items,
    };
  }

  private extractIntervalHeaderColumns(
    headerItems: PdfPageTextItem[],
  ): IntervalHeaderColumn[] {
    const clusters = new Map<
      number,
      {
        items: PdfPageTextItem[];
        xs: number[];
      }
    >();

    const sortedItems = [...headerItems].sort((left, right) => left.x - right.x);
    for (const item of sortedItems) {
      const clusterKey = [...clusters.keys()].find(
        (existingX) => Math.abs(existingX - item.x) <= 18,
      );
      const key = clusterKey ?? item.x;
      const cluster = clusters.get(key) ?? { items: [], xs: [] };
      cluster.items.push(item);
      cluster.xs.push(item.x);
      clusters.set(key, cluster);
    }

    return [...clusters.values()]
      .map((cluster) => {
        const items = [...cluster.items].sort((left, right) => {
          if (right.y !== left.y) {
            return right.y - left.y;
          }
          return left.x - right.x;
        });
        const label = this.normalizePdfExtractedText(items.map((item) => item.text));
        return {
          label,
          x:
            cluster.xs.reduce((sum, value) => sum + value, 0) /
            Math.max(cluster.xs.length, 1),
          minY: Math.min(...items.map((item) => item.y)),
          maxY: Math.max(...items.map((item) => item.y)),
        };
      })
      .filter((column) =>
        /^(?:before(?:\s+starting)?|first\s+check(?:\s+after(?:\s+\d+\s+hours?)?)?|every\s+\d{1,4}|\d{1,4}|maintenance\s+as\s+needed|as\s+needed)\b/i.test(
          column.label,
        ),
      )
      .sort((left, right) => left.x - right.x);
  }

  private selectTargetIntervalHeaderColumn(
    headerColumns: IntervalHeaderColumn[],
    query: string,
    intervalPhrases: string[],
  ): IntervalHeaderColumn | null {
    const targets = this.extractIntervalTargets(query);
    const scored = headerColumns
      .map((column) => ({
        column,
        score: this.scoreIntervalHeaderColumn(column.label, targets, intervalPhrases),
      }))
      .sort((left, right) => right.score - left.score || left.column.x - right.column.x);

    return (scored[0]?.score ?? 0) > 0 ? scored[0].column : null;
  }

  private extractIntervalTargets(
    query: string,
  ): Array<{ value: number; unit: 'hour' | 'month' | 'year' }> {
    const targets: Array<{ value: number; unit: 'hour' | 'month' | 'year' }> =
      [];

    for (const match of query.matchAll(
      /\b(\d{1,6})(?:\s*-\s*|\s+)?(h(?:ours?|rs?)?|hourly)\b/gi,
    )) {
      targets.push({ value: Number.parseInt(match[1], 10), unit: 'hour' });
    }
    for (const match of query.matchAll(
      /\b(\d{1,4})(?:\s*-\s*|\s+)?months?\b/gi,
    )) {
      targets.push({ value: Number.parseInt(match[1], 10), unit: 'month' });
    }
    for (const match of query.matchAll(
      /\b(\d{1,4})(?:\s*-\s*|\s+)?years?\b/gi,
    )) {
      targets.push({ value: Number.parseInt(match[1], 10), unit: 'year' });
    }

    return targets.filter((target) => Number.isFinite(target.value));
  }

  private scoreIntervalHeaderColumn(
    label: string,
    targets: Array<{ value: number; unit: 'hour' | 'month' | 'year' }>,
    intervalPhrases: string[],
  ): number {
    const normalizedLabel = label.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalizedLabel) {
      return 0;
    }

    let score = 0;
    for (const target of targets) {
      const targetValue = String(target.value);
      if (!normalizedLabel.includes(targetValue)) {
        continue;
      }

      if (
        target.unit === 'hour' &&
        /\b(h(?:ours?|rs?)?|hourly)\b/i.test(normalizedLabel)
      ) {
        score += 18;
      } else if (target.unit === 'month' && /\bmonths?\b/i.test(normalizedLabel)) {
        score += 18;
      } else if (target.unit === 'year' && /\byears?\b/i.test(normalizedLabel)) {
        score += 18;
      } else {
        score += 6;
      }

      if (/\bevery\b/i.test(normalizedLabel)) {
        score += 4;
      }
    }

    for (const phrase of intervalPhrases) {
      if (normalizedLabel.includes(phrase.toLowerCase())) {
        score += 5;
      }
    }

    if (/\bmaintenance\s+as\s+needed\b/i.test(normalizedLabel)) {
      score -= 4;
    }

    return score;
  }

  private clusterPdfRows(
    items: PdfPageTextItem[],
    tolerance: number,
  ): PdfPageTextItem[][] {
    const rows: Array<{ y: number; items: PdfPageTextItem[] }> = [];
    const sorted = [...items].sort((left, right) => {
      if (right.y !== left.y) {
        return right.y - left.y;
      }
      return left.x - right.x;
    });

    for (const item of sorted) {
      const existingRow = rows.find((row) => Math.abs(row.y - item.y) <= tolerance);
      if (existingRow) {
        existingRow.items.push(item);
        existingRow.y = (existingRow.y * (existingRow.items.length - 1) + item.y) / existingRow.items.length;
        continue;
      }

      rows.push({ y: item.y, items: [item] });
    }

    return rows
      .sort((left, right) => right.y - left.y)
      .map((row) => row.items);
  }

  private isIntervalTableMarker(text: string): boolean {
    return /^[•·●▪■]$/.test(text.trim());
  }

  private isLikelyIntervalHeaderText(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return false;
    }

    return (
      /^(?:\d+\.\d+\s+periodic\s+checks?\s+and\s+maintenance|periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals\s+indicated)$/i.test(
        normalized,
      ) ||
      /^(?:before(?:\s+starting)?|first\s+check(?:\s+after\s+\d+\s+hours?)?|check|after\s+\d+|hours?|month|months|maintenance|as\s+needed|needed)$/i.test(
        normalized,
      ) ||
      /^every\s+\d{1,4}(?:\s*h(?:ours?|rs?)?\.?\s*or\s*\d+\s*(?:month|months|year|years))?$/i.test(
        normalized,
      ) ||
      /^hrs?\.?\s*or\s*\d+\s*(?:month|months|year|years)$/i.test(normalized)
    );
  }

  private isLikelyIntervalTableTitleText(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return /\bperiodic\s+checks?\s+and\s+maintenance\b/i.test(normalized);
  }

  private isLikelyIntervalTableSectionHeading(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return false;
    }

    if (normalized.length > 48 || /[.:]/.test(normalized)) {
      return false;
    }

    return /^[A-Z][A-Za-z/&\s-]{2,}$/.test(normalized);
  }

  private shouldMergeIntervalTableContinuation(
    previousDescription: string,
    row: {
      description: string;
      hasTargetMarker: boolean;
      hasAnyIntervalMarker: boolean;
      isSectionHeading: boolean;
    },
  ): boolean {
    if (row.isSectionHeading) {
      return false;
    }

    const normalized = row.description.trim();
    if (!normalized) {
      return false;
    }

    const looksLikeContinuation =
      /^[a-z(]/.test(normalized) ||
      previousDescription.endsWith('(') ||
      previousDescription.endsWith('/') ||
      previousDescription.endsWith('-') ||
      previousDescription.endsWith('"');
    if (!looksLikeContinuation) {
      return false;
    }

    if (!row.hasAnyIntervalMarker) {
      return true;
    }

    return !/[.;:]$/.test(previousDescription.trim());
  }

  private extractIntervalTableHeading(textItems: PdfPageTextItem[]): string | undefined {
    const headingItems = textItems.filter((item) =>
      /\b(periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals\s+indicated)\b/i.test(
        item.text,
      ),
    );
    if (headingItems.length === 0) {
      return undefined;
    }

    return this.normalizePdfExtractedText(
      headingItems
        .sort((left, right) => {
          if (right.y !== left.y) {
            return right.y - left.y;
          }
          return left.x - right.x;
        })
        .map((item) => item.text),
    );
  }

  private normalizePdfExtractedText(parts: string[]): string {
    return parts
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/\s+\/\s+/g, ' / ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private normalizeIntervalMaintenanceItemDescription(text: string): string {
    return text
      .replace(/\s+[a-z](?=\s*\()/gi, '')
      .replace(/\s+[a-z]$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private renderIntervalMaintenanceSnippet(
    extracted: IntervalMaintenanceSnippet,
  ): string {
    const lines: string[] = [];
    if (extracted.heading) {
      lines.push(extracted.heading);
    }
    lines.push(`Items due at ${extracted.intervalLabel}:`);
    lines.push(...extracted.items.map((item) => `- ${item}`));
    return lines.join('\n').slice(0, 3600);
  }

  private selectBestIntervalMaintenancePageChunks(
    scoredChunks: Array<{
      chunk: RagflowChunk;
      score: number;
      pageNumber?: number;
      minY?: number;
    }>,
  ): {
    bestChunk: {
      chunk: RagflowChunk;
      score: number;
      pageNumber?: number;
      minY?: number;
    };
    selectedChunks: Array<{
      chunk: RagflowChunk;
      score: number;
      pageNumber?: number;
      minY?: number;
    }>;
    citationPageNumber?: number;
  } {
    const bestChunk = scoredChunks[0];
    if (bestChunk.pageNumber === undefined) {
      return {
        bestChunk,
        selectedChunks: this.sortIntervalMaintenanceChunks(
          scoredChunks.filter((entry) => entry.score >= bestChunk.score - 4),
        ).slice(0, 8),
        citationPageNumber: undefined,
      };
    }

    const pageGroups = new Map<
      number,
      Array<{
        chunk: RagflowChunk;
        score: number;
        pageNumber?: number;
        minY?: number;
      }>
    >();
    for (const entry of scoredChunks) {
      if (entry.pageNumber === undefined) {
        continue;
      }
      const group = pageGroups.get(entry.pageNumber) ?? [];
      group.push(entry);
      pageGroups.set(entry.pageNumber, group);
    }

    const rankedGroups = [...pageGroups.entries()]
      .map(([pageNumber, entries]) => {
        const sortedEntries = this.sortIntervalMaintenanceChunks(entries);
        const strongestScore = sortedEntries[0]?.score ?? 0;
        const nearTopEntries = sortedEntries.filter(
          (entry) => entry.score >= strongestScore - 4,
        );
        const aggregateScore = nearTopEntries.reduce(
          (total, entry) => total + entry.score,
          0,
        );

        return {
          pageNumber,
          strongestScore,
          aggregateScore,
          nearTopEntries,
          sortedEntries,
        };
      })
      .sort((left, right) => {
        if (right.strongestScore !== left.strongestScore) {
          return right.strongestScore - left.strongestScore;
        }
        if (right.aggregateScore !== left.aggregateScore) {
          return right.aggregateScore - left.aggregateScore;
        }
        if (right.nearTopEntries.length !== left.nearTopEntries.length) {
          return right.nearTopEntries.length - left.nearTopEntries.length;
        }
        return right.pageNumber - left.pageNumber;
      });

    const bestGroup = rankedGroups[0];
    if (!bestGroup) {
      return {
        bestChunk,
        selectedChunks: this.sortIntervalMaintenanceChunks(
          scoredChunks.filter((entry) => entry.score >= bestChunk.score - 4),
        ).slice(0, 8),
        citationPageNumber: bestChunk.pageNumber,
      };
    }

    return {
      bestChunk: bestGroup.sortedEntries[0],
      selectedChunks: this.sortIntervalMaintenanceChunks(
        bestGroup.nearTopEntries,
      ).slice(0, 8),
      citationPageNumber: bestGroup.pageNumber,
    };
  }

  private sortIntervalMaintenanceChunks(
    entries: Array<{
      chunk: RagflowChunk;
      score: number;
      pageNumber?: number;
      minY?: number;
    }>,
  ): Array<{
    chunk: RagflowChunk;
    score: number;
    pageNumber?: number;
    minY?: number;
  }> {
    return [...entries].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (
        left.minY !== undefined &&
        right.minY !== undefined &&
        left.minY !== right.minY
      ) {
        return left.minY - right.minY;
      }
      if (
        left.pageNumber !== undefined &&
        right.pageNumber !== undefined &&
        left.pageNumber !== right.pageNumber
      ) {
        return left.pageNumber - right.pageNumber;
      }
      return left.chunk.id.localeCompare(right.chunk.id);
    });
  }

  private extractChunkMetadataValue(
    chunk: Pick<RagflowChunk, 'meta'>,
    key: string,
  ): string | undefined {
    const value = chunk.meta?.[key];
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private isBroadCertificateSoonQuery(query: string): boolean {
    return (
      /\b(certificates?|certifications?)\b/i.test(query) &&
      /\b(expire|expiry|expiries|expiring|valid\s+until|due\s+to\s+expire)\b/i.test(
        query,
      ) &&
      /\b(soon|upcoming|next|nearest)\b/i.test(query)
    );
  }

  private extractExplicitCertificateExpiryTimestamp(text: string): number | null {
    return this.extractExplicitCertificateExpiryTimestamps(text)[0] ?? null;
  }

  private extractExplicitCertificateExpiryTimestamps(text: string): number[] {
    const plainText = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const pattern =
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b/gi;
    const timestamps = new Set<number>();

    for (const match of plainText.matchAll(pattern)) {
      if (!match?.[1]) {
        continue;
      }

      const timestamp = this.parseCertificateDateToken(match[1]);
      if (timestamp !== null) {
        timestamps.add(timestamp);
      }
    }

    return [...timestamps].sort((left, right) => left - right);
  }

  private parseCertificateDateToken(token: string): number | null {
    const normalized = token.replace(/\s+/g, ' ').trim();
    const monthNames = new Map<string, number>([
      ['jan', 0],
      ['january', 0],
      ['feb', 1],
      ['february', 1],
      ['mar', 2],
      ['march', 2],
      ['apr', 3],
      ['april', 3],
      ['may', 4],
      ['jun', 5],
      ['june', 5],
      ['jul', 6],
      ['july', 6],
      ['aug', 7],
      ['august', 7],
      ['sep', 8],
      ['sept', 8],
      ['september', 8],
      ['oct', 9],
      ['october', 9],
      ['nov', 10],
      ['november', 10],
      ['dec', 11],
      ['december', 11],
    ]);

    const numericMatch = normalized.match(
      /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/,
    );
    if (numericMatch) {
      const day = Number.parseInt(numericMatch[1], 10);
      const month = Number.parseInt(numericMatch[2], 10) - 1;
      let year = Number.parseInt(numericMatch[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      const timestamp = Date.UTC(year, month, day);
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    const monthNameMatch = normalized.match(
      /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+|[-/])([a-z]{3,9})(?:\s+|[-/])(\d{2,4})$/i,
    );
    if (monthNameMatch) {
      const day = Number.parseInt(monthNameMatch[1], 10);
      const month = monthNames.get(monthNameMatch[2].toLowerCase());
      if (month === undefined) {
        return null;
      }
      let year = Number.parseInt(monthNameMatch[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      const timestamp = Date.UTC(year, month, day);
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    return null;
  }

  private trimSnippetBeforeForeignReference(
    snippet: string,
    referenceId: string,
  ): string {
    if (!snippet) return snippet;

    const normalizedReference = referenceId.toLowerCase();
    const anchorIndex = snippet.toLowerCase().indexOf(normalizedReference);
    const firstForeignMatch = [...snippet.matchAll(/\b1p\d{2,}\b/gi)].find(
      (match) => {
        if (match[0].toLowerCase() === normalizedReference) {
          return false;
        }
        if (typeof match.index !== 'number') {
          return false;
        }
        return anchorIndex < 0 || match.index > anchorIndex;
      },
    );
    if (
      !firstForeignMatch ||
      typeof firstForeignMatch.index !== 'number' ||
      firstForeignMatch.index <= 0
    ) {
      return snippet;
    }

    if (anchorIndex >= 0) {
      const startIndex = this.findReferenceSnippetStartIndex(snippet, anchorIndex);
      return snippet.slice(startIndex, firstForeignMatch.index).trim();
    }

    return snippet.slice(0, firstForeignMatch.index).trim();
  }

  private findReferenceSnippetStartIndex(
    snippet: string,
    anchorIndex: number,
  ): number {
    const blockStartPatterns = [/<table\b/gi, /<tr\b/gi];

    for (const pattern of blockStartPatterns) {
      let lastMatchIndex = -1;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(snippet)) !== null) {
        if (typeof match.index === 'number' && match.index < anchorIndex) {
          lastMatchIndex = match.index;
          continue;
        }
        break;
      }

      if (lastMatchIndex >= 0) {
        return lastMatchIndex;
      }
    }

    const previousLineBreak = Math.max(
      snippet.lastIndexOf('\n', anchorIndex),
      snippet.lastIndexOf('\r', anchorIndex),
    );
    if (previousLineBreak >= 0) {
      return previousLineBreak + 1;
    }

    return anchorIndex;
  }

  private scoreReferenceAnchorChunk(
    referenceId: string,
    entry: Pick<EnrichedChunk, 'content' | 'rawContent' | 'haystack' | 'minY'>,
  ): number {
    let score = 0;
    const foreignRefsBeforeTarget = this.countForeignReferencesBeforeTarget(
      referenceId,
      entry.rawContent,
    );
    const foreignRefsAfterTarget = this.countForeignReferencesAfterTarget(
      referenceId,
      entry.rawContent,
    );

    if (entry.haystack.includes(referenceId)) {
      score += 40;
    }

    if (
      /\b(reference\s*id|responsible|interval|last\s*due|next\s*due)\b/i.test(
        entry.content,
      )
    ) {
      score += 20;
    }

    if (
      /\b(responsible|interval|last\s*due|next\s*due|years?|hours?|chief\s*engineer|costs?)\b/i.test(
        entry.content,
      )
    ) {
      score += 12;
    }

    if (/\b(component\s*name|task\s*name)\b/i.test(entry.content)) {
      score += 8;
    }

    if (
      /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?)\b/i.test(
        entry.content,
      )
    ) {
      score -= 4;
    }

    score -= foreignRefsBeforeTarget * 12;
    score -= foreignRefsAfterTarget * 2;

    if (entry.minY !== undefined) {
      score += Math.max(0, 4 - entry.minY / 80);
    }

    score -= Math.floor(entry.content.length / 450);

    return score;
  }

  private selectReferenceRelevantChunks(
    referenceId: string,
    sortedPageChunks: EnrichedChunk[],
    bestAnchorChunk: EnrichedChunk,
    relevancePattern: RegExp,
  ): EnrichedChunk[] {
    const matchesReference = (
      entry: Pick<EnrichedChunk, 'haystack' | 'content'>,
    ) => {
      if (entry.haystack.includes(referenceId)) {
        return true;
      }

      const mentionedReferenceIds = [
        ...entry.haystack.matchAll(/\b1p\d{2,}\b/g),
      ].map((match) => match[0].toLowerCase());
      if (
        mentionedReferenceIds.some(
          (mentionedReferenceId) => mentionedReferenceId !== referenceId,
        )
      ) {
        return false;
      }

      return relevancePattern.test(entry.haystack);
    };

    const fallbackSelection = sortedPageChunks.filter(
      (entry) => entry.content.trim() && matchesReference(entry),
    );

    const chunkBands = this.buildReferenceChunkBands(sortedPageChunks);
    const anchorBandIndex = chunkBands.findIndex((band) =>
      band.entries.some((entry) => entry.chunk.id === bestAnchorChunk.chunk.id),
    );
    if (anchorBandIndex < 0) {
      return fallbackSelection;
    }

    const selected = chunkBands
      .slice(anchorBandIndex, anchorBandIndex + 2)
      .flatMap((band) => band.entries)
      .filter((entry) => {
        if (!entry.content.trim()) return false;

        if (
          bestAnchorChunk.minY !== undefined &&
          entry.minY !== undefined &&
          entry.minY + 8 < bestAnchorChunk.minY
        ) {
          return false;
        }

        return matchesReference(entry);
      });

    const baseSelection = selected.length > 0 ? selected : fallbackSelection;
    return this.expandReferenceBoundaryChunks(
      referenceId,
      sortedPageChunks,
      baseSelection,
      relevancePattern,
    );
  }

  private expandReferenceBoundaryChunks(
    referenceId: string,
    sortedPageChunks: EnrichedChunk[],
    selectedChunks: EnrichedChunk[],
    relevancePattern: RegExp,
  ): EnrichedChunk[] {
    if (selectedChunks.length === 0) {
      return selectedChunks;
    }

    const selectedIds = new Set(selectedChunks.map((entry) => entry.chunk.id));
    const selectedIndexes = sortedPageChunks
      .map((entry, index) => (selectedIds.has(entry.chunk.id) ? index : -1))
      .filter((index) => index >= 0);
    if (selectedIndexes.length === 0) {
      return selectedChunks;
    }

    const expanded = [...selectedChunks];
    const firstIndex = Math.min(...selectedIndexes);
    const lastIndex = Math.max(...selectedIndexes);

    for (const direction of [-1, 1] as const) {
      let currentIndex = direction < 0 ? firstIndex - 1 : lastIndex + 1;
      for (let step = 0; step < 2; step += 1) {
        if (currentIndex < 0 || currentIndex >= sortedPageChunks.length) {
          break;
        }

        const candidate = sortedPageChunks[currentIndex];
        if (
          !this.shouldIncludeReferenceBoundaryChunk(
            referenceId,
            candidate,
            expanded,
            relevancePattern,
          )
        ) {
          break;
        }

        if (!selectedIds.has(candidate.chunk.id)) {
          selectedIds.add(candidate.chunk.id);
          expanded.push(candidate);
        }

        currentIndex += direction;
      }
    }

    return expanded.sort((a, b) => {
      if (a.pageNumber !== undefined && b.pageNumber !== undefined) {
        if (a.pageNumber !== b.pageNumber) {
          return a.pageNumber - b.pageNumber;
        }
      }

      if (a.minY !== undefined && b.minY !== undefined && a.minY !== b.minY) {
        return a.minY - b.minY;
      }

      return (b.chunk.similarity ?? 0) - (a.chunk.similarity ?? 0);
    });
  }

  private shouldIncludeReferenceBoundaryChunk(
    referenceId: string,
    candidate: EnrichedChunk,
    selectedChunks: EnrichedChunk[],
    relevancePattern: RegExp,
  ): boolean {
    if (!candidate.content.trim()) {
      return false;
    }

    const selectedPages = new Set(
      selectedChunks
        .map((entry) => entry.pageNumber)
        .filter((page): page is number => page !== undefined),
    );
    if (
      candidate.pageNumber !== undefined &&
      selectedPages.size > 0 &&
      !selectedPages.has(candidate.pageNumber)
    ) {
      return false;
    }

    const mentionedReferenceIds = [
      ...candidate.haystack.matchAll(/\b1p\d{2,}\b/g),
    ].map((match) => match[0].toLowerCase());
    if (
      mentionedReferenceIds.some(
        (mentionedReferenceId) => mentionedReferenceId !== referenceId,
      )
    ) {
      return false;
    }

    const nearestDistance = selectedChunks.reduce((best, entry) => {
      if (
        candidate.pageNumber !== undefined &&
        entry.pageNumber !== undefined &&
        candidate.pageNumber !== entry.pageNumber
      ) {
        return best;
      }

      if (candidate.minY === undefined || entry.minY === undefined) {
        return Math.min(best, 0);
      }

      return Math.min(best, Math.abs(candidate.minY - entry.minY));
    }, Number.POSITIVE_INFINITY);

    if (nearestDistance > 110) {
      return false;
    }

    if (candidate.haystack.includes(referenceId)) {
      return true;
    }

    return relevancePattern.test(candidate.haystack);
  }

  private buildReferenceChunkBands(
    sortedPageChunks: EnrichedChunk[],
  ): Array<{ startY?: number; entries: EnrichedChunk[] }> {
    const bands: Array<{ startY?: number; entries: EnrichedChunk[] }> = [];

    for (const entry of sortedPageChunks) {
      const lastBand = bands.at(-1);
      if (
        !lastBand ||
        lastBand.startY === undefined ||
        entry.minY === undefined ||
        entry.minY - lastBand.startY > 28
      ) {
        bands.push({
          startY: entry.minY,
          entries: [entry],
        });
        continue;
      }

      lastBand.entries.push(entry);
    }

    return bands;
  }

  private countForeignReferencesBeforeTarget(
    referenceId: string,
    snippet: string,
  ): number {
    const normalizedReference = referenceId.toLowerCase();
    const normalizedSnippet = snippet.toLowerCase();
    const anchorIndex = normalizedSnippet.indexOf(normalizedReference);
    if (anchorIndex < 0) {
      return 0;
    }

    return [...normalizedSnippet.matchAll(/\b1p\d{2,}\b/g)].filter((match) => {
      if (match[0] === normalizedReference) {
        return false;
      }
      return typeof match.index === 'number' && match.index < anchorIndex;
    }).length;
  }

  private countForeignReferencesAfterTarget(
    referenceId: string,
    snippet: string,
  ): number {
    const normalizedReference = referenceId.toLowerCase();
    const normalizedSnippet = snippet.toLowerCase();
    const anchorIndex = normalizedSnippet.indexOf(normalizedReference);
    if (anchorIndex < 0) {
      return 0;
    }

    return [...normalizedSnippet.matchAll(/\b1p\d{2,}\b/g)].filter((match) => {
      if (match[0] === normalizedReference) {
        return false;
      }
      return typeof match.index === 'number' && match.index > anchorIndex;
    }).length;
  }

  private extractChunkPageNumber(
    chunk: Pick<RagflowChunk, 'meta' | 'positions'>,
  ): number | undefined {
    const metaPage = chunk.meta?.page_num;
    if (typeof metaPage === 'number' && Number.isFinite(metaPage)) {
      return metaPage;
    }

    const pages = this.collectChunkPositionValues(chunk.positions)
      .map((value) => value[0])
      .filter((value): value is number => Number.isFinite(value));
    if (pages.length === 0) return undefined;

    const counts = new Map<number, number>();
    for (const page of pages) {
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return a[0] - b[0];
      })[0]?.[0];
  }

  private extractChunkMinY(positions: unknown): number | undefined {
    const yValues = this.collectChunkPositionValues(positions)
      .map((value) => value[3])
      .filter((value): value is number => Number.isFinite(value));
    if (yValues.length === 0) return undefined;
    return Math.min(...yValues);
  }

  private collectChunkPositionValues(positions: unknown): number[][] {
    if (positions === null || positions === undefined) return [];

    if (Array.isArray(positions)) {
      if (
        positions.length >= 5 &&
        positions.every((value) => typeof value === 'number')
      ) {
        return [positions as number[]];
      }

      return positions.flatMap((entry) => this.collectChunkPositionValues(entry));
    }

    if (typeof positions === 'object') {
      const value = (positions as Record<string, unknown>).value;
      if (value !== undefined) {
        return this.collectChunkPositionValues(value);
      }
    }

    return [];
  }
}
