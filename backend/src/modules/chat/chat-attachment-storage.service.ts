import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { formatError } from '../../common/utils/error.utils';

interface SpacesConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Chat attachment binaries (photos the crew sends to the assistant). Same
 * two providers and the SAME config switch as document storage
 * (`documents.storageProvider` / `DOCUMENTS_SPACES_*`), but a separate
 * object prefix (`chat-attachments/<sessionId>/<attachmentId>`) and local
 * spool dir. The provider used at upload time is recorded per attachment in
 * chat_messages.attachments (jsonb), so reads survive a provider switch.
 */
@Injectable()
export class ChatAttachmentStorageService {
  private readonly logger = new Logger(ChatAttachmentStorageService.name);
  private s3Client: S3Client | null = null;

  constructor(private readonly configService: ConfigService) {}

  currentProvider(): 'local' | 'spaces' {
    return this.configService.get<string>('documents.storageProvider', 'local') ===
      'spaces'
      ? 'spaces'
      : 'local';
  }

  async save(
    sessionId: string,
    photoId: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<'local' | 'spaces'> {
    const provider = this.currentProvider();
    if (provider === 'spaces') {
      // Spaces-first: write the object before the caller persists the photo
      // entry, so we never record metadata for a missing object.
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: this.objectKey(sessionId, photoId),
          Body: buffer,
          ContentType: contentType,
          ACL: 'private',
        }),
      );
      return provider;
    }
    const filePath = this.localPath(sessionId, photoId);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return provider;
  }

  async read(
    provider: 'local' | 'spaces',
    sessionId: string,
    photoId: string,
  ): Promise<Buffer> {
    if (provider === 'spaces') {
      const out = await this.s3().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: this.objectKey(sessionId, photoId),
        }),
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    }
    return fs.readFile(this.localPath(sessionId, photoId));
  }

  /** Best-effort: a missing binary must not block deleting the DB record. */
  async delete(
    provider: 'local' | 'spaces',
    sessionId: string,
    photoId: string,
  ): Promise<void> {
    try {
      if (provider === 'spaces') {
        await this.s3().send(
          new DeleteObjectCommand({
            Bucket: this.bucket(),
            Key: this.objectKey(sessionId, photoId),
          }),
        );
        return;
      }
      await fs.rm(this.localPath(sessionId, photoId), { force: true });
    } catch (error) {
      this.logger.warn(
        `Chat attachment delete failed (${provider} ${sessionId}/${photoId}): ${formatError(error)}`,
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private objectKey(sessionId: string, photoId: string): string {
    return `chat-attachments/${this.safeSegment(sessionId)}/${this.safeSegment(photoId)}`;
  }

  private localPath(sessionId: string, photoId: string): string {
    const baseDir = resolve(
      this.configService
        .get<string>('documents.uploadSpoolDir', '')
        .trim()
        // Photos live NEXT TO the document spool, not inside it — the
        // documents delete path removes whole <docId> directories.
        ? join(
            resolve(this.configService.get<string>('documents.uploadSpoolDir', '').trim()),
            '..',
            'chat-attachment-spool',
          )
        : join(process.cwd(), 'storage', 'chat-attachment-spool'),
    );
    const filePath = resolve(
      baseDir,
      this.safeSegment(sessionId),
      this.safeSegment(photoId),
    );
    if (filePath !== baseDir && !filePath.startsWith(`${baseDir}${sep}`)) {
      throw new Error('Chat attachment path escapes the spool directory.');
    }
    return filePath;
  }

  private safeSegment(value: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(value)) {
      throw new Error('Invalid chat attachment path segment.');
    }
    return value;
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
}
