import 'dotenv/config';
import { promises as fs } from 'fs';
import { join, resolve, sep } from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import dataSource from '../core/database/typeorm.datasource';
import { DocumentEntity } from '../modules/documents/entities/document.entity';
import { ComplianceDocEntity } from '../modules/compliance/entities/compliance-doc.entity';

/**
 * One-off: move every original/extracted file that still lives on the backend
 * disk (local-spool://…) into DigitalOcean Spaces (spaces://…), rewriting the
 * DB storage keys. Idempotent — only local-spool keys are touched, so a second
 * run is a no-op. After a clean run the droplet holds no document files.
 *
 *   npm run storage:migrate-spaces          # migrate + rewrite keys
 *   npm run storage:migrate-spaces -- --purge  # also delete each local file
 */

const LOCAL_PREFIX = 'local-spool://';
const SPACES_PREFIX = 'spaces://';
const PURGE = process.argv.includes('--purge');

function baseDir(): string {
  const configured = (process.env.DOCUMENT_UPLOAD_SPOOL_DIR ?? '').trim();
  return resolve(configured || join(process.cwd(), 'storage', 'document-upload-spool'));
}

function requireEnv(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function makeS3(): { client: S3Client; bucket: string } {
  const endpoint = requireEnv('DOCUMENTS_SPACES_ENDPOINT');
  const bucket = requireEnv('DOCUMENTS_SPACES_BUCKET');
  const client = new S3Client({
    endpoint,
    region: (process.env.DOCUMENTS_SPACES_REGION ?? 'us-east-1').trim(),
    credentials: {
      accessKeyId: requireEnv('DOCUMENTS_SPACES_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('DOCUMENTS_SPACES_SECRET_ACCESS_KEY'),
    },
  });
  return { client, bucket };
}

/** Resolve + sandbox a local-spool key to an absolute path under the spool dir. */
function localPath(localKey: string): { path: string; rel: string } {
  const rel = localKey.slice(LOCAL_PREFIX.length);
  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === '..')) {
    throw new Error(`Invalid local-spool key: ${localKey}`);
  }
  const base = baseDir();
  const path = resolve(base, ...parts);
  if (path !== base && !path.startsWith(`${base}${sep}`)) {
    throw new Error(`Key escapes spool dir: ${localKey}`);
  }
  return { path, rel: parts.join('/') };
}

async function run() {
  const { client, bucket } = makeS3();
  await dataSource.initialize();

  let migrated = 0;
  let missing = 0;
  let purged = 0;

  /** Migrate one local-spool key → spaces key. null if nothing to do. */
  const migrate = async (
    key: string | null,
    contentType: string,
  ): Promise<string | null> => {
    if (!key || !key.startsWith(LOCAL_PREFIX)) return null;
    const { path, rel } = localPath(key);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path);
    } catch {
      missing += 1;
      console.warn(`  ! local file missing, leaving key as-is: ${key}`);
      return null;
    }
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `documents/${rel}`,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        ACL: 'private',
      }),
    );
    migrated += 1;
    if (PURGE) {
      await fs.rm(path, { force: true });
      purged += 1;
    }
    return `${SPACES_PREFIX}${rel}`;
  };

  // ── Documents (source + extracted markdown) ──
  const docRepo = dataSource.getRepository(DocumentEntity);
  const docs = await docRepo
    .createQueryBuilder('d')
    .where('d.storageKey LIKE :p OR d.extractedMdKey LIKE :p', {
      p: `${LOCAL_PREFIX}%`,
    })
    .getMany();
  console.log(`Documents with local files: ${docs.length}`);
  for (const doc of docs) {
    const newSource = await migrate(
      doc.storageKey,
      doc.mimeType || 'application/pdf',
    );
    const newMd = await migrate(doc.extractedMdKey, 'text/markdown; charset=utf-8');
    if (newSource || newMd) {
      await docRepo.update(doc.id, {
        ...(newSource ? { storageKey: newSource } : {}),
        ...(newMd ? { extractedMdKey: newMd } : {}),
      });
    }
  }

  // ── Compliance directly-stored files ──
  const compRepo = dataSource.getRepository(ComplianceDocEntity);
  const comps = await compRepo
    .createQueryBuilder('c')
    .where('c.fileStorageKey LIKE :p', { p: `${LOCAL_PREFIX}%` })
    .getMany();
  console.log(`Compliance records with local files: ${comps.length}`);
  for (const rec of comps) {
    const newKey = await migrate(
      rec.fileStorageKey,
      rec.fileMime || 'application/pdf',
    );
    if (newKey) await compRepo.update(rec.id, { fileStorageKey: newKey });
  }

  await dataSource.destroy();
  console.log(
    `\nDone. uploaded=${migrated} missing=${missing}${PURGE ? ` purged=${purged}` : ''}`,
  );
  if (missing > 0) {
    console.log(
      'Some local files were missing — their keys were left unchanged. Investigate before deleting the spool dir.',
    );
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
