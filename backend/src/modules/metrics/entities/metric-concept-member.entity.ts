import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MetricConceptEntity } from './metric-concept.entity';
import { ShipMetricCatalogEntity } from './ship-metric-catalog.entity';

@Entity('metric_concept_members')
@Index('IDX_metric_concept_members_concept_sort', ['conceptId', 'sortOrder'])
@Index(
  'IDX_metric_concept_members_concept_metric',
  ['conceptId', 'metricCatalogId'],
  {
    unique: true,
    where: '"metric_catalog_id" IS NOT NULL',
  },
)
@Index(
  'IDX_metric_concept_members_concept_child',
  ['conceptId', 'childConceptId'],
  {
    unique: true,
    where: '"child_concept_id" IS NOT NULL',
  },
)
export class MetricConceptMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'concept_id', type: 'uuid' })
  conceptId!: string;

  @ManyToOne(() => MetricConceptEntity, (concept) => concept.members, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'concept_id' })
  concept!: MetricConceptEntity;

  @Column({ name: 'metric_catalog_id', type: 'uuid', nullable: true })
  metricCatalogId!: string | null;

  @ManyToOne(() => ShipMetricCatalogEntity, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'metric_catalog_id' })
  metricCatalog!: ShipMetricCatalogEntity | null;

  @Column({ name: 'child_concept_id', type: 'uuid', nullable: true })
  childConceptId!: string | null;

  @ManyToOne(() => MetricConceptEntity, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'child_concept_id' })
  childConcept!: MetricConceptEntity | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  role!: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
