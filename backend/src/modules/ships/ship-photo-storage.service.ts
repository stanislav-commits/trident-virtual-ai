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

/**
 * The single photo of a vessel, shown on the Overview page.
 *
 * Same two providers and the same config switch as document and task-photo
 * storage (`documents.storageProvider` / `DOCUMENTS_SPACES_*`) — one operational
 * knob for all file storage — with its own object prefix and spool dir so the
 * three never collide. One object per vessel, overwritten on re-upload: the
 * provider in use is recorded on the ships row, so reads keep working after a
 * provider switch.
 */
@Injectable()
export class ShipPhotoStorageService {
  private readonly logger = new Logger(ShipPhotoStorageService.name);
  private s3Client: S3Client | null = null;

  constructor(private readonly configService: ConfigService) {}

  currentProvider(): 'local' | 'spaces' {
    return this.configService.get<string>(
      'documents.storageProvider',
      'local',
    ) === 'spaces'
      ? 'spaces'
      : 'local';
  }

  async save(
    shipId: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<'local' | 'spaces'> {
    const provider = this.currentProvider();
    if (provider === 'spaces') {
      // Object first, then the row: never record metadata for a missing object.
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: this.objectKey(shipId),
          Body: buffer,
          ContentType: contentType,
          ACL: 'private',
        }),
      );
      return provider;
    }
    const filePath = this.localPath(shipId);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return provider;
  }

  async read(provider: 'local' | 'spaces', shipId: string): Promise<Buffer> {
    if (provider === 'spaces') {
      const out = await this.s3().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: this.objectKey(shipId),
        }),
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    }
    return fs.readFile(this.localPath(shipId));
  }

  /** Best-effort: a missing binary must not block clearing the row. */
  async delete(provider: 'local' | 'spaces', shipId: string): Promise<void> {
    try {
      if (provider === 'spaces') {
        await this.s3().send(
          new DeleteObjectCommand({
            Bucket: this.bucket(),
            Key: this.objectKey(shipId),
          }),
        );
        return;
      }
      await fs.rm(this.localPath(shipId), { force: true });
    } catch (error) {
      this.logger.warn(
        `Ship photo delete failed (${provider} ${shipId}): ${formatError(error)}`,
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private objectKey(shipId: string): string {
    return `ship-photos/${this.safeSegment(shipId)}`;
  }

  private localPath(shipId: string): string {
    const spool = this.configService
      .get<string>('documents.uploadSpoolDir', '')
      .trim();
    const baseDir = resolve(
      spool
        ? join(resolve(spool), '..', 'ship-photo-spool')
        : join(process.cwd(), 'storage', 'ship-photo-spool'),
    );
    const filePath = resolve(baseDir, this.safeSegment(shipId));
    if (!filePath.startsWith(`${baseDir}${sep}`)) {
      throw new Error('Ship photo path escapes the spool directory.');
    }
    return filePath;
  }

  private safeSegment(value: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(value)) {
      throw new Error('Invalid ship photo path segment.');
    }
    return value;
  }

  private bucket(): string {
    const bucket = this.spaces().bucket;
    if (!bucket) throw new Error('Spaces bucket is not configured.');
    return bucket;
  }

  private spaces(): SpacesConfig {
    return {
      endpoint: this.configService.get<string>('documents.spaces.endpoint', ''),
      region: this.configService.get<string>('documents.spaces.region', ''),
      bucket: this.configService.get<string>('documents.spaces.bucket', ''),
      accessKeyId: this.configService.get<string>(
        'documents.spaces.accessKeyId',
        '',
      ),
      secretAccessKey: this.configService.get<string>(
        'documents.spaces.secretAccessKey',
        '',
      ),
    };
  }

  private s3(): S3Client {
    if (this.s3Client) return this.s3Client;
    const cfg = this.spaces();
    if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new Error('Spaces storage is not configured.');
    }
    this.s3Client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region || 'us-east-1',
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: false,
    });
    return this.s3Client;
  }
}

interface SpacesConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
