import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Repository } from 'typeorm';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentDocClass } from '../enums/document-doc-class.enum';

export interface FileLookupCandidate {
  documentId: string;
  fileName: string;
  docClass: DocumentDocClass;
  /** Controlled form/checklist code, when this is a form — the one identifier
   *  the chat is allowed to state to the user. */
  docCode: string | null;
  score: number;
  descriptor: string | null;
}

/**
 * Catalog-style lookup that finds the document a user is asking for BY FILE
 * (e.g. "show me the General Arrangement plan", "open the watermaker manual",
 * "give me the original fire control drawing"). Unlike content retrieval, this
 * never reads chunks — it matches the request against document-level metadata
 * (file name + equipment/system + purpose + ai summary) and returns the best
 * documents so the chat can hand back the ORIGINAL file. This is the path that
 * makes Vessel Plans (which are not content-parsed) findable.
 */
@Injectable()
export class DocumentsFileLookupService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
  ) {}

  async findFiles(
    shipId: string,
    query: string,
    limit = 5,
  ): Promise<FileLookupCandidate[]> {
    const tokens = this.tokenize(query);
    if (!tokens.length) {
      return [];
    }

    // Only documents that still have a retrievable original on file.
    const documents = await this.documentsRepository.find({
      where: { shipId, storageKey: Not(IsNull()) },
      order: { updatedAt: 'DESC' },
    });

    const scored = documents
      .map((document) => {
        const { score, descriptor } = this.scoreDocument(document, tokens);
        return { document, score, descriptor };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return scored.map((entry) => ({
      documentId: entry.document.id,
      fileName: entry.document.originalFileName,
      docClass: entry.document.docClass,
      docCode: entry.document.docCode ?? null,
      score: entry.score,
      descriptor: entry.descriptor,
    }));
  }

  private scoreDocument(
    document: DocumentEntity,
    queryTokens: string[],
  ): { score: number; descriptor: string | null } {
    const fileName = document.originalFileName ?? '';
    const fileNameTokens = new Set(this.tokenize(fileName));

    // Metadata haystack (lower weight than the file name itself).
    const descriptorParts = [
      document.equipmentOrSystem,
      document.equipmentName,
      document.equipmentAliases,
      document.systemArea,
      document.documentPurpose,
      document.contentFocus,
      document.manufacturer,
      document.model,
      document.aiSummary,
    ].filter((value): value is string => Boolean(value && value.trim()));
    const descriptor = descriptorParts.join(' ') || null;
    const metadataTokens = new Set(this.tokenize(descriptorParts.join(' ')));

    let score = 0;
    for (const token of queryTokens) {
      if (fileNameTokens.has(token)) {
        score += 2; // a hit in the file name is the strongest signal
      } else if (metadataTokens.has(token)) {
        score += 1;
      }
    }

    // Light nudge for plans/drawings when the user uses plan-like wording, so a
    // "show me the X diagram" request prefers an actual plan over a manual that
    // merely mentions X.
    if (
      document.docClass === DocumentDocClass.PLAN &&
      queryTokens.some((token) => PLAN_INTENT_TOKENS.has(token))
    ) {
      score += 1;
    }

    return { score, descriptor };
  }

  private tokenize(value: string): string[] {
    return Array.from(
      new Set(
        value
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token)),
      ),
    );
  }
}

// Generic words that carry no matching signal (RU + EN), so they don't inflate
// scores for unrelated documents.
const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'show',
  'open',
  'give',
  'file',
  'document',
  'original',
  'please',
  'покажи',
  'дай',
  'открой',
  'файл',
  'документ',
  'оригинал',
  'пожалуйста',
  'мне',
  'нам',
]);

const PLAN_INTENT_TOKENS = new Set([
  'plan',
  'plans',
  'drawing',
  'drawings',
  'diagram',
  'schematic',
  'arrangement',
  'layout',
  'план',
  'планы',
  'чертеж',
  'чертёж',
  'схема',
  'схему',
  'диаграмма',
  'расположения',
]);
