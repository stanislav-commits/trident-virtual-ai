import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `range_aggregation_hint` to metric_concepts so each concept can
 * declare its preferred time-axis aggregation when timeMode = RANGE.
 *
 * Background: `aggregation_rule` only describes how to combine *members*
 * of a composite concept at one point in time. The time-axis aggregation
 * (mean / sum / last / delta / integral …) is orthogonal and was previously
 * hard-coded to MEAN in the responder. With this column the concept can
 * say "I am a cumulative counter, use delta over the window" or "I am a
 * rate, use integral over the window".
 *
 * NULL keeps current behaviour (defaults to MEAN at the responder).
 */
export class AddMetricConceptRangeAggregationHint20260601000100
  implements MigrationInterface
{
  name = 'AddMetricConceptRangeAggregationHint20260601000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "metric_concepts"
      ADD COLUMN "range_aggregation_hint" character varying(20)
    `);

    await queryRunner.query(`
      ALTER TABLE "metric_concepts"
      ADD CONSTRAINT "CHK_metric_concepts_range_aggregation_hint"
      CHECK (
        "range_aggregation_hint" IS NULL OR
        "range_aggregation_hint" IN (
          'mean',
          'sum',
          'last',
          'first',
          'min',
          'max',
          'delta',
          'integral'
        )
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "metric_concepts"
      DROP CONSTRAINT IF EXISTS "CHK_metric_concepts_range_aggregation_hint"
    `);
    await queryRunner.query(`
      ALTER TABLE "metric_concepts"
      DROP COLUMN "range_aggregation_hint"
    `);
  }
}
