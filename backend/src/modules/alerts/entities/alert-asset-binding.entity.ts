import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Interim alertname→asset mapping. The 210 hand-made Grafana rules carry no
 * `metric_key`/`asset_id` labels, so the catalog resolver can't bind them to
 * an asset. Until Stage 2 (Trident provisions rules with labels), this table
 * maps a rule name (labels.alertname) to the asset it watches; the resolver
 * uses it as a last-resort fallback. Curated by hand — PLC tank numbering
 * doesn't always match the register, so rows are only added where the match
 * is unambiguous.
 */
@Entity('alert_asset_bindings')
@Index('UQ_alert_asset_bindings_ship_rule', ['shipId', 'ruleName'], {
  unique: true,
})
export class AlertAssetBindingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** Exact Grafana rule name (labels.alertname). */
  @Column({ name: 'rule_name', type: 'varchar', length: 255 })
  ruleName!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  /** Why/how this mapping was made (e.g. "PLC 8S = register Fuel Oil Daily Tank 08 Stbd"). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
