import { formatError } from '../../../common/utils/error.utils';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const LOCAL_SPOOL_PREFIX = 'local-spool://';
const SPACES_PREFIX = 'spaces://';

interface SpacesConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Document original/extracted storage. Two providers behind one interface:
 *   - 'local'  → backend disk spool (legacy), keys `local-spool://<docId>/<name>`
 *   - 'spaces' → DigitalOcean Spaces (S3), keys `spaces://<docId>/<name>`
 * Object key in the bucket is `documents/<docId>/<name>`. Reads/writes route by
 * the key prefix, so old local-spool docs keep working after the switch.
 */
@Injectable()
export class DocumentsUploadStorageService {
  private readonly logger = new Logger(DocumentsUploadStorageService.name);
  private s3Client: S3Client | null = null;

  constructor(private readonly configService: ConfigService) {}

  // ── key predicates ──────────────────────────────────────────────
  isLocalSpoolKey(storageKey: string | null | undefined): storageKey is string {
    return Boolean(storageKey?.startsWith(LOCAL_SPOOL_PREFIX));
  }

  isObjectStorageKey(
    storageKey: string | null | undefined,
  ): storageKey is string {
    return Boolean(storageKey?.startsWith(SPACES_PREFIX));
  }

  private get provider(): string {
    return this.configService.get<string>('documents.storageProvider', 'local');
  }

  // ── save ─────────────────────────────────────────────────────────
  async saveUpload(documentId: string, buffer: Buffer): Promise<string> {
    if (this.provider === 'spaces') {
      return this.saveToSpaces(documentId, 'source', buffer, 'application/pdf');
    }
    return this.saveToLocalSpool(documentId, 'source', buffer);
  }

  /** Extracted markdown sits next to the source under the same doc prefix. */
  async saveExtractedMarkdown(
    documentId: string,
    buffer: Buffer,
  ): Promise<string> {
    if (this.provider === 'spaces') {
      return this.saveToSpaces(
        documentId,
        'extracted.md',
        buffer,
        'text/markdown; charset=utf-8',
      );
    }
    return this.saveToLocalSpool(documentId, 'extracted.md', buffer);
  }

  // ── read ─────────────────────────────────────────────────────────
  async readUpload(storageKey: string): Promise<Buffer> {
    if (this.isObjectStorageKey(storageKey)) {
      const out = await this.s3().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: this.resolveSpacesObjectKey(storageKey),
        }),
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    }
    return fs.readFile(this.resolveLocalSpoolKey(storageKey));
  }

  // ── existence ────────────────────────────────────────────────────
  async hasUpload(storageKey: string | null | undefined): Promise<boolean> {
    if (this.isObjectStorageKey(storageKey)) {
      try {
        await this.s3().send(
          new HeadObjectCommand({
            Bucket: this.bucket(),
            Key: this.resolveSpacesObjectKey(storageKey),
          }),
        );
        return true;
      } catch {
        return false;
      }
    }
    if (!this.isLocalSpoolKey(storageKey)) {
      return false;
    }
    try {
      await fs.access(this.resolveLocalSpoolKey(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  // ── delete (whole document: source + extracted) ──────────────────
  async deleteUpload(storageKey: string | null | undefined): Promise<void> {
    if (this.isObjectStorageKey(storageKey)) {
      const docId = this.spacesDocId(storageKey);
      for (const name of ['source', 'extracted.md']) {
        try {
          await this.s3().send(
            new DeleteObjectCommand({
              Bucket: this.bucket(),
              Key: `documents/${docId}/${name}`,
            }),
          );
        } catch (error) {
          this.logger.warn(
            `Spaces delete failed for documents/${docId}/${name}: ${
              formatError(error)
            }`,
          );
        }
      }
      return;
    }
    if (!this.isLocalSpoolKey(storageKey)) {
      return;
    }
    await fs.rm(dirname(this.resolveLocalSpoolKey(storageKey)), {
      recursive: true,
      force: true,
    });
  }

  // ── Spaces (S3) internals ────────────────────────────────────────
  private async saveToSpaces(
    documentId: string,
    name: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const objectKey = `documents/${documentId}/${name}`;
    // Spaces-first: write the object before the caller persists the key in the
    // DB. A failure here throws, so we never record a key for a missing object.
    await this.s3().send(
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: objectKey,
        Body: buffer,
        ContentType: contentType,
        ACL: 'private',
      }),
    );
    return `${SPACES_PREFIX}${documentId}/${name}`;
  }

  private s3(): S3Client {
    if (this.s3Client) {
      return this.s3Client;
    }
    const cfg = this.configService.get<SpacesConfig>('documents.spaces');
    if (
      !cfg?.endpoint ||
      !cfg?.bucket ||
      !cfg?.accessKeyId ||
      !cfg?.secretAccessKey
    ) {
      throw new Error(
        'DOCUMENTS_SPACES_* config is incomplete: endpoint, bucket, access key and secret are required for the spaces provider.',
      );
    }
    this.s3Client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region || 'us-east-1',
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    return this.s3Client;
  }

  private bucket(): string {
    return this.configService.get<string>('documents.spaces.bucket', '');
  }

  private spacesRelParts(storageKey: string): string[] {
    const parts = storageKey
      .slice(SPACES_PREFIX.length)
      .split('/')
      .filter(Boolean);
    if (parts.length < 2 || parts.some((part) => part === '..')) {
      throw new Error('Invalid spaces document storage key.');
    }
    return parts;
  }

  private resolveSpacesObjectKey(storageKey: string): string {
    return `documents/${this.spacesRelParts(storageKey).join('/')}`;
  }

  private spacesDocId(storageKey: string): string {
    return this.spacesRelParts(storageKey)[0];
  }

  // ── local spool internals (unchanged behaviour) ──────────────────
  private async saveToLocalSpool(
    documentId: string,
    name: string,
    buffer: Buffer,
  ): Promise<string> {
    const storageKey = `${LOCAL_SPOOL_PREFIX}${documentId}/${name}`;
    const filePath = this.resolveLocalSpoolKey(storageKey);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return storageKey;
  }

  private resolveLocalSpoolKey(storageKey: string): string {
    if (!this.isLocalSpoolKey(storageKey)) {
      throw new Error('Storage key does not reference a local document upload.');
    }

    const relativePath = storageKey.slice(LOCAL_SPOOL_PREFIX.length);
    const safeParts = relativePath.split('/').filter(Boolean);

    if (safeParts.length < 2 || safeParts.some((part) => part === '..')) {
      throw new Error('Invalid local document upload storage key.');
    }

    const baseDir = this.getBaseDir();
    const filePath = resolve(baseDir, ...safeParts);

    if (filePath !== baseDir && !filePath.startsWith(`${baseDir}${sep}`)) {
      throw new Error('Local document upload path escapes the spool directory.');
    }

    return filePath;
  }

  private getBaseDir(): string {
    const configuredDir = this.configService
      .get<string>('documents.uploadSpoolDir', '')
      .trim();

    return resolve(
      configuredDir || join(process.cwd(), 'storage', 'document-upload-spool'),
    );
  }
}
