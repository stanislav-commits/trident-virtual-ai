import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';

const LOCAL_SPOOL_PREFIX = 'local-spool://';

@Injectable()
export class DocumentsUploadStorageService {
  constructor(private readonly configService: ConfigService) {}

  isLocalSpoolKey(storageKey: string | null | undefined): storageKey is string {
    return Boolean(storageKey?.startsWith(LOCAL_SPOOL_PREFIX));
  }

  async saveUpload(documentId: string, buffer: Buffer): Promise<string> {
    const storageKey = `${LOCAL_SPOOL_PREFIX}${documentId}/source`;
    const filePath = this.resolveLocalSpoolKey(storageKey);

    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);

    return storageKey;
  }

  async readUpload(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.resolveLocalSpoolKey(storageKey));
  }

  async deleteUpload(storageKey: string | null | undefined): Promise<void> {
    if (!this.isLocalSpoolKey(storageKey)) {
      return;
    }

    await fs.rm(dirname(this.resolveLocalSpoolKey(storageKey)), {
      recursive: true,
      force: true,
    });
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
