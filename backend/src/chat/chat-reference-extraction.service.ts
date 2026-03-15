import { Injectable } from '@nestjs/common';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';

@Injectable()
export class ChatReferenceExtractionService {
  constructor(
    private readonly queryService: ChatDocumentationQueryService,
  ) {}

  focusReferenceSnippet(snippet: string, referenceId: string): string {
    if (!snippet) return snippet;

    const normalizedReference = referenceId.toLowerCase();
    if (!snippet.toLowerCase().includes(normalizedReference)) {
      return snippet.trim();
    }

    const matchingTables = (snippet.match(/<table[\s\S]*?<\/table>/gi) ?? []).filter(
      (table) => table.toLowerCase().includes(normalizedReference),
    );
    if (matchingTables.length > 0) {
      return [...matchingTables]
        .sort(
          (left, right) =>
            this.scoreReferenceFocusBlock(right, referenceId) -
            this.scoreReferenceFocusBlock(left, referenceId),
        )[0]
        .trim();
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
        index < Math.min(rows.length, referenceRowIndex + 5);
        index += 1
      ) {
        const row = rows[index];
        if (
          index > referenceRowIndex &&
          /\b1p\d{2,}\b/i.test(row) &&
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
          /\b1p\d{2,}\b/i.test(entry.plain),
      );

    if (rowMatches.length > 0) {
      const target = rowMatches[0];
      const summary = this.buildScheduleRowSummary(target.row);
      if (summary) {
        return summary;
      }

      const selectedRows: string[] = [];
      const previousRow = rows[target.index - 1];
      if (
        previousRow &&
        /\b(component\s*name|task\s*name|reference\s*id|responsible|interval|last\s*due|next\s*due|costs)\b/i.test(
          this.stripHtmlLikeMarkup(previousRow),
        )
      ) {
        selectedRows.push(previousRow);
      }
      selectedRows.push(target.row);
      return selectedRows.join('\n').trim();
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
        /\b1p\d{2,}\b/i.test(line),
    );
    if (lineIndex < 0) return null;

    return lines.slice(Math.max(0, lineIndex - 1), lineIndex + 1).join('\n');
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
          .slice(0, 8)
          .map((item) => `- ${item}`)
          .join('\n')}`,
      );
    }
    if (spareParts.length > 0) {
      sections.push(
        `Spare parts:\n${spareParts
          .slice(0, 4)
          .map((part) => this.formatReferenceSparePartSummary(part))
          .join('\n\n')}`,
      );
    }
    if (continuationLines.length > 0) {
      sections.push(
        `Same-page continuation:\n${continuationLines.slice(0, 12).join('\n')}`,
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

        if (/\b1p\d{2,}\b/i.test(normalizedLine)) {
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
          valueIndex < Math.min(rows.length, index + 4);
          valueIndex += 1
        ) {
          const valueCells = this.extractTableCells(rows[valueIndex]);
          const candidate = this.parseReferenceSparePartTableRow(valueCells);
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
        const candidate = this.parseReferenceSparePartCandidate(
          this.normalizeReferenceExtractedText(this.stripHtmlLikeMarkup(row)),
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
        candidates.push({
          ...candidate,
          score: this.scoreReferenceSparePartCandidate(candidate, taskKeywords) + 5,
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
        const hasStructuredPartData = Boolean(
          candidate.location ||
            candidate.manufacturerPart ||
            candidate.supplierPart,
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

        return (
          completeness >= 2 &&
          candidate.score > 0 &&
          (hasStructuredPartData || hasTaskKeywordAlignment)
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
        candidate.manufacturerPart &&
        candidate.supplierPart
      ) {
        return candidate;
      }
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
      /\b1p\d{2,}\b/i.test(flattened) ||
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
        index < manufacturerIndex && /^\d{1,3}$/.test(token),
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
      /\b(reference\s*id|responsible|interval|last\s*due|next\s*due|costs?|1p\d{2,})\b/i.test(
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
      normalized.startsWith('quantity ')
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
      /\b1p\d{2,}\b/i,
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
    return /^[A-Z0-9-]{5,}$/i.test(compact);
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
        ? `Manufacturer Part#: ${part.manufacturerPart}`
        : '',
      part.supplierPart ? `Supplier Part#: ${part.supplierPart}` : '',
    ]
      .filter(Boolean)
      .join('\n');
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

    const referenceIndex = cells.findIndex((cell) => /\b1p\d{2,}\b/i.test(cell));
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
    const referenceMatches = [...normalizedBlock.matchAll(/\b1p\d{2,}\b/g)];
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
      .replace(
        /\b(REPLACE|INSPECT|CHECK|CLEAN|ADJUST|OVERHAUL|SAMPLE|TEST)(?=[A-Z])/g,
        '$1 ',
      )
      .replace(/INSEA/gi, 'IN SEA')
      .replace(/KITIN/gi, 'KIT IN')
      .replace(/WEARKIT/gi, 'WEAR KIT')
      .replace(/SEAWATER/gi, 'SEA WATER')
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
