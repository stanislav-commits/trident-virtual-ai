import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asset-document links get a type: 'pinned' (explicit human link, the only
 * kind that existed before) or 'excluded' (suppress a brand/model
 * auto-match that doesn't apply to this asset). Auto-matches are computed
 * on the fly, so "unlinking" one can't delete anything — it needs a
 * persistent suppression row instead.
 */
export class AddAssetDocumentLinkType20260611000100
  implements MigrationInterface
{
  name = 'AddAssetDocumentLinkType20260611000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_documents"
      ADD COLUMN "link_type" varchar(16) NOT NULL DEFAULT 'pinned'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "asset_documents" WHERE "link_type" <> 'pinned'
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_documents" DROP COLUMN "link_type"
    `);
  }
}
