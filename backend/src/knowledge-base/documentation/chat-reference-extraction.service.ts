import { Injectable } from '@nestjs/common';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatCitation, ChatSuggestionAction } from '../../chat-shared/chat.types';

interface MaintenanceRowContext {
  referenceId: string;
  componentName?: string;
  taskName?: string;
  responsible?: string;
  interval?: string;
  lastDue?: string;
  nextDue?: string;
}

interface MaintenanceRowCandidate extends MaintenanceRowContext {
  sourceTitle?: string;
  score: number;
  citationIndex: number;
  explicitRowEvidence: boolean;
}

interface ClarificationSuggestionCandidate {
  key: string;
  label: string;
  message: string;
  score: number;
}

const MAINTENANCE_REFERENCE_ID_PATTERN = /\b1[a-z]\d{2,}\b/i;
const MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN = /\b1[a-z]\d{2,}\b/g;

@Injectable()
export class ChatReferenceExtractionService {
  constructor(
    private readonly queryService: ChatDocumentationQueryService,
  ) {}

  buildClarificationActions(
    userQuery: string,
    citations: ChatCitation[],
  ): ChatSuggestionAction[] {
    const baseQuery = userQuery.trim().replace(/[?!.]+$/g, '');
    if (!baseQuery || citations.length === 0) {
      return [];
    }

    const candidates = this.buildClarificationSuggestionCandidates(
      baseQuery,
      citations.slice(0, 12),
    );
    const selected = candidates.slice(0, 4).map((candidate) => ({
      label: candidate.label,
      message: candidate.message,
      kind: 'suggestion' as const,
    }));

    if (selected.length <= 1) {
      return selected;
    }

    return [
      ...selected,
      {
        label: 'All',
        message: this.buildCombinedClarificationMessage(baseQuery, selected),
        kind: 'all',
      },
    ];
  }

  buildResolvedMaintenanceSubjectQuery(
    retrievalQuery: string,
    userQuery: string,
    citations: ChatCitation[],
  ): string | null {
    const queryContext = `${retrievalQuery}\n${userQuery}`;
    if (
      citations.length === 0 ||
      !this.shouldResolveToExactMaintenanceRow(queryContext)
    ) {
      return null;
    }

    const subjectTerms = this.queryService.extractRetrievalSubjectTerms(
      `${retrievalQuery} ${userQuery}`.trim(),
    );
    const requestedSide = this.queryService.detectDirectionalSide(queryContext);
    const shouldFocusGeneratorRows =
      Boolean(requestedSide) &&
      /\b(generator|genset|main\s+generator)\b/i.test(queryContext);
    const candidates = citations.reduce<MaintenanceRowCandidate[]>(
      (accumulator, citation, citationIndex) => {
        const focusedSnippet =
          shouldFocusGeneratorRows && requestedSide
            ? this.extractGeneratorScheduleSnippet(
                citation.snippet ?? '',
                requestedSide,
                queryContext,
              ) ??
              citation.snippet ??
              ''
            : citation.snippet ?? '';
        const scoringCitation =
          focusedSnippet === (citation.snippet ?? '')
            ? citation
            : {
                ...citation,
                snippet: focusedSnippet,
              };
        const context = this.extractMaintenanceRowContext(focusedSnippet);
        if (!context?.referenceId) {
          return accumulator;
        }

        accumulator.push({
          ...context,
          sourceTitle: citation.sourceTitle,
          citationIndex,
          explicitRowEvidence: this.hasExplicitMaintenanceRowEvidence(
            focusedSnippet,
          ),
          score: this.scoreMaintenanceRowCandidate(
            context,
            scoringCitation,
            queryContext,
            subjectTerms,
          ),
        });
        return accumulator;
      },
      [],
    );

    if (candidates.length === 0) return null;

    const leadingExplicitCandidate = [...candidates]
      .filter((candidate) => candidate.explicitRowEvidence)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.citationIndex !== right.citationIndex) {
          return left.citationIndex - right.citationIndex;
        }
        return (right.taskName ?? '').length - (left.taskName ?? '').length;
      })[0];
    if (leadingExplicitCandidate) {
      return this.buildMaintenanceSubjectQuery(leadingExplicitCandidate);
    }

    const groupedCandidates = new Map<
      string,
      {
        candidate: MaintenanceRowCandidate;
        aggregateScore: number;
        occurrenceCount: number;
        explicitEvidenceCount: number;
        bestCitationIndex: number;
      }
    >();
    for (const candidate of candidates) {
      const key = [
        this.queryService.normalizeSourceTitleHint(candidate.sourceTitle) ?? '',
        candidate.referenceId.toLowerCase(),
        this.normalizeMaintenanceField(candidate.componentName),
        this.normalizeMaintenanceField(candidate.taskName),
      ].join('|');

      const existing = groupedCandidates.get(key);
      if (!existing) {
        groupedCandidates.set(key, {
          candidate,
          aggregateScore: candidate.score,
          occurrenceCount: 1,
          explicitEvidenceCount: candidate.explicitRowEvidence ? 1 : 0,
          bestCitationIndex: candidate.citationIndex,
        });
        continue;
      }

      existing.aggregateScore += candidate.score;
      existing.occurrenceCount += 1;
      existing.explicitEvidenceCount += candidate.explicitRowEvidence ? 1 : 0;
      existing.bestCitationIndex = Math.min(
        existing.bestCitationIndex,
        candidate.citationIndex,
      );
      if (
        candidate.score > existing.candidate.score ||
        (candidate.score === existing.candidate.score &&
          candidate.citationIndex < existing.candidate.citationIndex)
      ) {
        existing.candidate = candidate;
      }
    }

    const rankedCandidates = [...groupedCandidates.values()].sort((left, right) => {
      if (right.explicitEvidenceCount !== left.explicitEvidenceCount) {
        return right.explicitEvidenceCount - left.explicitEvidenceCount;
      }

      if (right.aggregateScore !== left.aggregateScore) {
        return right.aggregateScore - left.aggregateScore;
      }

      if (right.occurrenceCount !== left.occurrenceCount) {
        return right.occurrenceCount - left.occurrenceCount;
      }

      if (left.bestCitationIndex !== right.bestCitationIndex) {
        return left.bestCitationIndex - right.bestCitationIndex;
      }

      if (right.candidate.score !== left.candidate.score) {
        return right.candidate.score - left.candidate.score;
      }

      const leftAnchorStrength =
        Number(Boolean(left.candidate.referenceId)) +
        Number(Boolean(left.candidate.taskName)) +
        Number(Boolean(left.candidate.componentName));
      const rightAnchorStrength =
        Number(Boolean(right.candidate.referenceId)) +
        Number(Boolean(right.candidate.taskName)) +
        Number(Boolean(right.candidate.componentName));
      if (rightAnchorStrength !== leftAnchorStrength) {
        return rightAnchorStrength - leftAnchorStrength;
      }

      return (right.candidate.taskName ?? '').length - (left.candidate.taskName ?? '').length;
    });

    const bestCandidate = rankedCandidates[0]?.candidate;
    if (!bestCandidate?.referenceId) return null;

    if (rankedCandidates.length > 1) {
      const secondCandidate = rankedCandidates[1]?.candidate;
      if (
        secondCandidate &&
        bestCandidate.referenceId !== secondCandidate.referenceId &&
        bestCandidate.score < secondCandidate.score + 2
      ) {
        return null;
      }
    }

    return this.buildMaintenanceSubjectQuery(bestCandidate);
  }

  private buildClarificationSuggestionCandidates(
    baseQuery: string,
    citations: ChatCitation[],
  ): ClarificationSuggestionCandidate[] {
    const candidates: ClarificationSuggestionCandidate[] = [];

    citations.forEach((citation, citationIndex) => {
      const context = this.extractMaintenanceRowContext(citation.snippet ?? '');
      if (context?.referenceId) {
        const maintenanceCandidate = this.buildMaintenanceClarificationCandidate(
          baseQuery,
          citation,
          context,
        );
        if (maintenanceCandidate) {
          candidates.push(maintenanceCandidate);
        }
      }

      const phraseCandidates = this.buildPhraseClarificationCandidates(
        baseQuery,
        citation,
        citationIndex,
      );
      candidates.push(...phraseCandidates);
    });

    const deduped = new Map<string, ClarificationSuggestionCandidate>();
    for (const candidate of candidates) {
      const existing = deduped.get(candidate.key);
      if (!existing || candidate.score > existing.score) {
        deduped.set(candidate.key, candidate);
      }
    }

    const dedupedCandidates = [...deduped.values()];
    const maintenanceCandidates = dedupedCandidates.filter((candidate) =>
      candidate.key.startsWith('maintenance:'),
    );
    if (maintenanceCandidates.length >= 2) {
      return maintenanceCandidates.sort((left, right) => right.score - left.score);
    }

    return dedupedCandidates
      .filter((candidate) => {
        if (!candidate.key.startsWith('phrase:')) {
          return true;
        }

        return !maintenanceCandidates.some((maintenanceCandidate) =>
          maintenanceCandidate.message
            .toLowerCase()
            .startsWith(`${candidate.message.toLowerCase()},`),
        );
      })
      .filter((candidate) => candidate.message.toLowerCase() !== baseQuery.toLowerCase())
      .sort((left, right) => right.score - left.score);
  }

  private buildMaintenanceClarificationCandidate(
    baseQuery: string,
    citation: ChatCitation,
    context: MaintenanceRowContext,
  ): ClarificationSuggestionCandidate | null {
    const subjectParts = [
      context.componentName,
      context.taskName,
      context.referenceId ? `Reference ID ${context.referenceId}` : '',
    ].filter(Boolean) as string[];
    if (subjectParts.length === 0) {
      return null;
    }

    const labelParts: string[] = [];
    if (context.taskName) {
      labelParts.push(this.humanizeClarificationText(context.taskName));
    }
    if (
      context.componentName &&
      !this.containsLoosely(context.taskName, context.componentName)
    ) {
      labelParts.push(this.humanizeClarificationText(context.componentName));
    }

    let label =
      labelParts.join(' - ') ||
      this.humanizeClarificationText(
        context.referenceId ? `Reference ID ${context.referenceId}` : subjectParts[0],
      );
    if (
      context.referenceId &&
      !label.toLowerCase().includes(context.referenceId.toLowerCase())
    ) {
      label = `${label} (${context.referenceId})`;
    }

    return {
      key: `maintenance:${context.referenceId.toLowerCase()}`,
      label: this.truncateClarificationLabel(label),
      message: this.buildClarificationFollowUpQuery(baseQuery, subjectParts),
      score:
        (citation.score ?? 0) * 10 +
        30 +
        (context.taskName ? 8 : 0) +
        (context.componentName ? 5 : 0),
    };
  }

  private buildPhraseClarificationCandidates(
    baseQuery: string,
    citation: ChatCitation,
    citationIndex: number,
  ): ClarificationSuggestionCandidate[] {
    const text = this.normalizeReferenceExtractedText(
      this.stripHtmlLikeMarkup(citation.snippet ?? ''),
    );
    if (!text) {
      return [];
    }

    const phrases = this.extractClarificationSubjectPhrases(text);
    return phrases.map((phrase, phraseIndex) => ({
      key: `phrase:${phrase.toLowerCase()}`,
      label: this.truncateClarificationLabel(
        this.humanizeClarificationText(phrase),
      ),
      message: this.buildClarificationFollowUpQuery(baseQuery, [phrase]),
      score:
        (citation.score ?? 0) * 10 +
        this.scoreClarificationPhrase(phrase) -
        citationIndex -
        phraseIndex,
    }));
  }

  private extractClarificationSubjectPhrases(text: string): string[] {
    const matches = text.match(
      /\b(?:port|starboard|ps|sb|main|aux(?:iliary)?|sea|water|fuel|oil|coolant|air|hydraulic|alternator|engine|generator|genset|pump|filter|gearbox|compressor|watermaker|cooler|tank|valve|thermostat|sensor|battery|exhaust|shaft|impeller|anode|belt|system)(?:[\s/-]+(?:port|starboard|ps|sb|main|aux(?:iliary)?|sea|water|fuel|oil|coolant|air|hydraulic|alternator|engine|generator|genset|pump|filter|gearbox|compressor|watermaker|cooler|tank|valve|thermostat|sensor|battery|exhaust|shaft|impeller|anode|belt|system)){0,4}\b/gi,
    ) ?? [];

    const unique = new Set<string>();
    for (const match of matches) {
      const normalized = this.normalizeReferenceExtractedText(match)
        .replace(/\s+/g, ' ')
        .trim();
      if (
        normalized &&
        this.scoreClarificationPhrase(normalized) >= 4 &&
        !this.isOverlyGenericClarificationPhrase(normalized)
      ) {
        unique.add(normalized);
      }
    }

    return [...unique].slice(0, 6);
  }

  private scoreClarificationPhrase(phrase: string): number {
    const normalized = phrase.toLowerCase();
    let score = 0;

    if (/\b(port|starboard|ps|sb)\b/i.test(normalized)) {
      score += 4;
    }
    if (
      /\b(generator|genset|engine|pump|filter|gearbox|compressor|watermaker|cooler|tank|valve|thermostat|sensor|battery|exhaust|shaft|impeller|anode|belt|system)\b/i.test(
        normalized,
      )
    ) {
      score += 4;
    }
    if (normalized.split(/\s+/).length >= 2) {
      score += 2;
    }

    return score;
  }

  private isOverlyGenericClarificationPhrase(phrase: string): boolean {
    return /^(?:oil|coolant|filter|filters|system|maintenance|service|task|tasks|parts?|spares?)$/i.test(
      phrase.trim(),
    );
  }

  private buildClarificationFollowUpQuery(
    baseQuery: string,
    subjectParts: string[],
  ): string {
    const subject = subjectParts
      .map((part) => this.normalizeClarificationSubjectPart(part))
      .filter(Boolean)
      .join(', ');
    if (!subject) {
      return baseQuery;
    }

    return `${baseQuery} for ${subject}`.replace(/\s+/g, ' ').trim();
  }

  private normalizeClarificationSubjectPart(value: string): string {
    const compacted = value.replace(/\s+/g, ' ').trim();
    const referenceIdMatch = compacted.match(
      /^reference\s*id\s+([a-z0-9-]+)$/i,
    );
    if (referenceIdMatch?.[1]) {
      return `Reference ID ${referenceIdMatch[1].replace(/\s+/g, '').toUpperCase()}`;
    }

    return this.humanizeClarificationText(compacted);
  }

  private buildCombinedClarificationMessage(
    baseQuery: string,
    actions: Array<{ label: string; message: string }>,
  ): string {
    return [
      `Please answer all of the following related to "${baseQuery}":`,
      ...actions.map((action, index) => `${index + 1}. ${action.message}`),
    ].join('\n');
  }

  private humanizeClarificationText(value: string): string {
    const normalized = this.normalizeReferenceExtractedText(value)
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return normalized;
    }

    return normalized
      .split(' ')
      .map((token) => this.formatClarificationToken(token))
      .join(' ');
  }

  private truncateClarificationLabel(label: string): string {
    if (label.length <= 84) {
      return label;
    }

    return `${label.slice(0, 81).trim()}...`;
  }

  private formatClarificationToken(token: string): string {
    return token
      .split(/([/-])/)
      .map((segment) => {
        if (segment === '/' || segment === '-') {
          return segment;
        }

        return this.formatClarificationWord(segment);
      })
      .join('');
  }

  private formatClarificationWord(word: string): string {
    if (!word) {
      return word;
    }

    const upper = word.toUpperCase();
    if (
      ['PS', 'SB', 'SCR', 'ECU', 'DEF', 'IMO', 'ID'].includes(upper) ||
      /^[A-Z]+\d+[A-Z0-9-]*$/i.test(word) ||
      /^\d+[A-Z]+[A-Z0-9-]*$/i.test(word)
    ) {
      return upper;
    }

    if (/^\d+$/.test(word)) {
      return word;
    }

    const lower = word.toLowerCase();
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }

  private containsLoosely(value?: string, needle?: string): boolean {
    if (!value || !needle) return false;

    const left = value.toLowerCase().replace(/\s+/g, ' ').trim();
    const right = needle.toLowerCase().replace(/\s+/g, ' ').trim();
    return left.includes(right);
  }

  private hasMaintenanceReferenceId(text: string): boolean {
    return MAINTENANCE_REFERENCE_ID_PATTERN.test(text);
  }

  private extractMaintenanceReferenceId(text?: string | null): string | null {
    return text?.match(MAINTENANCE_REFERENCE_ID_PATTERN)?.[0]?.toUpperCase() ?? null;
  }

  extractMaintenanceRowContext(snippet: string): MaintenanceRowContext | null {
    if (!snippet.trim()) return null;

    const labeledContext = this.parseMaintenanceRowContext(snippet);
    if (labeledContext?.referenceId) {
      return labeledContext;
    }

    const rows = snippet.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    for (const row of rows) {
      if (!this.hasMaintenanceReferenceId(this.stripHtmlLikeMarkup(row))) {
        continue;
      }

      const summary = this.buildScheduleRowSummary(row);
      const parsedSummary = summary
        ? this.parseMaintenanceRowContext(summary)
        : null;
      if (parsedSummary?.referenceId) {
        return parsedSummary;
      }
    }

    const plainSnippet = this.normalizeReferenceExtractedText(
      this.stripHtmlLikeMarkup(snippet),
    );
    return this.parseMaintenanceRowContext(plainSnippet);
  }

  focusReferenceSnippet(snippet: string, referenceId: string): string {
    if (!snippet) return snippet;

    const normalizedReference = referenceId.toLowerCase();
    if (!snippet.toLowerCase().includes(normalizedReference)) {
      return snippet.trim();
    }

    const tables = snippet.match(/<table[\s\S]*?<\/table>/gi) ?? [];
    const matchingTableEntries = tables
      .map((table, index) => ({ table, index }))
      .filter((entry) => entry.table.toLowerCase().includes(normalizedReference));
    if (matchingTableEntries.length > 0) {
      const anchorEntry = [...matchingTableEntries].sort(
        (left, right) =>
          this.scoreReferenceFocusBlock(right.table, referenceId) -
          this.scoreReferenceFocusBlock(left.table, referenceId),
      )[0];

      const selectedTables = [anchorEntry.table];
      for (
        let index = anchorEntry.index + 1;
        index < Math.min(tables.length, anchorEntry.index + 4);
        index += 1
      ) {
        const candidateTable = tables[index];
        const candidateHaystack = this.stripHtmlLikeMarkup(candidateTable).toLowerCase();
        const mentionedReferenceIds = [
          ...candidateHaystack.matchAll(MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN),
        ].map((match) => match[0].toLowerCase());
        if (
          mentionedReferenceIds.some(
            (mentionedReferenceId) => mentionedReferenceId !== normalizedReference,
          )
        ) {
          break;
        }

        if (
          !/\b(spare\s*name|quantity|location|manufacturer\s*part#?|supplier\s*part#?|replace|inspect|check|clean|adjust|overhaul|sample|test|wear\s*kit|filter|impeller|belt|anode|coolant|pump)\b/i.test(
            candidateHaystack,
          )
        ) {
          break;
        }

        selectedTables.push(candidateTable);
      }

      return selectedTables.join('\n').trim();
    }

    const rows = snippet.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const referenceRowIndex = rows.findIndex((row) =>
      row.toLowerCase().includes(normalizedReference),
    );
    if (referenceRowIndex >= 0) {
      const selectedRows: string[] = [];
      const previousRow = rows[referenceRowIndex - 1];
      if (
        previousRow &&
        /\b(component\s*name|task\s*name|reference\s*id|responsible|interval|last\s*due|next\s*due|costs?)\b/i.test(
          this.stripHtmlLikeMarkup(previousRow),
        )
      ) {
        selectedRows.push(previousRow);
      }

      for (
        let index = referenceRowIndex;
        index < Math.min(rows.length, referenceRowIndex + 40);
        index += 1
      ) {
        const row = rows[index];
        if (
          index > referenceRowIndex &&
          this.hasMaintenanceReferenceId(row) &&
          !row.toLowerCase().includes(normalizedReference)
        ) {
          break;
        }
        selectedRows.push(row);
      }

      if (selectedRows.length > 0) {
        return selectedRows.join('\n').trim();
      }
    }

    return snippet.trim();
  }

  extractGeneratorScheduleSnippet(
    snippet: string,
    side: 'port' | 'starboard',
    queryText?: string,
  ): string | null {
    if (!snippet) return null;

    const rows = snippet.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const rowMatches = rows
      .map((row, index) => ({
        index,
        row,
        plain: this.stripHtmlLikeMarkup(row).toLowerCase(),
      }))
      .filter(
        (entry) =>
          /\b(generator|genset|main\s+generator)\b/i.test(entry.plain) &&
          this.queryService.matchesDirectionalSide(entry.plain, side) &&
          this.hasMaintenanceReferenceId(entry.plain),
      );

    if (rowMatches.length > 0) {
      const bestMatch = [...rowMatches]
        .map((target) => {
          const referenceId =
            this.extractMaintenanceReferenceId(target.plain)?.toLowerCase() ??
            null;
          const extracted =
            this.buildGeneratorScheduleCandidateSnippet(
              snippet,
              rows,
              target.index,
              referenceId,
            ) ?? target.row;

          return {
            extracted,
            score: this.scoreGeneratorScheduleCandidate(
              extracted,
              queryText,
              referenceId,
            ),
          };
        })
        .sort((left, right) => right.score - left.score)[0];

      if (bestMatch?.extracted) {
        return bestMatch.extracted;
      }
    }

    const plainSnippet = this.stripHtmlLikeMarkup(snippet);
    const lines = plainSnippet
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const lineIndex = lines.findIndex(
      (line) =>
        /\b(generator|genset|main\s+generator)\b/i.test(line) &&
        this.queryService.matchesDirectionalSide(line, side) &&
        this.hasMaintenanceReferenceId(line),
    );
    if (lineIndex < 0) return null;

    const previousLine = lines[lineIndex - 1] ?? '';
    const startIndex =
      previousLine && this.hasMaintenanceReferenceId(previousLine)
        ? lineIndex
        : Math.max(0, lineIndex - 1);

    return lines.slice(startIndex, lineIndex + 1).join('\n');
  }

  private buildGeneratorScheduleCandidateSnippet(
    snippet: string,
    rows: string[],
    targetIndex: number,
    referenceId: string | null,
  ): string | null {
    if (referenceId) {
      const focused = this.focusReferenceRowWindow(snippet, referenceId);
      const combined = this.buildReferenceCombinedSnippet(referenceId, [focused]);
      if (combined) {
        return combined;
      }

      return focused;
    }

    const targetRow = rows[targetIndex];
    if (!targetRow) return null;

    const summary = this.buildScheduleRowSummary(targetRow);
    if (summary) {
      return summary;
    }

    const selectedRows: string[] = [];
    const previousRow = rows[targetIndex - 1];
    if (
      previousRow &&
      /\b(component\s*name|task\s*name|reference\s*id|responsible|interval|last\s*due|next\s*due|costs)\b/i.test(
        this.stripHtmlLikeMarkup(previousRow),
      )
    ) {
      selectedRows.push(previousRow);
    }
    selectedRows.push(targetRow);
    return selectedRows.join('\n').trim();
  }

  private focusReferenceRowWindow(snippet: string, referenceId: string): string {
    const normalizedReference = referenceId.toLowerCase();
    const rows = snippet.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const referenceRowIndex = rows.findIndex((row) =>
      row.toLowerCase().includes(normalizedReference),
    );
    if (referenceRowIndex < 0) {
      return this.focusReferenceSnippet(snippet, referenceId);
    }

    const selectedRows: string[] = [];
    const previousRow = rows[referenceRowIndex - 1];
    if (
      previousRow &&
      /\b(component\s*name|task\s*name|reference\s*id|responsible|interval|last\s*due|next\s*due|costs?)\b/i.test(
        this.stripHtmlLikeMarkup(previousRow),
      )
    ) {
      selectedRows.push(previousRow);
    }

    for (
      let index = referenceRowIndex;
      index < Math.min(rows.length, referenceRowIndex + 40);
      index += 1
    ) {
      const row = rows[index];
      if (
        index > referenceRowIndex &&
        this.hasMaintenanceReferenceId(row) &&
        !row.toLowerCase().includes(normalizedReference)
      ) {
        break;
      }
      selectedRows.push(row);
    }

    return selectedRows.length > 0
      ? selectedRows.join('\n').trim()
      : this.focusReferenceSnippet(snippet, referenceId);
  }

  private scoreGeneratorScheduleCandidate(
    snippet: string,
    queryText?: string,
    referenceId?: string | null,
  ): number {
    const haystack = this.normalizeReferenceExtractedText(snippet).toLowerCase();
    const query = queryText ?? '';
    const queryKeywords = this.extractReferenceSemanticKeywords(query);
    const wantsNextDue = this.queryService.isNextDueLookupQuery(query);
    const wantsParts = this.queryService.isPartsQuery(query);
    const wantsProcedure = this.queryService.isProcedureQuery(query);

    let score = 0;
    score += referenceId ? 8 : 0;
    score += /\breference row\b/i.test(haystack) ? 6 : 0;
    score += /\bincluded work items\b/i.test(haystack) ? 5 : 0;
    score += /\bspare parts\b/i.test(haystack) ? 4 : 0;

    const keywordOverlap = queryKeywords.filter((keyword) =>
      this.matchesReferenceSemanticKeyword(haystack, keyword),
    ).length;
    score += keywordOverlap * 10;

    if (
      queryKeywords.includes('oil') &&
      /\b(replace oil and filters|take oil sample|engine oil|oil filter|oil bypass filter)\b/i.test(
        haystack,
      )
    ) {
      score += 12;
    }

    if (
      queryKeywords.includes('filter') &&
      /\b(fuel prefilter and filter|fuel filter|air filter|oil filter|bypass filter)\b/i.test(
        haystack,
      )
    ) {
      score += 6;
    }

    if (queryKeywords.length > 0 && keywordOverlap === 0) {
      score -= 6;
    }

    if (wantsProcedure && /\bincluded work items\b/i.test(haystack)) {
      score += 4;
    }

    if (wantsParts && /\bspare parts\b/i.test(haystack)) {
      score += 4;
    }

    if (wantsNextDue) {
      const context = this.extractMaintenanceRowContext(snippet);
      if (context?.nextDue) {
        score += 4;
        const nextDueHours = context.nextDue.match(/\/\s*(\d{2,6})\b/)?.[1];
        if (nextDueHours) {
          score += Math.max(0, 8 - Number.parseInt(nextDueHours, 10) / 1000);
        }
      }
    }

    return score;
  }

  private matchesReferenceSemanticKeyword(
    haystack: string,
    keyword: string,
  ): boolean {
    switch (keyword) {
      case 'wear-kit':
        return /\bwear\s*kit\b/i.test(haystack);
      case 'filter':
        return /\bfilters?\b/i.test(haystack);
      case 'belt':
        return /\bbelts?\b/i.test(haystack);
      case 'impeller':
        return /\bimpellers?\b/i.test(haystack);
      case 'anode':
        return /\banodes?\b/i.test(haystack);
      case 'coolant':
        return /\bcoolant\b/i.test(haystack);
      case 'pump':
        return /\bpump\b/i.test(haystack);
      case 'thermostat':
        return /\bthermostats?\b/i.test(haystack);
      case 'seal':
        return /\bseals?\b/i.test(haystack);
      case 'bearing':
        return /\bbearings?\b/i.test(haystack);
      case 'oil':
        return /\boil\b/i.test(haystack);
      case 'gasket':
        return /\bgaskets?\b/i.test(haystack);
      case 'sea-water':
        return /\bsea\s*water\b|\bseawater\b/i.test(haystack);
      default:
        return haystack.includes(keyword.toLowerCase());
    }
  }

  buildReferenceCombinedSnippet(
    referenceId: string,
    snippets: string[],
  ): string | null {
    if (snippets.length === 0) return null;

    const normalizedReference = referenceId.toLowerCase();
    const focusedSnippets = snippets
      .map((snippet) =>
        snippet.toLowerCase().includes(normalizedReference)
          ? this.focusReferenceSnippet(snippet, referenceId)
          : snippet.trim(),
      )
      .filter(Boolean);
    const anchorSnippetIndex = focusedSnippets.findIndex((snippet) =>
      snippet.toLowerCase().includes(normalizedReference),
    );
    const snippetWindow =
      anchorSnippetIndex >= 0
        ? focusedSnippets.slice(anchorSnippetIndex, anchorSnippetIndex + 4)
        : focusedSnippets;

    let referenceRowSummary: string | null = null;
    const extractionSources = this.buildReferenceExtractionSources(snippetWindow);
    const taskItems = this.extractReferenceTaskItems(extractionSources);
    const spareParts = this.extractReferenceSpareParts(
      extractionSources,
      taskItems,
    );
    const continuationLines: string[] = [];
    const seenLines = new Set<string>();

    for (const snippet of snippetWindow) {
      if (!referenceRowSummary) {
        referenceRowSummary = this.extractReferenceRowSummary(
          snippet,
          referenceId,
        );
      }

      if (taskItems.length > 0 || spareParts.length > 0) {
        continue;
      }

      for (const line of this.extractMarkupLines(snippet)) {
        const normalizedLine = line.toLowerCase();
        if (normalizedLine.includes(referenceId.toLowerCase())) {
          continue;
        }

        if (
          !/\b(replace|inspect|check|clean|adjust|overhaul|sample|test|spare\s*name|quantity|location|manufacturer\s*part#?|supplier\s*part#?|wear\s*kit|filter|impeller|belt|anode|coolant|pump)\b/i.test(
            line,
          )
        ) {
          continue;
        }

        const dedupeKey = line.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!dedupeKey || seenLines.has(dedupeKey)) {
          continue;
        }
        seenLines.add(dedupeKey);
        continuationLines.push(line);
      }
    }

    if (!referenceRowSummary && continuationLines.length === 0) {
      return null;
    }

    const sections: string[] = [];
    if (referenceRowSummary) {
      sections.push(`Reference row:\n${referenceRowSummary}`);
    }
    if (taskItems.length > 0) {
      sections.push(
        `Included work items:\n${taskItems
          .slice(0, 24)
          .map((item) => `- ${item}`)
          .join('\n')}`,
      );
    }
    if (spareParts.length > 0) {
      sections.push(
        `Spare parts:\n${spareParts
          .slice(0, 16)
          .map((part) => this.formatReferenceSparePartSummary(part))
          .join('\n\n')}`,
      );
    }
    if (continuationLines.length > 0) {
      sections.push(
        `Same-page continuation:\n${continuationLines.slice(0, 24).join('\n')}`,
      );
    }

    return sections.join('\n\n').trim();
  }

  private buildReferenceExtractionSources(snippets: string[]): string[] {
    const sources = snippets.map((snippet) => snippet.trim()).filter(Boolean);
    const combined = new Set(sources);

    for (let index = 0; index < sources.length - 1; index += 1) {
      combined.add(`${sources[index]}\n${sources[index + 1]}`);
    }

    for (let index = 0; index < sources.length - 2; index += 1) {
      combined.add(
        `${sources[index]}\n${sources[index + 1]}\n${sources[index + 2]}`,
      );
    }

    if (sources.length > 1) {
      combined.add(sources.join('\n'));
    }

    return [...combined];
  }

  private extractReferenceTaskItems(snippets: string[]): string[] {
    const seen = new Set<string>();
    const taskItems: string[] = [];

    for (const snippet of snippets) {
      for (const line of this.extractMarkupLines(snippet)) {
        const normalizedLine = this.normalizeReferenceExtractedText(line);
        if (
          !/\b(replace|inspect|check|clean|adjust|overhaul|sample|test)\b/i.test(
            normalizedLine,
          )
        ) {
          continue;
        }

        if (
          /\b(spare\s*name|quantity|location|manufacturer\s*part#?|supplier\s*part#?|reference\s*id|component\s*name|task\s*name|responsible|interval|last\s*due|next\s*due|costs?|chief engineer|genset|eur)\b/i.test(
            normalizedLine,
          )
        ) {
          continue;
        }

        if (this.hasMaintenanceReferenceId(normalizedLine)) {
          continue;
        }

        if (!normalizedLine || normalizedLine.length < 8) {
          continue;
        }

        const dedupeKey = normalizedLine.toLowerCase();
        if (seen.has(dedupeKey)) {
          continue;
        }

        seen.add(dedupeKey);
        taskItems.push(normalizedLine);
      }
    }

    return taskItems;
  }

  private extractReferenceSpareParts(
    snippets: string[],
    taskItems: string[],
  ): Array<{
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  }> {
    const candidates: Array<{
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
      score: number;
    }> = [];

    const taskKeywords = new Set(
      taskItems.flatMap((item) => this.extractReferenceSemanticKeywords(item)),
    );

    for (const snippet of snippets) {
      const rows = snippet.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
      for (let index = 0; index < rows.length; index += 1) {
        const headerCells = this.extractTableCells(rows[index]);
        if (!this.isReferenceSparePartHeaderRow(headerCells)) {
          continue;
        }

        for (
          let valueIndex = index + 1;
          valueIndex < Math.min(rows.length, index + 30);
          valueIndex += 1
        ) {
          const valueCells = this.extractTableCells(rows[valueIndex]);
          const flattenedRow = this.normalizeReferenceExtractedText(
            this.stripHtmlLikeMarkup(rows[valueIndex]),
          );
          if (this.isReferenceSparePartHeaderRow(valueCells)) {
            break;
          }
          if (
            this.hasMaintenanceReferenceId(flattenedRow) ||
            /\b(component\s*name|task\s*name|reference\s*id|responsible|interval|last\s*due|next\s*due|costs?)\b/i.test(
              flattenedRow,
            )
          ) {
            break;
          }

          const candidate = this.normalizeReferenceSparePartCandidate(
            this.parseReferenceSparePartTableRow(valueCells),
          );
          if (!candidate) {
            continue;
          }

          candidates.push({
            ...candidate,
            score:
              this.scoreReferenceSparePartCandidate(candidate, taskKeywords) + 6,
          });
        }
      }

      for (const row of rows) {
        const candidate = this.normalizeReferenceSparePartCandidate(
          this.parseReferenceSparePartCandidate(
            this.normalizeReferenceExtractedText(this.stripHtmlLikeMarkup(row)),
          ),
        );
        if (!candidate) {
          continue;
        }

        candidates.push({
          ...candidate,
          score: this.scoreReferenceSparePartCandidate(candidate, taskKeywords),
        });
      }

      for (const candidate of this.extractReferenceSparePartLineCandidates(
        snippet,
      )) {
        const normalizedCandidate =
          this.normalizeReferenceSparePartCandidate(candidate);
        if (!normalizedCandidate) {
          continue;
        }
        candidates.push({
          ...normalizedCandidate,
          score:
            this.scoreReferenceSparePartCandidate(
              normalizedCandidate,
              taskKeywords,
            ) + 5,
        });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    const merged: Array<{
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
      score: number;
    }> = [];

    for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
      const existing = merged.find((entry) =>
        this.referenceSparePartCandidatesMatch(entry, candidate),
      );
      if (existing) {
        existing.spareName ||= candidate.spareName;
        existing.quantity ||= candidate.quantity;
        existing.location ||= candidate.location;
        existing.manufacturerPart ||= candidate.manufacturerPart;
        existing.supplierPart ||= candidate.supplierPart;
        existing.score = Math.max(existing.score, candidate.score);
        continue;
      }

      merged.push({ ...candidate });
    }

    const normalizedMerged = this.mergeComplementaryReferenceSparePartCandidates(
      merged,
      taskKeywords,
    );

    return normalizedMerged
      .filter((candidate) => {
        const completeness =
          Number(Boolean(candidate.spareName)) +
          Number(Boolean(candidate.quantity)) +
          Number(Boolean(candidate.location)) +
          Number(Boolean(candidate.manufacturerPart)) +
          Number(Boolean(candidate.supplierPart));
        const hasValidManufacturerPart = candidate.manufacturerPart
          ? this.looksLikeReferencePartNumber(candidate.manufacturerPart)
          : false;
        const hasValidSupplierPart = candidate.supplierPart
          ? this.looksLikeReferencePartNumber(candidate.supplierPart)
          : false;
        const hasValidPartNumber =
          hasValidManufacturerPart || hasValidSupplierPart;
        const hasStructuredPartData = Boolean(
          hasValidPartNumber ||
            (candidate.location &&
              this.looksLikeReferenceLocation(candidate.location)),
        );
        const hasTaskKeywordAlignment = this.extractReferenceSemanticKeywords(
          [
            candidate.spareName,
            candidate.location,
            candidate.manufacturerPart,
            candidate.supplierPart,
          ]
            .filter(Boolean)
            .join(' '),
        ).some((keyword) => taskKeywords.has(keyword));
        const actionLikeSpareName =
          candidate.spareName &&
          /\b(replace|inspect|check|clean|adjust|overhaul|sample|test)\b/i.test(
            candidate.spareName,
          );

        return (
          completeness >= 2 &&
          candidate.score > 0 &&
          (hasStructuredPartData || hasTaskKeywordAlignment) &&
          (!actionLikeSpareName || hasValidPartNumber)
        );
      })
      .sort((a, b) => b.score - a.score)
      .map(({ score: _score, ...candidate }) => candidate);
  }

  private isReferenceSparePartHeaderRow(cells: string[]): boolean {
    if (cells.length === 0) {
      return false;
    }

    const normalized = cells
      .map((cell) => this.normalizeReferenceExtractedText(cell).toLowerCase())
      .join(' ');

    return (
      normalized.includes('spare name') &&
      normalized.includes('quantity') &&
      normalized.includes('location') &&
      normalized.includes('manufacturer part') &&
      normalized.includes('supplier part')
    );
  }

  private parseReferenceSparePartTableRow(cells: string[]): {
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  } | null {
    const normalizedCells = cells
      .map((cell) => this.normalizeReferenceExtractedText(cell))
      .filter(Boolean);
    if (normalizedCells.length === 0) {
      return null;
    }

    if (normalizedCells.length >= 5) {
      const [spareName, quantity, location, manufacturerPart, supplierPart] =
        normalizedCells;
      const candidate = {
        spareName: this.stripReferenceFieldLabel(spareName, 'spare name'),
        quantity: this.stripReferenceFieldLabel(quantity, 'quantity'),
        location: this.stripReferenceFieldLabel(location, 'location'),
        manufacturerPart: this.stripReferenceFieldLabel(
          manufacturerPart,
          'manufacturer part#',
        ),
        supplierPart: this.stripReferenceFieldLabel(
          supplierPart,
          'supplier part#',
        ),
      };
      if (
        candidate.spareName &&
        candidate.quantity &&
        candidate.location &&
        (candidate.manufacturerPart || candidate.supplierPart)
      ) {
        return candidate;
      }
    }

    if (
      normalizedCells.length === 4 &&
      this.looksLikeReferencePartNumber(normalizedCells[2]) &&
      this.looksLikeReferencePartNumber(normalizedCells[3])
    ) {
      const [spareName, location, manufacturerPart, supplierPart] =
        normalizedCells;
      if (!spareName || !location) {
        return null;
      }

      return {
        spareName: this.stripReferenceFieldLabel(spareName, 'spare name'),
        location: this.stripReferenceFieldLabel(location, 'location'),
        manufacturerPart: this.stripReferenceFieldLabel(
          manufacturerPart,
          'manufacturer part#',
        ),
        supplierPart: this.stripReferenceFieldLabel(
          supplierPart,
          'supplier part#',
        ),
      };
    }

    if (
      normalizedCells.length === 4 &&
      /^\d{1,3}$/.test(normalizedCells[1])
    ) {
      const [spareName, quantity, location, trailingPart] = normalizedCells;
      if (!spareName || !location || !this.looksLikeReferencePartNumber(trailingPart)) {
        return null;
      }

      return {
        spareName: this.stripReferenceFieldLabel(spareName, 'spare name'),
        quantity: this.stripReferenceFieldLabel(quantity, 'quantity'),
        location: this.stripReferenceFieldLabel(location, 'location'),
        manufacturerPart: /^SYS/i.test(trailingPart) ? undefined : trailingPart,
        supplierPart: /^SYS|^MM/i.test(trailingPart) ? trailingPart : undefined,
      };
    }

    if (
      normalizedCells.length === 3 &&
      !this.looksLikeReferencePartNumber(normalizedCells[1]) &&
      this.looksLikeReferencePartNumber(normalizedCells[2])
    ) {
      const [spareName, location, trailingPart] = normalizedCells;
      if (!spareName || !location) {
        return null;
      }

      return {
        spareName: this.stripReferenceFieldLabel(spareName, 'spare name'),
        location: this.stripReferenceFieldLabel(location, 'location'),
        manufacturerPart: /^SYS|^MM/i.test(trailingPart) ? undefined : trailingPart,
        supplierPart: /^SYS|^MM/i.test(trailingPart) ? trailingPart : undefined,
      };
    }

    if (
      normalizedCells.length === 3 &&
      this.looksLikeReferencePartNumber(normalizedCells[1]) &&
      this.looksLikeReferencePartNumber(normalizedCells[2])
    ) {
      return {
        location: normalizedCells[0],
        manufacturerPart: normalizedCells[1],
        supplierPart: normalizedCells[2],
      };
    }

    const flattened = normalizedCells.join(' ').trim();
    if (!flattened) {
      return null;
    }

    if (
      this.hasMaintenanceReferenceId(flattened) ||
      /\b(reference\s*id|responsible|interval|last\s*due|next\s*due|costs?)\b/i.test(
        flattened,
      )
    ) {
      return null;
    }

    const tokens = flattened.split(/\s+/);
    if (tokens.length < 5) {
      return null;
    }

    const supplierIndex = [...tokens.keys()]
      .reverse()
      .find((index) => /^[A-Z0-9-]{5,}$/i.test(tokens[index]));
    if (supplierIndex === undefined || supplierIndex < 3) {
      return null;
    }

    const manufacturerIndex = [...tokens.keys()]
      .slice(0, supplierIndex)
      .reverse()
      .find((index) => /^[A-Z0-9-]{5,}$/i.test(tokens[index]));
    if (
      manufacturerIndex === undefined ||
      manufacturerIndex <= 1 ||
      manufacturerIndex >= supplierIndex
    ) {
      return null;
    }

    const quantityIndex = tokens.findIndex(
      (token, index) =>
        index < manufacturerIndex &&
        /^\d{1,3}$/.test(token) &&
        !/^(box|x)$/i.test(tokens[index - 1] ?? ''),
    );
    if (quantityIndex <= 0) {
      return null;
    }

    const spareName = tokens.slice(0, quantityIndex).join(' ').trim();
    const quantity = tokens[quantityIndex];
    const location = tokens
      .slice(quantityIndex + 1, manufacturerIndex)
      .join(' ')
      .trim();
    const manufacturerPart = tokens[manufacturerIndex];
    const supplierPart = tokens[supplierIndex];

    if (!spareName || !quantity || !location) {
      return null;
    }

    return {
      spareName,
      quantity,
      location,
      manufacturerPart,
      supplierPart,
    };
  }

  private parseReferenceSparePartCandidate(text: string): {
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  } | null {
    if (
      !/\b(spare\s*name|quantity|location|manufacturer\s*part#?|supplier\s*part#?)\b/i.test(
        text,
      )
    ) {
      return null;
    }

    let spareName = this.extractReferenceLabeledField(text, 'spare name', [
      'quantity',
      'location',
      'manufacturer part#',
      'supplier part#',
    ]);
    let quantity = this.extractReferenceLabeledField(text, 'quantity', [
      'location',
      'manufacturer part#',
      'supplier part#',
    ]);
    const location = this.extractReferenceLabeledField(text, 'location', [
      'manufacturer part#',
      'supplier part#',
    ]);
    const manufacturerPart = this.extractReferenceLabeledField(
      text,
      'manufacturer part#',
      ['supplier part#'],
    );
    const supplierPart = this.extractReferenceLabeledField(
      text,
      'supplier part#',
      [],
    );

    if (!quantity && spareName) {
      const quantityFromSpareName = spareName.match(/^(.*?)(\d+)$/);
      if (quantityFromSpareName) {
        spareName = quantityFromSpareName[1].trim();
        quantity = quantityFromSpareName[2];
      }
    }

    if (!quantity) {
      quantity = this.extractInlineQuantity(text) ?? null;
    }

    const candidate = {
      spareName: spareName || undefined,
      quantity: quantity || undefined,
      location: location || undefined,
      manufacturerPart: manufacturerPart || undefined,
      supplierPart: supplierPart || undefined,
    };

    if (
      candidate.spareName &&
      this.isInvalidReferenceSpareName(candidate.spareName)
    ) {
      candidate.spareName = undefined;
    }

    if (
      !candidate.spareName &&
      !candidate.quantity &&
      !candidate.location &&
      !candidate.manufacturerPart &&
      !candidate.supplierPart
    ) {
      return null;
    }

    return candidate;
  }

  private stripReferenceFieldLabel(value: string, label: string): string {
    return this.normalizeReferenceExtractedText(value).replace(
      new RegExp(`^${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').replace(/ /g, '\\\\s*')}\\s*:?\\s*`, 'i'),
      '',
    );
  }

  private extractReferenceSparePartLineCandidates(
    snippet: string,
  ): Array<{
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  }> {
    const rawLines = this.extractMarkupLines(snippet)
      .map((line) => this.normalizeReferenceExtractedText(line))
      .filter(Boolean);
    const lines: string[] = [];
    for (let index = 0; index < rawLines.length; index += 1) {
      let current = rawLines[index];
      while (
        index + 1 < rawLines.length &&
        this.shouldAppendReferenceContinuationLine(current, rawLines[index + 1])
      ) {
        current = `${current} ${rawLines[index + 1]}`.replace(/\s+/g, ' ').trim();
        index += 1;
      }
      lines.push(current);
    }
    const candidates: Array<{
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
    }> = [];
    let pendingSpareName: {
      spareName?: string;
      quantity?: string;
    } | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const spareNameCandidate = this.parseReferenceSpareNameLine(line);
      if (spareNameCandidate) {
        pendingSpareName = spareNameCandidate;
        candidates.push(spareNameCandidate);
        continue;
      }

      if (!this.isReferenceSparePartHeaderLineFromText(line)) {
        continue;
      }

      const valueCandidate = this.parseReferenceSparePartValueLine(
        lines[index + 1] ?? '',
      );
      if (!valueCandidate) {
        continue;
      }

      if (pendingSpareName) {
        candidates.push({
          spareName: pendingSpareName.spareName,
          quantity: pendingSpareName.quantity ?? valueCandidate.quantity,
          location: valueCandidate.location,
          manufacturerPart: valueCandidate.manufacturerPart,
          supplierPart: valueCandidate.supplierPart,
        });
        pendingSpareName = null;
        continue;
      }

      candidates.push(valueCandidate);
    }

    return candidates;
  }

  private shouldAppendReferenceContinuationLine(
    current: string,
    next: string,
  ): boolean {
    if (!current || !next) {
      return false;
    }

    if (
      this.hasMaintenanceReferenceId(next) ||
      /\b(reference\s*id|responsible|interval|last\s*due|next\s*due|costs?)\b/i.test(
        next,
      )
    ) {
      return false;
    }

    const openParens = (current.match(/\(/g) ?? []).length;
    const closeParens = (current.match(/\)/g) ?? []).length;
    if (openParens > closeParens) {
      return true;
    }

    return /\bspare\s*name\b/i.test(current) && /^[A-Za-z0-9][A-Za-z0-9().-]*$/.test(next);
  }

  private parseReferenceSpareNameLine(line: string): {
    spareName?: string;
    quantity?: string;
  } | null {
    if (!/\bspare\s*name\b/i.test(line)) {
      return null;
    }

    if (
      /\b(location|manufacturer\s*part#?|supplier\s*part#?)\b/i.test(line)
    ) {
      return null;
    }

    const parsedCandidate = this.parseReferenceSparePartCandidate(line);
    if (parsedCandidate?.spareName || parsedCandidate?.quantity) {
      if (
        parsedCandidate.spareName &&
        this.isInvalidReferenceSpareName(parsedCandidate.spareName)
      ) {
        return null;
      }
      return {
        spareName: parsedCandidate.spareName,
        quantity: parsedCandidate.quantity,
      };
    }

    const normalized = this.normalizeReferenceExtractedText(line).replace(
      /^.*?\bspare\s*name\b[:\s]*/i,
      '',
    );
    if (!normalized) {
      return null;
    }

    if (this.isInvalidReferenceSpareName(normalized)) {
      return null;
    }

    const quantityMatch = normalized.match(/^(.*?)(\d{1,3})$/);
    if (quantityMatch) {
      if (this.isInvalidReferenceSpareName(quantityMatch[1])) {
        return null;
      }
      return {
        spareName: quantityMatch[1].trim(),
        quantity: quantityMatch[2],
      };
    }

    return { spareName: normalized.trim() };
  }

  private isReferenceSparePartHeaderLineFromText(line: string): boolean {
    return (
      /\bquantity\b/i.test(line) &&
      /\blocation\b/i.test(line) &&
      /\bmanufacturer\s*part#?\b/i.test(line) &&
      /\bsupplier\s*part#?\b/i.test(line)
    );
  }

  private parseReferenceSparePartValueLine(line: string): {
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  } | null {
    const normalized = this.normalizeReferenceExtractedText(line);
    if (!normalized) {
      return null;
    }

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const supplierPart = this.extractTrailingReferencePartNumber(tokens);
    const manufacturerPart = this.extractTrailingReferencePartNumber(tokens);
    if (!supplierPart || !manufacturerPart) {
      return null;
    }

    const quantity =
      tokens[0] && /^\d{1,3}$/.test(tokens[0]) ? tokens.shift() : undefined;
    const location = tokens.join(' ').trim();
    if (!location) {
      return null;
    }

    return {
      quantity,
      location,
      manufacturerPart,
      supplierPart,
    };
  }

  private mergeComplementaryReferenceSparePartCandidates(
    candidates: Array<{
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
      score: number;
    }>,
    taskKeywords: Set<string>,
  ): Array<{
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
    score: number;
  }> {
    const remaining = [...candidates];
    const merged: Array<{
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
      score: number;
    }> = [];

    while (remaining.length > 0) {
      const current = remaining.shift()!;
      const currentHasStructuredData = Boolean(
        current.location || current.manufacturerPart || current.supplierPart,
      );
      const currentHasSemanticName = Boolean(
        current.spareName &&
          this.extractReferenceSemanticKeywords(current.spareName).some(
            (keyword) => taskKeywords.has(keyword),
          ),
      );

      if (
        current.spareName &&
        !currentHasStructuredData &&
        currentHasSemanticName
      ) {
        const complementIndex = remaining.findIndex((candidate) => {
          if (candidate.spareName) {
            return false;
          }

          const candidateHasStructuredData = Boolean(
            candidate.location ||
              candidate.manufacturerPart ||
              candidate.supplierPart,
          );
          if (!candidateHasStructuredData) {
            return false;
          }

          if (
            current.quantity &&
            candidate.quantity &&
            current.quantity !== candidate.quantity
          ) {
            return false;
          }

          return true;
        });

        if (complementIndex >= 0) {
          const complement = remaining.splice(complementIndex, 1)[0];
          merged.push({
            spareName: current.spareName,
            quantity: current.quantity ?? complement.quantity,
            location: complement.location,
            manufacturerPart: complement.manufacturerPart,
            supplierPart: complement.supplierPart,
            score: Math.max(current.score, complement.score) + 2,
          });
          continue;
        }
      }

      merged.push(current);
    }

    return merged;
  }

  private isInvalidReferenceSpareName(value: string): boolean {
    const normalized = this.normalizeReferenceExtractedText(value).toLowerCase();
    if (!normalized) {
      return true;
    }

    return (
      /\b(quantity|location|manufacturer\s*part#?|supplier\s*part#?|eur)\b/i.test(
        normalized,
      ) ||
      normalized.startsWith('quantity ') ||
      /\bmaintenance\s*tasks\b/i.test(normalized) ||
      /\bm\/y\b/i.test(normalized)
    );
  }

  private extractTrailingReferencePartNumber(tokens: string[]): string | null {
    if (tokens.length === 0) {
      return null;
    }

    const lastToken = tokens[tokens.length - 1];
    const previousToken = tokens[tokens.length - 2];
    if (
      previousToken &&
      /^[A-Z-]{1,5}$/i.test(previousToken) &&
      /^\d{4,}$/i.test(lastToken)
    ) {
      const combined = `${previousToken}${lastToken}`;
      if (this.looksLikeReferencePartNumber(combined)) {
        tokens.splice(tokens.length - 2, 2);
        return combined;
      }
    }

    if (this.looksLikeReferencePartNumber(lastToken)) {
      tokens.pop();
      return lastToken;
    }

    return null;
  }

  private extractReferenceLabeledField(
    text: string,
    label: string,
    nextLabels: string[],
  ): string | null {
    const buildPattern = (value: string) =>
      value
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\ /g, '\\s*')
        .replace(/#/, '#?');

    const labelPattern = buildPattern(label);
    const nextPattern =
      nextLabels.length > 0
        ? `(?=(?:${nextLabels.map(buildPattern).join('|')})\\s*:?)`
        : '$';
    const regex = new RegExp(
      `${labelPattern}\\s*:?[\\s\\[]*(.+?)${nextPattern}`,
      'i',
    );
    const match = text.match(regex);
    if (!match) {
      return null;
    }

    const value = this.normalizeReferenceExtractedText(match[1])
      .replace(/^\[+/, '')
      .trim();
    if (!value) {
      return null;
    }

    if (
      /^(quantity|location|manufacturer\s*part#?|supplier\s*part#?|spare\s*name)$/i.test(
        value,
      )
    ) {
      return null;
    }

    return value;
  }

  private extractInlineQuantity(text: string): string | null {
    const match = text.match(/\bquantity\s+(\d+)\b/i);
    if (match?.[1]) {
      return match[1];
    }

    return null;
  }

  private extractReferenceSemanticKeywords(text: string): string[] {
    const normalized = this.normalizeReferenceExtractedText(text).toLowerCase();
    const patterns: Array<[string, RegExp]> = [
      ['wear-kit', /\bwear\s*kit\b/i],
      ['filter', /\bfilters?\b/i],
      ['belt', /\bbelts?\b/i],
      ['impeller', /\bimpellers?\b/i],
      ['anode', /\banodes?\b/i],
      ['coolant', /\bcoolant\b/i],
      ['pump', /\bpump\b/i],
      ['thermostat', /\bthermostats?\b/i],
      ['seal', /\bseals?\b/i],
      ['bearing', /\bbearings?\b/i],
      ['oil', /\boil\b/i],
      ['gasket', /\bgaskets?\b/i],
      ['sea-water', /\bsea\s*water\b|\bseawater\b/i],
    ];

    return patterns
      .filter(([, pattern]) => pattern.test(normalized))
      .map(([keyword]) => keyword);
  }

  private scoreReferenceSparePartCandidate(
    candidate: {
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
    },
    taskKeywords: Set<string>,
  ): number {
    const completeness =
      Number(Boolean(candidate.spareName)) +
      Number(Boolean(candidate.quantity)) +
      Number(Boolean(candidate.location)) +
      Number(Boolean(candidate.manufacturerPart)) +
      Number(Boolean(candidate.supplierPart));

    const candidateText = [
      candidate.spareName,
      candidate.location,
      candidate.manufacturerPart,
      candidate.supplierPart,
    ]
      .filter(Boolean)
      .join(' ');
    const candidateKeywords = this.extractReferenceSemanticKeywords(candidateText);
    const overlap = candidateKeywords.filter((keyword) =>
      taskKeywords.has(keyword),
    ).length;
    const labelHits = this.countReferenceSparePartLabels(candidateText);
    const metadataHits = this.countReferenceMetadataHits(candidateText);
    const actionPenalty =
      candidate.spareName &&
      /\b(replace|inspect|check|clean|adjust|overhaul|sample|test)\b/i.test(
        candidate.spareName,
      )
        ? 8
        : 0;
    const quantityPenalty =
      candidate.quantity && !/^\d{1,3}$/.test(candidate.quantity) ? 4 : 0;
    const manufacturerScore = candidate.manufacturerPart
      ? this.looksLikeReferencePartNumber(candidate.manufacturerPart)
        ? 3
        : -3
      : 0;
    const supplierScore = candidate.supplierPart
      ? this.looksLikeReferencePartNumber(candidate.supplierPart)
        ? 3
        : -3
      : 0;

    return (
      completeness * 2 +
      overlap * 4 +
      labelHits +
      manufacturerScore +
      supplierScore -
      metadataHits * 3 -
      actionPenalty -
      quantityPenalty
    );
  }

  private normalizeReferenceSparePartCandidate(candidate: {
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  } | null): {
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  } | null {
    if (!candidate) {
      return null;
    }

    const normalized = {
      spareName: candidate.spareName
        ? this.normalizeReferenceExtractedText(candidate.spareName)
        : undefined,
      quantity: candidate.quantity
        ? this.normalizeReferenceExtractedText(candidate.quantity)
        : undefined,
      location: candidate.location
        ? this.normalizeReferenceExtractedText(candidate.location)
        : undefined,
      manufacturerPart: candidate.manufacturerPart
        ? this.normalizeReferenceExtractedText(candidate.manufacturerPart)
        : undefined,
      supplierPart: candidate.supplierPart
        ? this.normalizeReferenceExtractedText(candidate.supplierPart)
        : undefined,
    };

    if (
      normalized.spareName &&
      normalized.quantity &&
      /^\d{1,3}$/.test(normalized.quantity) &&
      /\bbox$/i.test(normalized.spareName) &&
      normalized.location
    ) {
      normalized.spareName = normalized.spareName.replace(/\s+box$/i, '').trim();
      normalized.location = `BOX ${normalized.quantity} ${normalized.location}`
        .replace(/\s+/g, ' ')
        .trim();
      normalized.quantity = undefined;
    }

    if (
      !normalized.spareName &&
      normalized.location &&
      normalized.manufacturerPart &&
      /^box\b/i.test(normalized.manufacturerPart) &&
      normalized.supplierPart &&
      this.looksLikeReferencePartNumber(normalized.supplierPart)
    ) {
      normalized.spareName = normalized.location;
      normalized.location = normalized.manufacturerPart;
      normalized.manufacturerPart = normalized.supplierPart;
      normalized.supplierPart = undefined;
    }

    if (
      normalized.spareName &&
      !normalized.quantity &&
      normalized.location &&
      /^\d{1,3}$/.test(normalized.location) &&
      normalized.manufacturerPart &&
      this.looksLikeReferenceLocation(normalized.manufacturerPart) &&
      normalized.supplierPart &&
      this.looksLikeReferencePartNumber(normalized.supplierPart)
    ) {
      normalized.quantity = normalized.location;
      normalized.location = normalized.manufacturerPart;
      normalized.manufacturerPart = normalized.supplierPart;
      normalized.supplierPart = undefined;
    }

    if (
      normalized.spareName &&
      this.isInvalidReferenceSpareName(normalized.spareName)
    ) {
      normalized.spareName = undefined;
    }

    if (
      normalized.location &&
      /^(manufacturer\s*part#?|supplier\s*part#?)$/i.test(normalized.location)
    ) {
      normalized.location = undefined;
    }

    if (
      !normalized.spareName &&
      !normalized.quantity &&
      !normalized.location &&
      !normalized.manufacturerPart &&
      !normalized.supplierPart
    ) {
      return null;
    }

    return normalized;
  }

  private countReferenceSparePartLabels(text: string): number {
    const normalized = this.normalizeReferenceExtractedText(text).toLowerCase();
    const patterns = [
      /\bspare\s*name\b/i,
      /\bquantity\b/i,
      /\blocation\b/i,
      /\bmanufacturer\s*part#?\b/i,
      /\bsupplier\s*part#?\b/i,
    ];

    return patterns.reduce(
      (count, pattern) => count + Number(pattern.test(normalized)),
      0,
    );
  }

  private countReferenceMetadataHits(text: string): number {
    const normalized = this.normalizeReferenceExtractedText(text).toLowerCase();
    const patterns = [
      /\breference\s*id\b/i,
      /\bresponsible\b/i,
      /\binterval\b/i,
      /\blast\s*due\b/i,
      /\bnext\s*due\b/i,
      /\bcomponent\s*name\b/i,
      /\btask\s*name\b/i,
      /\bcosts?\b/i,
      /\bchief\s*engineer\b/i,
      /\b(?:ps|sb)\s+engine\b/i,
      /\bmain\s+generator\b/i,
      /\bgenset\b/i,
      /\beur\b/i,
      MAINTENANCE_REFERENCE_ID_PATTERN,
    ];

    return patterns.reduce(
      (count, pattern) => count + Number(pattern.test(normalized)),
      0,
    );
  }

  private looksLikeReferencePartNumber(value: string): boolean {
    const normalized = this.normalizeReferenceExtractedText(value);
    if (!normalized) return false;
    if (/\s{2,}/.test(normalized)) return false;
    if (/\b(reference|responsible|interval|last|next|chief|engineer)\b/i.test(normalized)) {
      return false;
    }

    const compact = normalized.replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{5,}$/i.test(compact)) {
      return false;
    }

    return /\d/.test(compact);
  }

  private looksLikeReferenceLocation(value: string): boolean {
    const normalized = this.normalizeReferenceExtractedText(value).toLowerCase();
    if (!normalized) {
      return false;
    }

    return /\b(box|bilge|storage|room|filters?|spares?|unit|club|viareggio|oils?\s+and\s+coolants|exhaust|pumps?)\b/i.test(
      normalized,
    );
  }

  private referenceSparePartCandidatesMatch(
    left: {
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
    },
    right: {
      spareName?: string;
      quantity?: string;
      location?: string;
      manufacturerPart?: string;
      supplierPart?: string;
    },
  ): boolean {
    const normalize = (value?: string) =>
      (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const leftSpare = normalize(left.spareName);
    const rightSpare = normalize(right.spareName);
    if (leftSpare && rightSpare) {
      if (
        leftSpare === rightSpare ||
        leftSpare.includes(rightSpare) ||
        rightSpare.includes(leftSpare)
      ) {
        return true;
      }
    }

    if (
      left.manufacturerPart &&
      right.manufacturerPart &&
      left.manufacturerPart === right.manufacturerPart
    ) {
      return true;
    }

    if (
      left.supplierPart &&
      right.supplierPart &&
      left.supplierPart === right.supplierPart
    ) {
      return true;
    }

    return false;
  }

  private shouldResolveToExactMaintenanceRow(query: string): boolean {
    return /\b(reference\s*id|maintenance|service|next\s+due|last\s+due|tasks?|procedure|steps?|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|parts?|spares?|consumables?)\b/i.test(
      query,
    );
  }

  private scoreMaintenanceRowCandidate(
    candidate: MaintenanceRowContext,
    citation: ChatCitation,
    queryText: string,
    subjectTerms: string[],
  ): number {
    const haystack = this.normalizeReferenceExtractedText(
      [
        citation.sourceTitle ?? '',
        candidate.componentName ?? '',
        candidate.taskName ?? '',
        candidate.referenceId ?? '',
        candidate.interval ?? '',
        candidate.lastDue ?? '',
        candidate.nextDue ?? '',
      ].join(' '),
    ).toLowerCase();

    let score = 0;
    score += candidate.referenceId ? 18 : 0;
    score += candidate.taskName ? 8 : 0;
    score += candidate.componentName ? 5 : 0;
    score += candidate.interval ? 2 : 0;
    score += candidate.lastDue ? 1 : 0;
    score += candidate.nextDue ? 3 : 0;
    score += (citation.score ?? 0) * 10;

    if (this.hasExplicitMaintenanceRowEvidence(citation.snippet ?? '')) {
      score += 10;
    }

    for (const term of subjectTerms) {
      if (haystack.includes(term.toLowerCase())) {
        score += 2;
      }
    }

    if (
      /\b(next\s+maintenance|next\s+service|next\s+due|when\s+is\s+the\s+next|what\s+is\s+the\s+next)\b/i.test(
        queryText,
      ) &&
      candidate.nextDue
    ) {
      score += 3;
    }

    if (
      /\b(tasks?|procedure|steps?|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done)\b/i.test(
        queryText,
      ) &&
      candidate.taskName
    ) {
      score += 2;
    }

    if (
      /\b(parts?|spares?|consumables?)\b/i.test(queryText) &&
      candidate.referenceId
    ) {
      score += 2;
    }

    if (
      /\b(reference\s*id|task\s*name|component\s*name)\b/i.test(
        citation.snippet ?? '',
      )
    ) {
      score += 2;
    }

    const requestedSide = this.queryService.detectDirectionalSide(queryText);
    if (requestedSide) {
      const oppositeSide = requestedSide === 'port' ? 'starboard' : 'port';
      if (this.queryService.matchesDirectionalSide(haystack, requestedSide)) {
        score += 12;
      } else if (
        this.queryService.matchesDirectionalSide(haystack, oppositeSide)
      ) {
        score -= 16;
      }
    }

    return score;
  }

  private hasExplicitMaintenanceRowEvidence(snippet: string): boolean {
    return /\b(reference\s*id|component\s*name|task\s*name)\s*:/i.test(snippet);
  }

  private buildMaintenanceSubjectQuery(
    context: MaintenanceRowContext & { sourceTitle?: string },
  ): string {
    return [
      this.queryService.normalizeSourceTitleHint(context.sourceTitle) ?? '',
      context.referenceId ? `Reference ID ${context.referenceId}` : '',
      context.componentName ?? '',
      context.taskName ?? '',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseMaintenanceRowContext(
    text: string,
  ): MaintenanceRowContext | null {
    const componentName = this.extractMaintenanceField(text, 'Component name', [
      'Task name',
      'Reference ID',
      'Responsible',
      'Interval',
      'Last due',
      'Next due',
      'Costs',
    ]);
    const taskName = this.extractMaintenanceField(text, 'Task name', [
      'Reference ID',
      'Responsible',
      'Interval',
      'Last due',
      'Next due',
      'Costs',
    ]);
    const referenceId = this.extractMaintenanceRawField(text, 'Reference ID', [
      'Responsible',
      'Interval',
      'Last due',
      'Next due',
      'Costs',
    ]);
    const responsible = this.extractMaintenanceField(text, 'Responsible', [
      'Interval',
      'Last due',
      'Next due',
      'Costs',
    ]);
    const interval = this.extractMaintenanceField(text, 'Interval', [
      'Last due',
      'Next due',
      'Costs',
    ]);
    const lastDue = this.extractMaintenanceField(text, 'Last due', [
      'Next due',
      'Costs',
    ]);
    const nextDue = this.extractMaintenanceField(text, 'Next due', ['Costs']);

    const normalizedReferenceId =
      this.extractMaintenanceReferenceId(referenceId);
    if (!normalizedReferenceId) {
      return null;
    }

    return {
      referenceId: normalizedReferenceId,
      componentName: componentName || undefined,
      taskName: taskName || undefined,
      responsible: responsible || undefined,
      interval: interval || undefined,
      lastDue: lastDue || undefined,
      nextDue: nextDue || undefined,
    };
  }

  private extractMaintenanceField(
    text: string,
    label: string,
    followingLabels: string[],
  ): string | null {
    const escapedLabel = label.replace(/\s+/g, '\\s*');
    const escapedFollowingLabels = followingLabels
      .map((value) => value.replace(/\s+/g, '\\s*'))
      .join('|');
    const pattern = escapedFollowingLabels
      ? `${escapedLabel}\\s*:\\s*([\\s\\S]*?)(?=(?:${escapedFollowingLabels})\\s*:|$)`
      : `${escapedLabel}\\s*:\\s*([\\s\\S]*?)$`;

    const match = text.match(new RegExp(pattern, 'i'));
    if (!match?.[1]) return null;

    const value = this.normalizeReferenceExtractedText(
      match[1].replace(/\s+/g, ' ').trim(),
    );
    return value || null;
  }

  private extractMaintenanceRawField(
    text: string,
    label: string,
    followingLabels: string[],
  ): string | null {
    const escapedLabel = label.replace(/\s+/g, '\\s*');
    const escapedFollowingLabels = followingLabels
      .map((value) => value.replace(/\s+/g, '\\s*'))
      .join('|');
    const pattern = escapedFollowingLabels
      ? `${escapedLabel}\\s*:\\s*([\\s\\S]*?)(?=(?:${escapedFollowingLabels})\\s*:|$)`
      : `${escapedLabel}\\s*:\\s*([\\s\\S]*?)$`;

    const match = text.match(new RegExp(pattern, 'i'));
    const value = match?.[1]?.replace(/\s+/g, ' ').trim();
    return value || null;
  }

  private normalizeMaintenanceField(value?: string): string {
    return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private formatReferenceSparePartSummary(part: {
    spareName?: string;
    quantity?: string;
    location?: string;
    manufacturerPart?: string;
    supplierPart?: string;
  }): string {
    return [
      part.spareName ? `- Spare Name: ${part.spareName}` : '- Spare Name:',
      part.quantity ? `Quantity: ${part.quantity}` : '',
      part.location ? `Location: ${part.location}` : '',
      part.manufacturerPart
        ? `Manufacturer Part#: ${this.normalizeReferencePartNumberDisplay(part.manufacturerPart)}`
        : '',
      part.supplierPart
        ? `Supplier Part#: ${this.normalizeReferencePartNumberDisplay(part.supplierPart)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private normalizeReferencePartNumberDisplay(value: string): string {
    const compact = value.replace(/\s+/g, '').trim();
    return this.looksLikeReferencePartNumber(compact) ? compact : value;
  }

  private extractReferenceRowSummary(
    snippet: string,
    referenceId: string,
  ): string | null {
    const rows = snippet.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const matchingRow = rows.find((row) =>
      row.toLowerCase().includes(referenceId.toLowerCase()),
    );
    if (!matchingRow) return null;

    const cells = this.extractTableCells(matchingRow);
    if (cells.length === 0) {
      const plain = this.stripHtmlLikeMarkup(matchingRow);
      return plain || null;
    }

    const referenceIndex = cells.findIndex((cell) =>
      cell.toLowerCase().includes(referenceId.toLowerCase()),
    );
    if (referenceIndex < 0) {
      return cells.join('\n');
    }

    const component = cells[referenceIndex - 2] ?? '';
    const task = cells[referenceIndex - 1] ?? '';
    const reference = cells[referenceIndex] ?? '';
    const responsible = cells[referenceIndex + 1] ?? '';
    const interval = cells[referenceIndex + 2] ?? '';
    const lastDue = cells[referenceIndex + 3] ?? '';
    const nextDue = cells[referenceIndex + 4] ?? '';

    return [
      component ? `Component name: ${component}` : '',
      task ? `Task name: ${task}` : '',
      reference ? `Reference ID: ${reference}` : '',
      responsible ? `Responsible: ${responsible}` : '',
      interval ? `Interval: ${interval}` : '',
      lastDue ? `Last due: ${lastDue}` : '',
      nextDue ? `Next due: ${nextDue}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildScheduleRowSummary(rowHtml: string): string | null {
    const cells = this.extractTableCells(rowHtml);
    if (cells.length === 0) return null;

    const referenceIndex = cells.findIndex((cell) =>
      this.hasMaintenanceReferenceId(cell),
    );
    if (referenceIndex < 0) {
      return null;
    }

    const component = cells[referenceIndex - 2] ?? '';
    const task = cells[referenceIndex - 1] ?? '';
    const reference = cells[referenceIndex] ?? '';
    const responsible = cells[referenceIndex + 1] ?? '';
    const interval = cells[referenceIndex + 2] ?? '';
    const lastDue = cells[referenceIndex + 3] ?? '';
    const nextDue = cells[referenceIndex + 4] ?? '';
    const costs = cells[referenceIndex + 5] ?? '';

    const summary = [
      component ? `Component name: ${component}` : '',
      task ? `Task name: ${task}` : '',
      reference ? `Reference ID: ${reference}` : '',
      responsible ? `Responsible: ${responsible}` : '',
      interval ? `Interval: ${interval}` : '',
      lastDue ? `Last due: ${lastDue}` : '',
      nextDue ? `Next due: ${nextDue}` : '',
      costs ? `Costs: ${costs}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return summary || null;
  }

  private extractTableCells(rowHtml: string): string[] {
    return [...rowHtml.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map((match) => this.stripHtmlLikeMarkup(match[1]))
      .filter(Boolean);
  }

  private scoreReferenceFocusBlock(block: string, referenceId: string): number {
    const normalizedReference = referenceId.toLowerCase();
    const normalizedBlock = block.toLowerCase();
    const anchorIndex = normalizedBlock.indexOf(normalizedReference);
    const referenceMatches = [
      ...normalizedBlock.matchAll(MAINTENANCE_REFERENCE_ID_GLOBAL_PATTERN),
    ];
    const foreignRefsBefore = referenceMatches.filter((match) => {
      if (match[0] === normalizedReference) {
        return false;
      }
      return typeof match.index === 'number' && match.index < anchorIndex;
    }).length;
    const foreignRefsAfter = referenceMatches.filter((match) => {
      if (match[0] === normalizedReference) {
        return false;
      }
      return typeof match.index === 'number' && match.index > anchorIndex;
    }).length;

    let score = 100;
    score -= foreignRefsBefore * 25;
    score -= foreignRefsAfter * 8;
    score -= Math.floor(block.length / 500);

    if (
      /\b(reference\s*id|responsible|interval|last\s*due|next\s*due)\b/i.test(
        block,
      )
    ) {
      score += 10;
    }

    return score;
  }

  private extractMarkupLines(snippet: string): string[] {
    return snippet
      .replace(/<\/tr>/gi, '\n')
      .replace(/<tr[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:td|th)>/gi, ' ')
      .replace(/<(?:td|th)[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  private normalizeReferenceExtractedText(text: string): string {
    return text
      .replace(/&nbsp;/gi, ' ')
      .replace(/VOLVOPENTASPARES/gi, 'VOLVO PENTA SPARES')
      .replace(/VOLVOPENTA/gi, 'VOLVO PENTA')
      .replace(/PENTAOIL/gi, 'PENTA OIL')
      .replace(/PENTAFUEL/gi, 'PENTA FUEL')
      .replace(/PENTAAIR/gi, 'PENTA AIR')
      .replace(
        /\b(REPLACE|INSPECT|CHECK|CLEAN|ADJUST|OVERHAUL|SAMPLE|TEST)(?=[A-Z])/g,
        '$1 ',
      )
      .replace(/INSEA/gi, 'IN SEA')
      .replace(/KITIN/gi, 'KIT IN')
      .replace(/WEARKIT/gi, 'WEAR KIT')
      .replace(/SEAWATER/gi, 'SEA WATER')
      .replace(/OILFILTERS/gi, 'OIL FILTERS')
      .replace(/FUELFILTER/gi, 'FUEL FILTER')
      .replace(/AIRFILTER/gi, 'AIR FILTER')
      .replace(/PUIMP/gi, 'PUMP')
      .replace(/WATERPUMP/gi, 'WATER PUMP')
      .replace(/BOX(\d+)(?=[A-Z])/g, 'BOX $1 ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]{2,})(\d+)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stripHtmlLikeMarkup(snippet: string): string {
    return snippet
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
