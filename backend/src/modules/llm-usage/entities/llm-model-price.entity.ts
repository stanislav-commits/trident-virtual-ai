import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * What a model costs, editable without a deploy.
 *
 * One row per model PREFIX, matched longest-first, so a dated alias
 * (claude-sonnet-4-6-20251114) is covered by its family row and a specific
 * version can still be given its own price by adding a longer prefix.
 *
 * Only the two numbers a person can read off a pricing page are stored. The
 * cache rates are derived from the input rate by fixed multipliers — those are
 * ratios in the provider's billing model, not prices someone types in, and
 * asking an operator for five numbers instead of two invites four of them to be
 * wrong.
 *
 * Editing a row changes what NEW calls cost. Every usage row carries the prices
 * it was charged at, so an issued statement never moves when a rate changes
 * here.
 */
@Entity('llm_model_prices')
export class LlmModelPriceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lower-cased model prefix, e.g. "claude-sonnet-4". Unique. */
  @Column({ name: 'model_prefix', type: 'varchar', length: 64, unique: true })
  modelPrefix!: string;

  @Column({ name: 'input_per_mtok', type: 'numeric', precision: 10, scale: 4 })
  inputPerMTok!: string;

  @Column({ name: 'output_per_mtok', type: 'numeric', precision: 10, scale: 4 })
  outputPerMTok!: string;

  /** Where the number came from — a pricing page, a contract, a quote. */
  @Column({ name: 'note', type: 'varchar', length: 200, nullable: true })
  note!: string | null;

  @Column({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
