import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import pdfParse from 'pdf-parse';
import { LlmService } from '../../integrations/llm/llm.service';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceService } from './compliance.service';
import { archetypeBlock } from './compliance-archetypes';
import { DocumentsUploadStorageService } from '../documents/ingestion/documents-upload-storage.service';
import { DocumentsService } from '../documents/documents.service';
import { AuthenticatedUser } from '../../core/auth/auth.types';

interface IngestItem {
  filename: string;
  text?: string;
  buffer?: Buffer;
}

/** One file's AI proposal — shown in the review window, NOT yet saved. */
export interface IngestProposal {
  filename: string;
  status: 'matched' | 'unmatched' | 'error';
  typeId?: string | null;
  sfiCode?: string | null;
  typeName?: string | null;
  archetype?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  fields?: Record<string, unknown>;
  assetId?: string | null;
  assetName?: string | null;
  confidence?: number;
  message?: string;
  /** Full transcribed document text — persisted for chat full-text answers. */
  extractedText?: string;
}

/** A reviewed/edited proposal coming back to be committed. */
export interface CommitProposal {
  typeId: string;
  /** Original upload filename — used to re-attach the file buffer on commit. */
  filename?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  fields?: Record<string, unknown> | null;
  assetId?: string | null;
  crewMemberId?: string | null;
  /** Full transcribed text captured at preview — persisted for chat. */
  extractedText?: string | null;
}

export interface CommitResult {
  filename?: string;
  status: 'created' | 'error';
  recordId?: string;
  message?: string;
}

const MAX_TEXT = 8000;
// Below this many chars of embedded text a PDF is treated as a scan and sent
// to Claude for OCR (a real certificate always has more than a few stray chars).
const MIN_EMBEDDED_TEXT = 40;
// Cap the stored full text per record (certificates are short; keeps rows sane).
const BACKFILL_MAX_TEXT = 20000;

/** Claude-supported image media type for a filename, or null (→ pdf path). */
function imageMediaType(filename: string): string | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** Best-effort content type for a stored upload (images → their type, else PDF). */
function mimeType(filename: string): string {
  return imageMediaType(filename) ?? 'application/pdf';
}

@Injectable()
export class ComplianceExtractionService {
  private readonly logger = new Logger(ComplianceExtractionService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly complianceService: ComplianceService,
    private readonly uploadStorage: DocumentsUploadStorageService,
    private readonly documentsService: DocumentsService,
    @InjectRepository(ComplianceDocTypeEntity)
    private readonly typeRepository: Repository<ComplianceDocTypeEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
  ) {}

  /**
   * Single-file path for a KNOWN type ("Add document" on a compliance row): the
   * operator already picked the type, so we skip classification, read the file
   * that was just stored in the documents pipeline, and extract the archetype's
   * fields (with scan OCR). Returns a PROPOSAL — nothing is saved. The operator
   * reviews/edits it in the modal and confirms, which persists the record.
   */
  async extractForType(
    shipId: string,
    typeId: string,
    documentId: string,
    user: AuthenticatedUser,
  ): Promise<IngestProposal> {
    const type = await this.typeRepository.findOne({
      where: { id: typeId, shipId },
    });
    if (!type) throw new BadRequestException('Compliance type not found.');

    const file = await this.documentsService.getFile(documentId, user);
    const text = (await this.extractText({
      filename: file.fileName,
      buffer: file.buffer,
    }))
      .slice(0, MAX_TEXT)
      .trim();

    const fields = text ? await this.extractFields(type.archetype, text) : {};
    const assets = await this.assetRepository.find({
      where: { shipId },
      select: ['id', 'displayName', 'brand', 'model', 'serialNo'],
    });
    const link = this.resolveAssetLink(type, fields, assets);

    return {
      filename: file.fileName,
      status: text ? 'matched' : 'error',
      typeId: type.id,
      sfiCode: type.sfiCode,
      typeName: type.name,
      archetype: type.archetype,
      certNo: this.str(fields.doc_number),
      issuer: this.str(fields.issuing_party),
      issueDate: this.date(fields.issue_date),
      fields,
      assetId: link?.id ?? null,
      assetName: link?.displayName ?? null,
      extractedText: text || undefined,
      message: text ? undefined : 'Could not read the document — fill fields manually.',
    };
  }

  /**
   * Read a batch of compliance documents and PROPOSE a type + fields + link
   * for each — nothing is saved. The operator reviews/edits these in the
   * upload window, then commit() persists the confirmed ones.
   */
  async preview(
    shipId: string,
    items: IngestItem[],
  ): Promise<{ proposals: IngestProposal[] }> {
    if (!this.llmService.isConfigured()) {
      throw new ServiceUnavailableException(
        'AI extraction is unavailable (LLM not configured).',
      );
    }
    if (!items.length) throw new BadRequestException('No documents provided.');

    const types = await this.typeRepository.find({ where: { shipId } });
    const assets = await this.assetRepository.find({
      where: { shipId },
      select: ['id', 'displayName', 'brand', 'model', 'serialNo'],
    });

    const proposals: IngestProposal[] = [];
    for (const item of items) {
      proposals.push(await this.proposeOne(item, types, assets));
    }
    return { proposals };
  }

  private async proposeOne(
    item: IngestItem,
    types: ComplianceDocTypeEntity[],
    assets: AssetEntity[],
  ): Promise<IngestProposal> {
    try {
      const text = (item.text?.trim() || (await this.extractText(item))).slice(
        0,
        MAX_TEXT,
      );
      if (!text.trim()) {
        return { filename: item.filename, status: 'error', message: 'No readable text.' };
      }

      const match = await this.classify(types, text);
      const type = match
        ? types.find((t) => t.sfiCode === match.sfiCode)
        : undefined;
      if (!match || !type) {
        return {
          filename: item.filename,
          status: 'unmatched',
          message: 'Could not match a compliance type.',
        };
      }

      const fields = await this.extractFields(type.archetype, text);
      const link = this.resolveAssetLink(type, fields, assets);

      return {
        filename: item.filename,
        status: 'matched',
        typeId: type.id,
        sfiCode: type.sfiCode,
        typeName: type.name,
        archetype: type.archetype,
        certNo: this.str(fields.doc_number),
        issuer: this.str(fields.issuing_party),
        issueDate: this.date(fields.issue_date),
        fields,
        assetId: link?.id ?? null,
        assetName: link?.displayName ?? null,
        confidence: match.confidence,
        extractedText: text || undefined,
      };
    } catch (error) {
      this.logger.warn(
        `propose failed for ${item.filename}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return {
        filename: item.filename,
        status: 'error',
        message: error instanceof Error ? error.message : 'Extraction failed.',
      };
    }
  }

  /**
   * One-off: re-read the stored file of every compliance record that has one but
   * no stored text, transcribe it (OCR included), and save the text — so records
   * uploaded before full-text was captured become chat-answerable too.
   */
  async backfillTexts(
    shipId: string,
    user: AuthenticatedUser,
  ): Promise<{ total: number; done: number; failed: number }> {
    const docs = await this.complianceService.docsNeedingText(shipId);
    let done = 0;
    let failed = 0;
    for (const doc of docs) {
      try {
        let buffer: Buffer | null = null;
        let filename = doc.fileName ?? 'document.pdf';
        if (doc.documentId) {
          const f = await this.documentsService.getFile(doc.documentId, user);
          buffer = f.buffer;
          filename = f.fileName;
        } else if (
          doc.fileStorageKey &&
          (await this.uploadStorage.hasUpload(doc.fileStorageKey))
        ) {
          buffer = await this.uploadStorage.readUpload(doc.fileStorageKey);
        }
        if (!buffer) continue;
        const text = (await this.extractText({ filename, buffer }))
          .slice(0, BACKFILL_MAX_TEXT)
          .trim();
        if (text) {
          await this.complianceService.setDocText(shipId, doc.id, text);
          done += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `backfill text failed for ${doc.id}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return { total: docs.length, done, failed };
  }

  /** Persist the operator-confirmed proposals as real (confirmed) records. */
  async commit(
    shipId: string,
    proposals: CommitProposal[],
    files?: IngestItem[],
  ): Promise<{ results: CommitResult[]; created: number }> {
    if (!proposals?.length) throw new BadRequestException('Nothing to commit.');
    const results: CommitResult[] = [];
    for (const p of proposals) {
      try {
        const record = await this.complianceService.createDoc(shipId, {
          docTypeId: p.typeId,
          certNo: p.certNo ?? null,
          issuer: p.issuer ?? null,
          issueDate: p.issueDate ?? null,
          assetId: p.assetId ?? null,
          crewMemberId: p.crewMemberId ?? null,
          fields: p.fields ?? null,
          extractedText: p.extractedText ?? null,
          verifyState: 'confirmed',
        });
        // Keep the original file so the operator can preview it later. The AI
        // batch path skips the documents/RAGFlow pipeline, so we store the
        // bytes directly against the record via the shared upload storage.
        const file = p.filename
          ? files?.find((f) => f.filename === p.filename)
          : undefined;
        if (file?.buffer?.length) {
          const storageKey = await this.uploadStorage.saveUpload(
            record.id,
            file.buffer,
          );
          await this.complianceService.setDocFile(shipId, record.id, {
            storageKey,
            fileName: file.filename,
            fileMime: mimeType(file.filename),
          });
        }
        results.push({ status: 'created', recordId: record.id });
      } catch (error) {
        results.push({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to save.',
        });
      }
    }
    return {
      results,
      created: results.filter((r) => r.status === 'created').length,
    };
  }

  // ── text + LLM ──

  private async extractText(item: IngestItem): Promise<string> {
    if (!item.buffer) throw new BadRequestException('Empty file.');
    // Photos / scans have no embedded text → read them with Claude vision.
    const mediaType = imageMediaType(item.filename);
    if (mediaType) {
      const text = await this.llmService.extractTextFromImage(
        item.buffer,
        mediaType,
      );
      return text ?? '';
    }
    const parsed = await pdfParse(item.buffer);
    const embedded = (parsed.text ?? '').trim();
    // Scanned certificates are image-only PDFs — pdf-parse returns (near)
    // nothing. Fall back to Claude, which reads the PDF's pages directly.
    if (embedded.length >= MIN_EMBEDDED_TEXT) return embedded;
    const ocr = await this.llmService.extractTextFromPdf(item.buffer);
    return (ocr?.trim() || embedded) ?? '';
  }

  /** Match the document to one of the ship's compliance types. */
  private async classify(
    types: ComplianceDocTypeEntity[],
    text: string,
  ): Promise<{ sfiCode: string; confidence: number } | null> {
    const list = types
      .map((t) => `${t.sfiCode} | ${t.name} | ${t.archetype ?? ''}`)
      .join('\n');
    const result = await this.llmService.createJsonChatCompletion<{
      sfiCode: string | null;
      confidence: number;
    }>({
      systemPrompt: CLASSIFY_PROMPT,
      userPrompt: `Compliance document types (code | name | archetype):\n${list}\n\nDocument text:\n"""\n${text}\n"""`,
      temperature: 0.1,
      maxTokens: 200,
    });
    if (!result?.sfiCode) return null;
    return { sfiCode: result.sfiCode, confidence: result.confidence ?? 0.5 };
  }

  /** Extract the archetype's field values from the document text. */
  private async extractFields(
    archetype: string | null,
    text: string,
  ): Promise<Record<string, unknown>> {
    const block = archetypeBlock(archetype).filter((f) => f.datatype !== 'fk');
    const spec = [
      'doc_number (the certificate / document number)',
      'issuing_party (who issued it)',
      'issue_date (date of issue, ISO)',
      ...block.map(
        (f) => `${f.field} (${f.datatype}; ${f.hint})${f.required ? ' [required]' : ''}`,
      ),
    ].join('\n');
    const result = await this.llmService.createJsonChatCompletion<{
      fields: Record<string, unknown>;
    }>({
      systemPrompt: EXTRACT_PROMPT,
      userPrompt: `Fields to capture:\n${spec}\n\nDocument text:\n"""\n${text}\n"""`,
      temperature: 0.1,
      maxTokens: 1500,
    });
    return result?.fields && typeof result.fields === 'object'
      ? result.fields
      : {};
  }

  /** Resolve an asset link from extracted serial / maker+model (asset docs). */
  private resolveAssetLink(
    type: ComplianceDocTypeEntity,
    fields: Record<string, unknown>,
    assets: AssetEntity[],
  ): AssetEntity | null {
    const card = type.linkCardinality;
    if (card !== 'single_asset' && card !== 'per_unit' && card !== 'sub_group') {
      return null;
    }
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const serial = norm(fields.equipment_serial ?? fields.serial);
    if (serial) {
      const bySerial = assets.find((a) => norm(a.serialNo) === serial);
      if (bySerial) return bySerial;
    }
    const maker = norm(fields.maker);
    const model = norm(fields.model);
    if (maker && model) {
      const byMakerModel = assets.find(
        (a) => norm(a.brand) === maker && norm(a.model) === model,
      );
      if (byMakerModel) return byMakerModel;
    }
    return null;
  }

  private str(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return s || null;
  }
  private date(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  }
}

const CLASSIFY_PROMPT = `You identify which compliance document type a vessel certificate is. You are given the ship's list of types (code | name | archetype) and the document's text. Pick the single best matching type. Return ONLY JSON: { "sfiCode": string|null, "confidence": number }. confidence 0..1. If nothing fits, sfiCode null.`;

const EXTRACT_PROMPT = `You extract structured fields from a vessel compliance document's text. Return ONLY JSON: { "fields": { <field>: <value> } }. Use the exact field keys given. Dates as ISO YYYY-MM-DD. Numbers as numbers. Only include fields you can actually find in the text; omit the rest. Do not invent values.

CRITICAL — expiry / validity dates:
- Only set expiry_date / next_due_date (or any "valid until" field) if the document EXPLICITLY states an expiry, "valid until", "date of expiry", or "expires on" date.
- NEVER derive an expiry from an issue date, date of build, delivery/acceptance date, survey date, or signature date.
- Many certificates are PERMANENT and have no expiry (e.g. Builder's Certificate, Certificate of Registry, Tonnage/Carving notes). For these, OMIT expiry_date entirely — do not guess one.`;
