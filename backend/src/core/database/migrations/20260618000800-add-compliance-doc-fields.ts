import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D2 of the doc-control schema: the compliance record (compliance_docs)
 * gains archetype-specific captured field values + verification state.
 *
 * - fields (jsonb): the archetype's captured field values (BASE + archetype
 *   block). The [AUTH] validity field also flows into expiry_date, which
 *   stays the canonical column for status derivation.
 * - verify_state: 'confirmed' (system-generated / human-confirmed) or 'auto'
 *   (AI-extracted, pending confirmation).
 * - extracted_confidence: 0..1 extractor confidence, null for manual records.
 */
export class AddComplianceDocFields20260618000800 implements MigrationInterface {
  name = 'AddComplianceDocFields20260618000800';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs"
         ADD COLUMN IF NOT EXISTS "fields" jsonb,
         ADD COLUMN IF NOT EXISTS "verify_state" varchar(12) NOT NULL DEFAULT 'confirmed',
         ADD COLUMN IF NOT EXISTS "extracted_confidence" numeric(4,3)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs"
         DROP COLUMN IF EXISTS "fields",
         DROP COLUMN IF EXISTS "verify_state",
         DROP COLUMN IF EXISTS "extracted_confidence"`,
    );
  }
}
