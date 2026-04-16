import { Injectable, Logger } from '@nestjs/common';
import {
  extractCertificateExpiryTimestamps,
  isBroadCertificateSoonQuery,
} from '../../common/certificate-expiry.utils';
import { PrismaService } from '../../prisma/prisma.service';
import { RagflowService } from '../../ragflow/ragflow.service';
import {
  DEFAULT_SHIP_MANUAL_CATEGORY,
  parseShipManualCategory,
  type ShipManualCategory,
} from '../../ships/manual-category';
import { ChatCitation } from '../../chat/chat.types';
import { ChatDocumentationQueryService } from '../documentation/chat-documentation-query.service';
import { type ChatDocumentSourceCategory } from '../../chat/query/chat-query-planner.service';
import { ChatReferenceExtractionService } from '../documentation/chat-reference-extraction.service';
import {
  buildNarrativeIntervalMaintenanceSnippetFromChunks,
  extractIntervalMaintenanceItemsFromTextItems as extractIntervalMaintenanceItemsFromPdfTextItems,
  extractNarrativeIntervalMaintenanceSnippet as extractNarrativeIntervalMaintenanceSnippetFromText,
  loadPdfPageTextItems as loadPdfPageTextItemsFromPdf,
  renderIntervalMaintenanceSnippet,
  selectBestIntervalMaintenancePageChunks,
  type IntervalMaintenanceSnippet,
  type PdfPageTextItem,
} from './interval-maintenance-parser';
import {
  extractChunkMetadataValue,
  extractChunkMinY,
  extractChunkPageNumber,
  scoreReferenceAnchorChunk,
  selectReferenceRelevantChunks,
  trimSnippetBeforeForeignReference,
} from './reference-chunk-scanner.utils';

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

@Injectable()
export class ChatDocumentationScanService {
  private readonly logger = new Logger(ChatDocumentationScanService.name);

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
            const rawContent = trimSnippetBeforeForeignReference(
              chunk.content ?? '',
              referenceId,
            );
            const content =
              this.referenceExtractionService.focusReferenceSnippet(
                rawContent,
                referenceId,
              );
            return {
              chunk,
              rawContent,
              content,
              haystack: `${manual.filename}\n${content}`.toLowerCase(),
              pageNumber: extractChunkPageNumber(chunk),
              minY: extractChunkMinY(chunk.positions),
            };
          });

          const anchorChunks = enrichedChunks.filter((entry) =>
            entry.haystack.includes(referenceId),
          );
          if (anchorChunks.length === 0) continue;

          const bestAnchorChunk = [...anchorChunks].sort(
            (a, b) =>
              scoreReferenceAnchorChunk(referenceId, b) -
              scoreReferenceAnchorChunk(referenceId, a),
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

          const sortedRelevantChunks = selectReferenceRelevantChunks(
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
            ...sortedRelevantChunks
              .slice(0, 10)
              .map((entry) =>
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
                pageNumber: extractChunkPageNumber(chunk),
                minY: extractChunkMinY(chunk.positions),
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
            selectBestIntervalMaintenancePageChunks(scoredChunks);

          const structuredSnippet =
            await this.buildStructuredIntervalMaintenanceSnippetFromPdfPage(
              scanContext.ragflowDatasetId,
              manual,
              citationPageNumber,
              queryContext,
              intervalPhrases,
            );
          const narrativeSnippet =
            buildNarrativeIntervalMaintenanceSnippetFromChunks(
              selectedChunks.map((entry) => entry.chunk.content ?? ''),
              queryContext,
              intervalPhrases,
            );
          const combinedSnippet =
            structuredSnippet ??
            narrativeSnippet ??
            this.buildCombinedChunkSnippet(
              selectedChunks.map((entry) => entry.chunk.content ?? ''),
            );

          if (structuredSnippet) {
            this.logger.debug(
              `Manual interval maintenance snippet reconstructed from PDF page ${citationPageNumber} for ${manual.filename}`,
            );
          } else if (narrativeSnippet) {
            this.logger.debug(
              `Manual interval maintenance narrative snippet selected from chunks for ${manual.filename}`,
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
            ...selectedChunks
              .slice(0, 3)
              .map((entry) =>
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
    if (!isBroadCertificateSoonQuery(queryContext)) {
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
      const candidateManuals = this.selectCandidateManualsForCertificateScan(
        scanContext.manuals,
        citations,
      ).slice(0, 16);
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
              const expiries =
                extractCertificateExpiryTimestamps(content);
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
              const leftFuture = left.expiries.some(
                (expiry) => expiry >= Date.now(),
              )
                ? 1
                : 0;
              const rightFuture = right.expiries.some(
                (expiry) => expiry >= Date.now(),
              )
                ? 1
                : 0;
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

              return (
                (right.chunk.similarity ?? 0) - (left.chunk.similarity ?? 0)
              );
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
          extractCertificateExpiryTimestamps(
            citation.snippet ?? '',
          ).some((expiry) => expiry >= Date.now()),
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

    const anchorTerms =
      this.queryService.extractContactAnchorTerms(queryContext);
    const wantsRoleInventory =
      this.queryService.isRoleInventoryQuery(queryContext);
    const collected: ChatCitation[] = [];
    let scannedManualCount = 0;

    for (const scanContext of scanContexts) {
      const candidateManuals = this.selectCandidateManualsForContactScan(
        scanContext.manuals,
        citations,
      ).slice(0, 6);
      scannedManualCount += candidateManuals.length;
      const collectedBeforeContext = collected.length;

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

      if (collected.length === collectedBeforeContext) {
        collected.push(
          ...(await this.collectPersonnelDirectorySearchFallbackCitations(
            scanContext,
            queryContext,
            anchorTerms,
            wantsRoleInventory,
          )),
        );
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
              if (
                !/\b(audit|compliance|inspection|survey|checklist)\b/i.test(
                  haystack,
                )
              ) {
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

    const hasExplicitManualScope =
      allowedManualIdSet !== null && allowedManualIdSet.size > 0;

    if (
      shipId &&
      citedManualIds.size === 0 &&
      normalizedSourceHints.length === 0
    ) {
      return contexts;
    }

    if (
      citedManualIds.size === 0 &&
      normalizedSourceHints.length === 0 &&
      !hasExplicitManualScope
    ) {
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

      const score =
        citedManualIds.size > 0 || normalizedSourceHints.length > 0
          ? this.scoreDocumentScanContext(
              manuals,
              citedManualIds,
              normalizedSourceHints,
            )
          : 1;
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
    return parseShipManualCategory(category) ?? DEFAULT_SHIP_MANUAL_CATEGORY;
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

  private async collectPersonnelDirectorySearchFallbackCitations(
    scanContext: DocumentScanContext,
    queryContext: string,
    anchorTerms: string[],
    wantsRoleInventory: boolean,
  ): Promise<ChatCitation[]> {
    const manualByDocumentId = new Map(
      scanContext.manuals.map((manual) => [manual.ragflowDocumentId, manual]),
    );
    const hasDedicatedContactManual = scanContext.manuals.some((manual) =>
      this.isContactScanCandidateManual(manual.filename),
    );

    for (const query of this.buildPersonnelDirectoryFallbackQueries(
      queryContext,
      anchorTerms,
    )) {
      try {
        const results = await this.ragflowService.searchDataset(
          scanContext.ragflowDatasetId,
          query,
          24,
        );
        const matched = results
          .map((result) => {
            const manual = manualByDocumentId.get(result.doc_id);
            if (!manual) {
              return null;
            }
            if (
              hasDedicatedContactManual &&
              !this.isContactScanCandidateManual(manual.filename)
            ) {
              return null;
            }

            const content = (result.content ?? '').replace(/\s+/g, ' ').trim();
            if (
              !this.isLikelyPersonnelDirectoryChunk(
                manual.filename,
                content,
                anchorTerms,
                wantsRoleInventory,
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
              1.01,
            );
          })
          .filter((citation): citation is ChatCitation => Boolean(citation));

        if (matched.length > 0) {
          this.logger.debug(
            `Personnel directory search fallback matched ${matched.length} chunk(s) for query="${query}"`,
          );
          return matched;
        }
      } catch (error) {
        this.logger.warn(
          `Personnel directory search fallback failed for query="${query}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return [];
  }

  private buildPersonnelDirectoryFallbackQueries(
    queryContext: string,
    anchorTerms: string[],
  ): string[] {
    const queries = new Set<string>();
    const normalizedQuery = queryContext.replace(/\s+/g, ' ').trim();
    const anchors = anchorTerms.join(' ').trim();
    const subject = anchors || normalizedQuery;

    if (normalizedQuery) {
      queries.add(normalizedQuery);
    }
    if (subject) {
      queries.add(`${subject} contact details email phone mobile`);
      queries.add(`${subject} company contact details`);
      queries.add(`${subject} personnel directory contact list`);
    }

    if (anchorTerms.includes('dpa')) {
      queries.add('dpa designated person ashore contact details email phone');
    }
    if (anchorTerms.includes('cso')) {
      queries.add('cso company security officer contact details email phone');
    }

    return [...queries];
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
      .filter((manual) =>
        this.isTankCapacityScanCandidateManual(manual.filename),
      )
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
    if (
      /\b(company\s+contact|contact|directory|phone|email)\b/.test(normalized)
    ) {
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
      content.match(
        /\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/gi,
      ) ?? [];
    const phoneMatches = content.match(/\+\s*\d[\d\s()./-]{5,}\d\b/g) ?? [];
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

    if (
      !(hasDirectoryTitle || hasDenseDirectoryStructure || hasStrongRoleSignals)
    ) {
      return false;
    }

    if (
      hasOperationalNoise &&
      !(hasDirectoryTitle || hasDenseDirectoryStructure)
    ) {
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
    return /\b(audit|audits|compliance|survey|surveys|inspection|inspections|checklist|checklists)\b/i.test(
      filename,
    );
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
      pageNumber: extractChunkPageNumber(chunk),
      snippet: snippetOverride ?? chunk.content ?? '',
      sourceTitle: manual.filename,
      sourceCategory: sourceCategory ?? manual.category,
      sourceMetadataCategory: extractChunkMetadataValue(chunk, 'category'),
      sourceMetadataCategoryLabel: extractChunkMetadataValue(
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
      /\b(before\s+starting|first\s+check\s+after|every\s+\d{2,6}|hours?|hrs?|daily|weekly|monthly|annual|annually|yearly|once\s+per\s+(?:day|week|month|year)|maintenance\s+as\s+needed)\b/i.test(
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

  // ── Interval maintenance parsing extracted to interval-maintenance-parser.ts ──

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

      return renderIntervalMaintenanceSnippet(extracted);
    } catch (error) {
      this.logger.debug(
        `Structured interval maintenance PDF fallback skipped for ${manual.filename} page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private extractNarrativeIntervalMaintenanceSnippet(
    text: string,
    query: string,
    intervalPhrases: string[],
  ): IntervalMaintenanceSnippet | null {
    return extractNarrativeIntervalMaintenanceSnippetFromText(
      text,
      query,
      intervalPhrases,
    );
  }

  private extractIntervalMaintenanceItemsFromTextItems(
    textItems: PdfPageTextItem[],
    query: string,
    intervalPhrases: string[],
  ): IntervalMaintenanceSnippet | null {
    return extractIntervalMaintenanceItemsFromPdfTextItems(
      textItems,
      query,
      intervalPhrases,
    );
  }

  private async loadPdfPageTextItems(
    buffer: Buffer,
    pageNumber: number,
  ): Promise<PdfPageTextItem[]> {
    return loadPdfPageTextItemsFromPdf(buffer, pageNumber);
  }

}
