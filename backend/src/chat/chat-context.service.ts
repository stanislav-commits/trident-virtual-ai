import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { TagLinksService } from '../tags/tag-links.service';
import type { ChatDocumentSourceCategory } from './chat-query-planner.service';

const DEFAULT_RAGFLOW_CONTEXT_TOP_K = (() => {
  const parsed = Number.parseInt(process.env.RAGFLOW_CONTEXT_TOP_K ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
})();

const DEFAULT_RAGFLOW_CONTEXT_CANDIDATE_K = (() => {
  const parsed = Number.parseInt(
    process.env.RAGFLOW_CONTEXT_CANDIDATE_K ?? '',
    10,
  );
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Math.max(DEFAULT_RAGFLOW_CONTEXT_TOP_K * 3, 24);
})();

const DEFAULT_RAGFLOW_CONTEXT_SNIPPET_CHARS = (() => {
  const parsed = Number.parseInt(
    process.env.RAGFLOW_CONTEXT_SNIPPET_CHARS ?? '',
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 300) return 1200;
  return Math.min(parsed, 4000);
})();

const MAX_SCOPED_CHUNK_FALLBACK_DOCUMENTS = 6;

const SPECIFICATION_SECTION_HEADING_PATTERN =
  /^\s*(?:\d+(?:\.\d+)*\s*)?(?:technical\s*data|technical\s*specifications?|specifications?|data\s*sheet|spec\s*sheet|parameters?)(?:\b|\d)/i;

const LOWERCASE_ACRONYM_STOP_WORDS = new Set([
  'air',
  'and',
  'are',
  'bus',
  'can',
  'day',
  'fan',
  'for',
  'gas',
  'hot',
  'how',
  'kit',
  'low',
  'man',
  'max',
  'min',
  'new',
  'now',
  'off',
  'oil',
  'old',
  'out',
  'own',
  'per',
  'raw',
  'run',
  'sea',
  'set',
  'the',
  'top',
  'use',
  'way',
  'wet',
]);

const REQUIRED_SUBJECT_TOKEN_STOP_WORDS = new Set([
  'action',
  'actions',
  'application',
  'check',
  'checks',
  'connect',
  'connecting',
  'connection',
  'data',
  'diagram',
  'diagrams',
  'display',
  'document',
  'function',
  'guide',
  'included',
  'includes',
  'limits',
  'listed',
  'manual',
  'modes',
  'operating',
  'operation',
  'parts',
  'procedure',
  'process',
  'requirements',
  'section',
  'selecting',
  'source',
  'steps',
  'technical',
]);

interface RAGFlowSearchResult {
  id: string;
  doc_id: string;
  doc_name: string;
  content: string;
  similarity?: number;
  meta?: Record<string, unknown>;
}

interface ContextCitation {
  shipManualId?: string;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
  sourceCategory?: string;
  sourceMetadataCategory?: string;
  sourceMetadataCategoryLabel?: string;
}

interface SearchableManual {
  id: string;
  ragflowDocumentId?: string | null;
  filename?: string | null;
  category?: string | null;
}

interface LexicalQueryProfile {
  anchorTokens: string[];
  maintenanceIntervalPhrases: string[];
  phrases: string[];
  requiredSubjectTokens: string[];
  strongPhrases: string[];
  tokens: string[];
  wantsMaintenanceIntervalEvidence: boolean;
  wantsProcedureEvidence: boolean;
  wantsSpecificationEvidence: boolean;
}

@Injectable()
export class ChatContextService {
  private readonly logger = new Logger(ChatContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    @Optional() private readonly tagLinks?: TagLinksService,
  ) {}

  async findContextForQuery(
    shipId: string,
    query: string,
    topK: number = DEFAULT_RAGFLOW_CONTEXT_TOP_K,
    candidateK: number = DEFAULT_RAGFLOW_CONTEXT_CANDIDATE_K,
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<{
    citations: ContextCitation[];
    ragflowRequestId?: string;
  }> {
    const ship = await this.prisma.ship.findUnique({
      where: { id: shipId },
      include: {
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

    if (!ship) throw new NotFoundException('Ship not found');

    if (!ship.ragflowDatasetId) {
      return { citations: [] };
    }

    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow service is not available');
    }

    try {
      const retrievalK = Math.max(topK, candidateK);
      const categoryScopedManuals = this.filterManualsByCategories(
        ship.manuals,
        allowedDocumentCategories,
      );
      const manuallyScopedManuals = this.filterManualsByIds(
        categoryScopedManuals,
        allowedManualIds,
      );
      const scopedManuals = await this.filterShipManualsByTags(
        ship.id,
        query,
        manuallyScopedManuals,
        allowedDocumentCategories,
      );
      if (
        allowedDocumentCategories?.length &&
        categoryScopedManuals.length === 0
      ) {
        return { citations: [] };
      }
      if (allowedManualIds?.length && manuallyScopedManuals.length === 0) {
        return { citations: [] };
      }
      if (scopedManuals.length === 0) {
        return { citations: [] };
      }

      const snippetCharLimit = this.getSnippetCharLimit(query);
      const categoryDocumentIds = this.buildManualDocumentIdSet(
        manuallyScopedManuals,
        Boolean(allowedDocumentCategories?.length || allowedManualIds?.length),
      );
      const preferredDocumentIds = this.buildPreferredManualDocumentIdSet(
        manuallyScopedManuals,
        scopedManuals,
      );
      if (preferredDocumentIds?.size) {
        this.logger.debug(
          `Document scoped search ship=${ship.id} query="${query.replace(/\s+/g, ' ').trim()}" preferredManuals=${preferredDocumentIds.size}/${manuallyScopedManuals.length}`,
        );
      }
      let citations = preferredDocumentIds?.size
        ? await this.searchDatasetForManuals({
            datasetId: ship.ragflowDatasetId,
            query,
            retrievalK,
            snippetCharLimit,
            manuals: ship.manuals,
            allowedDocumentIds: preferredDocumentIds,
          })
        : [];

      if (!this.hasSufficientScopedCitations(citations)) {
        if (preferredDocumentIds?.size) {
          this.logger.debug(
            `Document tag-first scope ship=${ship.id} yielded no citations for query="${query.replace(/\s+/g, ' ').trim()}"; widening search`,
          );
        }
        citations = await this.searchDatasetForManuals({
          datasetId: ship.ragflowDatasetId,
          query,
          retrievalK,
          snippetCharLimit,
          manuals: ship.manuals,
          allowedDocumentIds: categoryDocumentIds,
        });
      }

      return {
        citations: citations.slice(0, retrievalK),
        ragflowRequestId: undefined,
      };
    } catch (err) {
      throw new ServiceUnavailableException(
        `Failed to search context: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findContextForAdminQuery(
    query: string,
    topK: number = DEFAULT_RAGFLOW_CONTEXT_TOP_K,
    candidateK: number = DEFAULT_RAGFLOW_CONTEXT_CANDIDATE_K,
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
    allowedManualIds?: string[],
  ): Promise<ContextCitation[]> {
    // Admin search across all ship datasets
    const ships = await this.prisma.ship.findMany({
      where: {
        ragflowDatasetId: { not: null },
      },
      include: {
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

    if (!ships.length) return [];

    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow service is not available');
    }

    const allCitations: ContextCitation[] = [];
    const retrievalK = Math.max(topK, candidateK);
    const snippetCharLimit = this.getSnippetCharLimit(query);

    for (const ship of ships) {
      try {
        const categoryScopedManuals = this.filterManualsByCategories(
          ship.manuals,
          allowedDocumentCategories,
        );
        if (
          allowedDocumentCategories?.length &&
          categoryScopedManuals.length === 0
        ) {
          continue;
        }
        const manuallyScopedManuals = this.filterManualsByIds(
          categoryScopedManuals,
          allowedManualIds,
        );
        if (allowedManualIds?.length && manuallyScopedManuals.length === 0) {
          continue;
        }
        const scopedManuals = await this.filterAdminManualsByTags(
          query,
          manuallyScopedManuals,
          allowedDocumentCategories,
        );
        if (scopedManuals.length === 0) {
          continue;
        }

        const categoryDocumentIds = this.buildManualDocumentIdSet(
          manuallyScopedManuals,
          Boolean(
            allowedDocumentCategories?.length || allowedManualIds?.length,
          ),
        );
        const preferredDocumentIds = this.buildPreferredManualDocumentIdSet(
          manuallyScopedManuals,
          scopedManuals,
        );
        if (preferredDocumentIds?.size) {
          this.logger.debug(
            `Document scoped search admin ship=${ship.id} query="${query.replace(/\s+/g, ' ').trim()}" preferredManuals=${preferredDocumentIds.size}/${manuallyScopedManuals.length}`,
          );
        }
        let shipCitations = preferredDocumentIds?.size
          ? await this.searchDatasetForManuals({
              datasetId: ship.ragflowDatasetId!,
              query,
              retrievalK,
              snippetCharLimit,
              manuals: ship.manuals,
              allowedDocumentIds: preferredDocumentIds,
              sourceTitleSuffix: ship.name,
            })
          : [];

        if (!this.hasSufficientScopedCitations(shipCitations)) {
          if (preferredDocumentIds?.size) {
            this.logger.debug(
              `Document tag-first scope admin ship=${ship.id} yielded no citations for query="${query.replace(/\s+/g, ' ').trim()}"; widening search`,
            );
          }
          shipCitations = await this.searchDatasetForManuals({
            datasetId: ship.ragflowDatasetId!,
            query,
            retrievalK,
            snippetCharLimit,
            manuals: ship.manuals,
            allowedDocumentIds: categoryDocumentIds,
            sourceTitleSuffix: ship.name,
          });
        }

        allCitations.push(...shipCitations);
      } catch {
        // Log and continue with next ship
      }
    }

    // Return top-k across all ships
    return this.dedupeCitations(allCitations)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, retrievalK);
  }

  private dedupeCitations(citations: ContextCitation[]): ContextCitation[] {
    const seen = new Set<string>();
    const deduped: ContextCitation[] = [];

    for (const citation of citations) {
      const chunkKey = citation.chunkId?.trim();
      if (chunkKey) {
        const key = `chunk:${chunkKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(citation);
        continue;
      }

      const normalizedSnippet = (citation.snippet ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const key = [
        citation.sourceTitle ?? '',
        citation.pageNumber ?? '',
        normalizedSnippet,
      ].join('|');

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(citation);
    }

    return deduped;
  }

  private filterManualsByCategories<
    T extends { category?: string | null; ragflowDocumentId?: string | null },
  >(
    manuals: T[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
  ): T[] {
    if (!allowedDocumentCategories?.length) {
      return manuals;
    }

    const allowedCategories = new Set(
      allowedDocumentCategories.map((category) => category.toUpperCase()),
    );

    return manuals.filter((manual) => {
      const category = manual.category?.trim().toUpperCase();
      return Boolean(
        manual.ragflowDocumentId &&
        category &&
        allowedCategories.has(category as ChatDocumentSourceCategory),
      );
    });
  }

  private filterManualsByIds<T extends { id: string }>(
    manuals: T[],
    allowedManualIds?: string[],
  ): T[] {
    if (!allowedManualIds?.length) {
      return manuals;
    }

    const allowedManualIdSet = new Set(
      allowedManualIds.map((manualId) => manualId.trim()).filter(Boolean),
    );
    if (allowedManualIdSet.size === 0) {
      return manuals;
    }

    return manuals.filter((manual) => allowedManualIdSet.has(manual.id));
  }

  private async filterShipManualsByTags<
    T extends {
      id: string;
      category?: string | null;
      ragflowDocumentId?: string | null;
    },
  >(
    shipId: string,
    query: string,
    manuals: T[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
  ): Promise<T[]> {
    if (!this.tagLinks || manuals.length <= 1) {
      return manuals;
    }

    const manualIds = await this.tagLinks.findTaggedManualIdsForShipQuery(
      shipId,
      query,
      allowedDocumentCategories,
    );
    if (manualIds.length === 0 || manualIds.length >= manuals.length) {
      return manuals;
    }

    const manualIdSet = new Set(manualIds);
    const filtered = manuals.filter((manual) => manualIdSet.has(manual.id));
    return filtered.length > 0 ? filtered : manuals;
  }

  private async filterAdminManualsByTags<
    T extends {
      id: string;
      category?: string | null;
      ragflowDocumentId?: string | null;
    },
  >(
    query: string,
    manuals: T[],
    allowedDocumentCategories?: ChatDocumentSourceCategory[],
  ): Promise<T[]> {
    if (!this.tagLinks || manuals.length <= 1) {
      return manuals;
    }

    const manualIds = await this.tagLinks.findTaggedManualIdsForAdminQuery(
      query,
      allowedDocumentCategories,
    );
    if (manualIds.length === 0 || manualIds.length >= manuals.length) {
      return manuals;
    }

    const manualIdSet = new Set(manualIds);
    const filtered = manuals.filter((manual) => manualIdSet.has(manual.id));
    return filtered.length > 0 ? filtered : manuals;
  }

  private getSearchPoolSize(
    retrievalK: number,
    hasDocumentRestriction: boolean,
  ): number {
    if (!hasDocumentRestriction) {
      return retrievalK;
    }

    return Math.min(Math.max(retrievalK * 6, 48), 180);
  }

  private async searchDatasetForManuals(params: {
    datasetId: string;
    query: string;
    retrievalK: number;
    snippetCharLimit: number;
    manuals: SearchableManual[];
    allowedDocumentIds?: Set<string> | null;
    sourceTitleSuffix?: string;
  }): Promise<ContextCitation[]> {
    const {
      datasetId,
      query,
      retrievalK,
      snippetCharLimit,
      manuals,
      allowedDocumentIds,
      sourceTitleSuffix,
    } = params;
    const searchPoolSize = this.getSearchPoolSize(
      retrievalK,
      Boolean(allowedDocumentIds?.size),
    );
    const queryProfile = this.buildLexicalQueryProfile(query);
    let results: RAGFlowSearchResult[];
    try {
      results = await this.ragflow.searchDataset(
        datasetId,
        query,
        searchPoolSize,
      );
    } catch (error) {
      if (!this.shouldUseScopedChunkFallback(allowedDocumentIds, manuals)) {
        throw error;
      }

      this.logger.warn(
        `RAGFlow retrieval failed for scoped query="${query.replace(/\s+/g, ' ').trim()}"; falling back to chunk scan for ${allowedDocumentIds.size} document(s): ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.searchScopedDocumentChunks({
        datasetId,
        query,
        retrievalK,
        snippetCharLimit,
        manuals,
        allowedDocumentIds,
        sourceTitleSuffix,
      });
    }

    const citations = this.mapResultsToCitations(
      results,
      manuals,
      snippetCharLimit,
      allowedDocumentIds,
      sourceTitleSuffix,
      queryProfile,
    );

    if (
      citations.length > 0 ||
      !this.shouldUseScopedChunkFallback(allowedDocumentIds, manuals)
    ) {
      return citations;
    }

    this.logger.debug(
      `Scoped RAGFlow retrieval returned no usable citations for query="${query.replace(/\s+/g, ' ').trim()}"; falling back to chunk scan for ${allowedDocumentIds.size} document(s)`,
    );

    return this.searchScopedDocumentChunks({
      datasetId,
      query,
      retrievalK,
      snippetCharLimit,
      manuals,
      allowedDocumentIds,
      sourceTitleSuffix,
    });
  }

  private shouldUseScopedChunkFallback(
    allowedDocumentIds: Set<string> | null | undefined,
    manuals: SearchableManual[],
  ): allowedDocumentIds is Set<string> {
    if (!allowedDocumentIds?.size) {
      return false;
    }
    if (typeof this.ragflow.listDocumentChunks !== 'function') {
      return false;
    }
    if (allowedDocumentIds.size > MAX_SCOPED_CHUNK_FALLBACK_DOCUMENTS) {
      return false;
    }

    const knownDocumentIds = new Set(
      manuals
        .map((manual) => manual.ragflowDocumentId?.trim())
        .filter((value): value is string => Boolean(value)),
    );

    return [...allowedDocumentIds].every((id) => knownDocumentIds.has(id));
  }

  private async searchScopedDocumentChunks(params: {
    datasetId: string;
    query: string;
    retrievalK: number;
    snippetCharLimit: number;
    manuals: SearchableManual[];
    allowedDocumentIds: Set<string>;
    sourceTitleSuffix?: string;
  }): Promise<ContextCitation[]> {
    const {
      datasetId,
      query,
      retrievalK,
      snippetCharLimit,
      manuals,
      allowedDocumentIds,
      sourceTitleSuffix,
    } = params;
    const queryProfile = this.buildLexicalQueryProfile(query);

    if (queryProfile.tokens.length === 0) {
      return [];
    }

    const scoredResults: RAGFlowSearchResult[] = [];

    for (const documentId of allowedDocumentIds) {
      try {
        const chunks = await this.ragflow.listDocumentChunks(
          datasetId,
          documentId,
          300,
        );

        for (const chunk of chunks) {
          const score = this.scoreChunkLexically(queryProfile, chunk.content);
          if (score <= 0) {
            continue;
          }
          scoredResults.push({
            ...chunk,
            similarity: score,
          });
        }
      } catch (error) {
        this.logger.warn(
          `RAGFlow chunk scan fallback failed for document=${documentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (scoredResults.length === 0) {
      return [];
    }

    scoredResults.sort((left, right) => {
      if ((right.similarity ?? 0) !== (left.similarity ?? 0)) {
        return (right.similarity ?? 0) - (left.similarity ?? 0);
      }
      return left.id.localeCompare(right.id);
    });

    return this.mapResultsToCitations(
      scoredResults.slice(0, retrievalK),
      manuals,
      snippetCharLimit,
      allowedDocumentIds,
      sourceTitleSuffix,
      queryProfile,
    );
  }

  private buildLexicalQueryProfile(query: string): LexicalQueryProfile {
    const lexicalQuery = this.extractLexicalUserQuestion(query);
    const normalizedQuery = this.normalizeLexicalText(lexicalQuery);
    const upperStopWords = new Set([
      'A',
      'AN',
      'AND',
      'ARE',
      'FOR',
      'FROM',
      'HOW',
      'IN',
      'IS',
      'OF',
      'ON',
      'OR',
      'THE',
      'TO',
      'WHAT',
      'WHEN',
      'WHERE',
      'WHICH',
      'WITH',
    ]);
    const stopWords = new Set([
      'about',
      'and',
      'are',
      'can',
      'does',
      'describe',
      'for',
      'from',
      'give',
      'have',
      'how',
      'into',
      'manual',
      'need',
      'needs',
      'now',
      'of',
      'on',
      'page',
      'please',
      'say',
      'section',
      'should',
      'show',
      'tell',
      'that',
      'the',
      'this',
      'to',
      'what',
      'when',
      'where',
      'which',
      'will',
      'with',
      'would',
    ]);
    const tokens = [
      ...new Set(
        normalizedQuery
          .split(' ')
          .filter((token) => token.length > 2 && !stopWords.has(token)),
      ),
    ];
    const phrases = new Set<string>();

    for (let index = 0; index < tokens.length - 1; index += 1) {
      phrases.add(`${tokens[index]} ${tokens[index + 1]}`);
    }
    for (let index = 0; index < tokens.length - 2; index += 1) {
      phrases.add(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
    }

    const phraseList = [...phrases];
    const strongPhrases = phraseList.filter((phrase) => {
      const phraseTokens = phrase.split(' ');
      const substantiveTokens = phraseTokens.filter(
        (token) =>
          token.length >= 3 &&
          !stopWords.has(token) &&
          !REQUIRED_SUBJECT_TOKEN_STOP_WORDS.has(token) &&
          !/^\d+$/.test(token),
      );

      return substantiveTokens.length >= Math.min(2, phraseTokens.length);
    });

    const rawTokens = lexicalQuery.match(/[A-Za-z0-9]{2,16}/g) ?? [];
    const normalizedRawTokens = rawTokens
      .map((token) => this.normalizeLexicalText(token))
      .filter(Boolean);
    const upperAnchorTokens = rawTokens
      .filter((token) => {
        const hasLetter = /[A-Za-z]/.test(token);
        const hasDigit = /\d/.test(token);
        const isUpperSymbol =
          token === token.toUpperCase() &&
          /[A-Z]/.test(token) &&
          !upperStopWords.has(token);

        return hasLetter && (hasDigit || isUpperSymbol);
      })
      .map((token) => this.normalizeLexicalText(token))
      .filter((token) => token.length > 1);
    const lowercaseAcronymTokens = [
      ...new Set(
        normalizedRawTokens.filter(
          (token) =>
            /^[a-z]{3,4}$/.test(token) &&
            (token.match(/[aeiou]/g)?.length ?? 0) <= 1 &&
            !stopWords.has(token) &&
            !LOWERCASE_ACRONYM_STOP_WORDS.has(token),
        ),
      ),
    ];
    const inferredLowercaseAcronymTokens =
      lowercaseAcronymTokens.length >= 2 ? lowercaseAcronymTokens : [];

    const maintenanceIntervalPhrases = this.extractMaintenanceIntervalPhrases(
      lexicalQuery,
    );
    const wantsMaintenanceIntervalEvidence =
      maintenanceIntervalPhrases.length > 0 &&
      /\b(service|servicing|mainten[a-z]*|inspection|checks?|tasks?|schedule|overhaul|included|due|generator|genset|engine|pump|compressor|watermaker|separator|filter)\b/i.test(
        lexicalQuery,
      );

    return {
      tokens,
      phrases: phraseList,
      requiredSubjectTokens: tokens.filter(
        (token) =>
          token.length >= 6 &&
          !REQUIRED_SUBJECT_TOKEN_STOP_WORDS.has(token) &&
          !/^\d+$/.test(token),
      ),
      strongPhrases,
      anchorTokens: [
        ...new Set([
          ...upperAnchorTokens,
          ...inferredLowercaseAcronymTokens,
        ]),
      ],
      maintenanceIntervalPhrases,
      wantsMaintenanceIntervalEvidence,
      wantsProcedureEvidence:
        /\b(step\s*by\s*step|steps?|procedure|procedures|process|check\s*list|checklist|instructions?|how\s+(?:do|should)\s+i|what\s+should\s+i\s+do)\b/i.test(
          lexicalQuery,
        ) || wantsMaintenanceIntervalEvidence,
      wantsSpecificationEvidence:
        /\b(technical\s+data|technical\s+specifications?|specifications?|spec\s+sheet|data\s+sheet|rated|rating|ratings|parameters?|dimensions?|capacity|capacities|limits?|ranges?)\b/i.test(
          lexicalQuery,
        ),
    };
  }

  private scoreChunkLexically(
    queryProfile: LexicalQueryProfile,
    content: string,
  ): number {
    const normalizedContent = this.normalizeLexicalText(content);
    if (!normalizedContent) {
      return 0;
    }

    const contentTokens = new Set(normalizedContent.split(' '));
    const specificationHeadingScore = queryProfile.wantsSpecificationEvidence
      ? this.scoreSpecificationHeadingEvidence(content)
      : 0;
    const procedureEvidenceScore = queryProfile.wantsProcedureEvidence
      ? this.scoreProcedureEvidence(content, normalizedContent)
      : 0;
    const maintenanceIntervalEvidenceScore =
      queryProfile.wantsMaintenanceIntervalEvidence
        ? this.scoreMaintenanceIntervalEvidence(queryProfile, content, normalizedContent)
        : 0;
    if (queryProfile.anchorTokens.length > 0) {
      const anchorMatches = this.countAnchorMatches(
        queryProfile.anchorTokens,
        normalizedContent,
        contentTokens,
      );
      if (anchorMatches < Math.min(2, queryProfile.anchorTokens.length)) {
        return 0;
      }
    }
    if (
      queryProfile.requiredSubjectTokens.length > 0 &&
      this.countAnchorMatches(
        queryProfile.requiredSubjectTokens,
        normalizedContent,
        contentTokens,
      ) === 0 &&
      !this.hasStrongPhraseMatch(queryProfile, normalizedContent) &&
      specificationHeadingScore === 0 &&
      procedureEvidenceScore === 0 &&
      maintenanceIntervalEvidenceScore === 0
    ) {
      return 0;
    }

    let score = 0;
    let matchedTokens = 0;

    for (const token of queryProfile.tokens) {
      if (contentTokens.has(token)) {
        matchedTokens += 1;
        score += token.length >= 5 ? 1.4 : 1;
      } else if (token.length >= 6 && normalizedContent.includes(token)) {
        matchedTokens += 1;
        score += 0.6;
      }
    }

    let phraseMatches = 0;
    for (const phrase of queryProfile.phrases) {
      if (normalizedContent.includes(phrase)) {
        phraseMatches += 1;
        score += 1.75;
      }
    }

    if (queryProfile.wantsSpecificationEvidence) {
      score += this.scoreSpecificationEvidence(
        content,
        normalizedContent,
        specificationHeadingScore,
      );
    }

    if (queryProfile.wantsProcedureEvidence) {
      score += procedureEvidenceScore;
    }
    if (queryProfile.wantsMaintenanceIntervalEvidence) {
      score += maintenanceIntervalEvidenceScore;
    }

    if (
      matchedTokens === 0 &&
      specificationHeadingScore === 0 &&
      procedureEvidenceScore === 0 &&
      maintenanceIntervalEvidenceScore === 0
    ) {
      return 0;
    }

    const queryTokenCount = queryProfile.tokens.length;
    const enoughSignal =
      matchedTokens >= Math.min(2, queryTokenCount) ||
      phraseMatches > 0 ||
      specificationHeadingScore > 0 ||
      procedureEvidenceScore > 0 ||
      maintenanceIntervalEvidenceScore > 0 ||
      (queryTokenCount <= 2 &&
        queryProfile.tokens.some(
          (token) => token.length >= 5 && normalizedContent.includes(token),
        ));

    if (!enoughSignal) {
      return 0;
    }

    return score + matchedTokens / Math.max(1, queryTokenCount);
  }

  private scoreProcedureEvidence(
    rawContent: string,
    normalizedContent: string,
  ): number {
    let score = 0;

    const numberedSteps = rawContent.match(/\b\d{1,2}\.\s+\S/g) ?? [];
    if (numberedSteps.length >= 2) {
      score += Math.min(numberedSteps.length, 5);
    }
    if (/<table\b/i.test(rawContent)) {
      score += 2;
    }
    if (/[•·]/.test(rawContent)) {
      score += 2;
    }
    if (/\b(check\s*list|checklist|instructions?|steps?)\b/i.test(normalizedContent)) {
      score += 3;
    }
    if (
      /\b(prepare|ensure|establish|confirm|complete|commence|start|stop|check|monitor|inform|secure|remove|connect|disconnect|press|hold|open|close|raise|drop)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 2;
    }

    return score;
  }

  private scoreMaintenanceIntervalEvidence(
    queryProfile: LexicalQueryProfile,
    rawContent: string,
    normalizedContent: string,
  ): number {
    let score = 0;

    if (
      /\b(periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals?|maintenance\s+as\s+needed|maintenance\s+schedule|service\s+schedule)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 8;
    }
    if (
      /\b(before\s+starting|first\s+check\s+after|every\s+\d{2,6}|annual|annually|monthly|hours?|hrs?)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 5;
    }
    if (/<table\b/i.test(rawContent)) {
      score += 3;
    }
    if (
      /\b(general|fuel\s+system|lubrication\s+system|cooling\s+system|gas\s+intake|electrical\s+system|engine\s+and\s+assembly|remote\s+control\s+system)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 4;
    }
    if (
      /\b(replace|inspect|check|clean|change|verify|adjust|test|sample)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 3;
    }

    const intervalMatches = queryProfile.maintenanceIntervalPhrases.filter((phrase) =>
      normalizedContent.includes(phrase),
    ).length;
    score += intervalMatches * 6;

    if (
      intervalMatches === 0 &&
      /\b(fuel\s+circuit|diesel\s+fuel\s+inlet|fuel\s+outlet|inside\s+diameter|non-?return\s+valve|opening)\b/i.test(
        normalizedContent,
      )
    ) {
      score -= 6;
    }

    return score;
  }

  private extractMaintenanceIntervalPhrases(query: string): string[] {
    const phrases = new Set<string>();

    for (const match of query.matchAll(
      /\b(\d{2,6})\s*(h(?:ours?|rs?)?|hourly)\b/gi,
    )) {
      const value = match[1];
      phrases.add(`${value} hour`);
      phrases.add(`${value} hours`);
      phrases.add(`${value} hrs`);
      phrases.add(`every ${value}`);
    }

    for (const match of query.matchAll(/\b(\d{1,4})\s*(months?|month)\b/gi)) {
      const value = match[1];
      phrases.add(`${value} month`);
      phrases.add(`${value} months`);
      phrases.add(`every ${value}`);
    }

    for (const match of query.matchAll(/\b(\d{1,4})\s*(years?|year)\b/gi)) {
      const value = match[1];
      phrases.add(`${value} year`);
      phrases.add(`${value} years`);
      phrases.add(`every ${value}`);
    }

    if (/\bannual|annually\b/i.test(query)) {
      phrases.add('annual');
      phrases.add('annually');
    }

    return [...phrases];
  }

  private scoreSpecificationEvidence(
    rawContent: string,
    normalizedContent: string,
    headingScore: number = this.scoreSpecificationHeadingEvidence(rawContent),
  ): number {
    let score = headingScore;

    if (/(?:\btechnical data\b|\btechnical\s*data\d)/i.test(normalizedContent)) {
      score += 8;
    }
    if (
      /\b(technical specifications?|specifications?|data sheet|spec sheet|parameters?|ratings?)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 4;
    }
    if (/<table\b/i.test(rawContent)) {
      score += 3;
      if (
        /\b(value|unit|description|type|model|min|max|rated|nominal)\b/i.test(
          normalizedContent,
        )
      ) {
        score += 2;
      }
    }
    if (
      /\b(throughput|density|temperature|pressure|speed|capacity|dimension|weight|voltage|current|frequency|power|flow|rated|nominal)\b/i.test(
        normalizedContent,
      )
    ) {
      score += 3;
    }

    const unitMatches =
      normalizedContent.match(
        /\b\d+(?:\.\d+)?\s*(?:kw|kva|v|hz|rpm|bar|psi|c|kg|mm|cm|m3|l|liters?|litres?|gpm|lpm|mbar|mpa)\b/gi,
      ) ?? [];
    score += Math.min(unitMatches.length, 4);

    return score;
  }

  private scoreSpecificationHeadingEvidence(rawContent: string): number {
    const chunkStart = rawContent.trimStart().slice(0, 180);
    if (!chunkStart) {
      return 0;
    }

    const normalizedStart = this.normalizeLexicalText(chunkStart);
    if (
      SPECIFICATION_SECTION_HEADING_PATTERN.test(chunkStart) ||
      SPECIFICATION_SECTION_HEADING_PATTERN.test(normalizedStart)
    ) {
      return 18;
    }

    return 0;
  }

  private hasStrongPhraseMatch(
    queryProfile: LexicalQueryProfile,
    normalizedContent: string,
  ): boolean {
    return queryProfile.strongPhrases.some((phrase) =>
      normalizedContent.includes(phrase),
    );
  }

  private countAnchorMatches(
    anchorTokens: string[],
    normalizedContent: string,
    contentTokens: Set<string>,
  ): number {
    const compactContent = normalizedContent.replace(/\s+/g, '');
    return anchorTokens.filter((token) => {
      if (contentTokens.has(token)) {
        return true;
      }

      if (token.length <= 3) {
        return false;
      }

      return (
        normalizedContent.includes(token) || compactContent.includes(token)
      );
    }).length;
  }

  private normalizeLexicalText(value: string): string {
    return value
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_:./\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractLexicalUserQuestion(query: string): string {
    const trimmed = query.trim();
    const marker = ' document:';
    const markerIndex = trimmed.toLowerCase().indexOf(marker);
    if (trimmed.toLowerCase().startsWith('from ') && markerIndex >= 0) {
      const suffix = trimmed.slice(markerIndex + marker.length).trim();
      return suffix || trimmed;
    }

    return trimmed;
  }

  private mapResultsToCitations(
    results: RAGFlowSearchResult[],
    manuals: SearchableManual[],
    snippetCharLimit: number,
    allowedDocumentIds?: Set<string> | null,
    sourceTitleSuffix?: string,
    queryProfile?: LexicalQueryProfile,
  ): ContextCitation[] {
    const manualByDocumentId = new Map(
      manuals
        .map((manual) => [manual.ragflowDocumentId?.trim(), manual] as const)
        .filter((entry): entry is readonly [string, SearchableManual] =>
          Boolean(entry[0]),
        ),
    );

    return this.dedupeCitations(
      results
        .filter(
          (result) =>
            !allowedDocumentIds || allowedDocumentIds.has(result.doc_id),
        )
        .filter((result) =>
          this.hasEnoughLexicalEvidenceForQuery(result, queryProfile),
        )
        .map((result) => {
          const manual = manualByDocumentId.get(result.doc_id);
          const docName = result.doc_name || manual?.filename || 'Document';
          const rawContent = result.content ?? '';
          const snippet =
            rawContent.length > snippetCharLimit
              ? rawContent.slice(0, snippetCharLimit)
              : rawContent;

          return {
            shipManualId: manual?.id,
            chunkId: result.id,
            score: result.similarity ?? undefined,
            snippet,
            sourceTitle: sourceTitleSuffix
              ? `${docName} (${sourceTitleSuffix})`
              : docName,
            sourceCategory: manual?.category ?? undefined,
            sourceMetadataCategory: this.extractMetadataValue(
              result.meta,
              'category',
            ),
            sourceMetadataCategoryLabel: this.extractMetadataValue(
              result.meta,
              'category_label',
            ),
            pageNumber: (result.meta?.page_num as number) ?? undefined,
          };
        }),
    );
  }

  private hasEnoughLexicalEvidenceForQuery(
    result: RAGFlowSearchResult,
    queryProfile?: LexicalQueryProfile,
  ): boolean {
    if (
      !queryProfile ||
      (queryProfile.anchorTokens.length === 0 &&
        queryProfile.requiredSubjectTokens.length === 0)
    ) {
      return true;
    }

    return this.scoreChunkLexically(queryProfile, result.content ?? '') > 0;
  }

  private buildManualDocumentIdSet(
    manuals: SearchableManual[],
    enforceRestriction: boolean,
  ): Set<string> | null {
    if (!enforceRestriction) {
      return null;
    }

    const ids = manuals
      .map((manual) => manual.ragflowDocumentId?.trim())
      .filter((value): value is string => Boolean(value));

    return ids.length > 0 ? new Set(ids) : null;
  }

  private buildPreferredManualDocumentIdSet(
    allManuals: SearchableManual[],
    preferredManuals: SearchableManual[],
  ): Set<string> | null {
    const preferredIds = this.buildManualDocumentIdSet(preferredManuals, true);
    if (!preferredIds?.size) {
      return null;
    }

    const allIds = new Set(
      allManuals
        .map((manual) => manual.ragflowDocumentId?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    if (allIds.size === 0 || preferredIds.size >= allIds.size) {
      return null;
    }

    for (const id of preferredIds) {
      if (!allIds.has(id)) {
        return null;
      }
    }

    return preferredIds;
  }

  private hasSufficientScopedCitations(citations: ContextCitation[]): boolean {
    return citations.length > 0;
  }

  private getSnippetCharLimit(query: string): number {
    if (
      /\b(reference\s*id|1p\d{2,}|spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location|next\s*due|last\s*due|component\s*name|task\s*name|interval|parts?|spares?|part\s*numbers?|consumables?)\b/i.test(
        query,
      )
    ) {
      return Math.max(DEFAULT_RAGFLOW_CONTEXT_SNIPPET_CHARS, 7000);
    }

    return DEFAULT_RAGFLOW_CONTEXT_SNIPPET_CHARS;
  }

  private extractMetadataValue(
    meta: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = meta?.[key];
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
}
