import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { ManualsCostImportService } from '../../../modules/llm-usage/manuals-cost-import.service';

/**
 * Replay the manual extractor's audit log into the ledger.
 *
 * Runs on demand — once to backfill the history the extractor accumulated
 * before the ledger existed, and again whenever the importer changes. Every
 * run is idempotent: rows carry their own conflict key, so a full replay adds
 * only what is missing.
 *
 *   npm run db:import-manual-costs
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    // Errors and warnings only: booting the whole app to run one import prints
    // a screenful of route mappings otherwise. The summary below is the output
    // that matters, so it goes to stdout directly.
    logger: ['error', 'warn'],
  });
  try {
    const importer = app.get(ManualsCostImportService);
    const { imported, skipped } = await importer.import();
    console.log(
      `Imported ${imported} calls; skipped ${skipped} cache hits (no provider call).`,
    );
  } finally {
    await app.close();
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
