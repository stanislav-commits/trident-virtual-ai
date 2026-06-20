import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D4 (identity reconciliation): a compliance record's identity fields
 * (serial / model / maker on EQUIP_TYPE) are checked against the linked
 * asset in the register. The REGISTER WINS — the document only flags a
 * mismatch. identity_flags stores the flagged discrepancies for display.
 */
export class AddComplianceIdentityFlags20260618001100
  implements MigrationInterface
{
  name = 'AddComplianceIdentityFlags20260618001100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" ADD COLUMN "identity_flags" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" DROP COLUMN IF EXISTS "identity_flags"`,
    );
  }
}
