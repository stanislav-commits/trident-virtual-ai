import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provenance on the SFI taxonomy: 'master' (SFI Master v14.6) vs 'vessel-ext'
 * (codes a vessel uses that the master template didn't enumerate). Re-seeded
 * by SfiService on boot.
 */
export class AddSfiTaxonomySource20260615000200 implements MigrationInterface {
  name = 'AddSfiTaxonomySource20260615000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sfi_taxonomy" ADD COLUMN "source" varchar(20) NOT NULL DEFAULT 'master'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sfi_taxonomy" DROP COLUMN "source"`);
  }
}
