import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { ChatCitation } from './chat.types';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';

interface DocumentScanManual {
  id: string;
  ragflowDocumentId: string;
  filename: string;
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

    const scanContexts = await this.loadDocumentScanContexts(shipId, citations);
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

    const scanContexts = await this.loadDocumentScanContexts(shipId, citations);
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

  async expandCertificateExpiryDocumentChunkCitations(
    shipId: string | null,
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
  ): Promise<ChatCitation[]> {
    if (!this.ragflowService.isConfigured()) return [];

    const queryContext =
      retrievalQuery.trim().length >= userQuery.trim().length
        ? retrievalQuery
        : userQuery;
    if (!this.isBroadCertificateSoonQuery(queryContext)) {
      return [];
    }

    const scanContexts = await this.loadDocumentScanContexts(shipId, citations);
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
        .slice(0, 12);
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
                /\b(certificate|certificato|survey|registry|approval|directive|module|class|solas|med|declaration\s+of\s+conformity|product\s+design\s+assessment|manufacturing\s+assessment)\b/i.test(
                  entry.haystack,
                ),
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

  private async loadDocumentScanContexts(
    shipId: string | null,
    citations: ChatCitation[],
  ): Promise<DocumentScanContext[]> {
    const contexts: DocumentScanContext[] = [];

    if (shipId) {
      const ship = await this.prisma.ship.findUnique({
        where: { id: shipId },
        select: {
          ragflowDatasetId: true,
          manuals: {
            select: { id: true, ragflowDocumentId: true, filename: true },
          },
        },
      });

      if (ship?.ragflowDatasetId) {
        contexts.push({
          ragflowDatasetId: ship.ragflowDatasetId,
          manuals: ship.manuals.filter((manual) => Boolean(manual.ragflowDocumentId)),
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
          select: { id: true, ragflowDocumentId: true, filename: true },
        },
      },
    });

    for (const ship of ships) {
      if (!ship.ragflowDatasetId) continue;

      const manuals = ship.manuals.filter((manual) => Boolean(manual.ragflowDocumentId));
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
    const certificateLike = baseOrdered.filter((manual) =>
      /\b(certificate|certificato|survey|registry|approval|class|solas|med|cor|radio|load\s*line|loadline|iopp|mlc|declaration)\b/i.test(
        manual.filename,
      ),
    );
    const ordered = [...certificateLike, ...baseOrdered];
    const seen = new Set<string>();

    return ordered.filter((manual) => {
      const key = `${manual.id}::${manual.ragflowDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private mapDocumentChunkToCitation(
    manual: Pick<DocumentScanManual, 'id' | 'filename'>,
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
      ...(sourceCategory ? { sourceCategory } : {}),
    };
  }

  private isBroadCertificateSoonQuery(query: string): boolean {
    return (
      /\bcertificates?\b/i.test(query) &&
      /\b(expire|expiry|expiring|valid\s+until)\b/i.test(query) &&
      /\b(soon|upcoming|next)\b/i.test(query)
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
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b/gi;
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
      /^(\d{1,2})(?:\s+|[-/])([a-z]{3,9})(?:\s+|[-/])(\d{2,4})$/i,
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
