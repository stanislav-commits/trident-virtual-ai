import { MigrationInterface, QueryRunner } from 'typeorm';

type MetricConceptMemberRow = {
  id: string;
  concept_id: string;
  metric_catalog_id: string | null;
  child_concept_id: string | null;
  role: string | null;
  sort_order: number;
  created_at: string;
};

type FlattenedLeaf = {
  metricCatalogId: string;
  role: string | null;
};

export class FlattenMetricConceptChildMembers20260420000100
  implements MigrationInterface
{
  name = 'FlattenMetricConceptChildMembers20260420000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT
        id,
        concept_id,
        metric_catalog_id,
        child_concept_id,
        role,
        sort_order,
        created_at
      FROM metric_concept_members
      ORDER BY concept_id ASC, sort_order ASC, created_at ASC, id ASC
    `)) as MetricConceptMemberRow[];

    const membersByConcept = new Map<string, MetricConceptMemberRow[]>();

    for (const row of rows) {
      const bucket = membersByConcept.get(row.concept_id) ?? [];
      bucket.push(row);
      membersByConcept.set(row.concept_id, bucket);
    }

    const memo = new Map<string, FlattenedLeaf[]>();

    const collectLeaves = (
      conceptId: string,
      lineage: string[] = [],
    ): FlattenedLeaf[] => {
      const cached = memo.get(conceptId);

      if (cached) {
        return cached;
      }

      if (lineage.includes(conceptId)) {
        throw new Error(
          `Cannot flatten recursive metric concept members for concept ${conceptId}`,
        );
      }

      const members = membersByConcept.get(conceptId) ?? [];
      const leaves: FlattenedLeaf[] = [];
      const seenMetricIds = new Set<string>();

      for (const member of members) {
        if (member.metric_catalog_id) {
          if (!seenMetricIds.has(member.metric_catalog_id)) {
            leaves.push({
              metricCatalogId: member.metric_catalog_id,
              role: member.role,
            });
            seenMetricIds.add(member.metric_catalog_id);
          }

          continue;
        }

        if (!member.child_concept_id) {
          continue;
        }

        const childLeaves = collectLeaves(member.child_concept_id, [
          ...lineage,
          conceptId,
        ]);

        for (const childLeaf of childLeaves) {
          if (seenMetricIds.has(childLeaf.metricCatalogId)) {
            continue;
          }

          leaves.push({
            metricCatalogId: childLeaf.metricCatalogId,
            role: member.role ?? childLeaf.role,
          });
          seenMetricIds.add(childLeaf.metricCatalogId);
        }
      }

      memo.set(conceptId, leaves);
      return leaves;
    };

    const affectedConceptIds = [
      ...new Set(
        rows
          .filter((row) => row.child_concept_id !== null)
          .map((row) => row.concept_id),
      ),
    ];

    for (const conceptId of affectedConceptIds) {
      const flattenedMembers = collectLeaves(conceptId);

      await queryRunner.query(
        `DELETE FROM metric_concept_members WHERE concept_id = $1`,
        [conceptId],
      );

      for (const [index, member] of flattenedMembers.entries()) {
        await queryRunner.query(
          `
            INSERT INTO metric_concept_members (
              concept_id,
              metric_catalog_id,
              role,
              sort_order
            )
            VALUES ($1, $2, $3, $4)
          `,
          [conceptId, member.metricCatalogId, member.role, index],
        );
      }
    }

    await queryRunner.query(
      `DELETE FROM metric_concept_members WHERE child_concept_id IS NOT NULL`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concept_members_concept_child"`,
    );
    await queryRunner.query(
      `ALTER TABLE "metric_concept_members" DROP CONSTRAINT IF EXISTS "FK_metric_concept_members_child_concept_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "metric_concept_members" DROP CONSTRAINT IF EXISTS "CHK_metric_concept_members_target"`,
    );
    await queryRunner.query(
      `ALTER TABLE "metric_concept_members" ALTER COLUMN "metric_catalog_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "metric_concept_members" DROP COLUMN IF EXISTS "child_concept_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "metric_concept_members" ADD COLUMN IF NOT EXISTS "child_concept_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "metric_concept_members" ALTER COLUMN "metric_catalog_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "metric_concept_members"
      ADD CONSTRAINT "CHK_metric_concept_members_target"
      CHECK (num_nonnulls("metric_catalog_id", "child_concept_id") = 1)
    `);
    await queryRunner.query(`
      ALTER TABLE "metric_concept_members"
      ADD CONSTRAINT "FK_metric_concept_members_child_concept_id"
      FOREIGN KEY ("child_concept_id")
      REFERENCES "metric_concepts"("id")
      ON DELETE CASCADE
      ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_metric_concept_members_concept_child"
      ON "metric_concept_members" ("concept_id", "child_concept_id")
      WHERE "child_concept_id" IS NOT NULL
    `);
  }
}
