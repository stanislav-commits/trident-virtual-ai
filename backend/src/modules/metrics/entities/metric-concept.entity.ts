import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MetricAggregationRule } from '../enums/metric-aggregation-rule.enum';
import { MetricConceptType } from '../enums/metric-concept-type.enum';
import { MetricConceptAliasEntity } from './metric-concept-alias.entity';
import { MetricConceptMemberEntity } from './metric-concept-member.entity';

@Entity('metric_concepts')
@Index('IDX_metric_concepts_slug', ['slug'], { unique: true })
@Index('IDX_metric_concepts_category', ['category'])
export class MetricConceptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  slug!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255 })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category!: string | null;

  @Column({
    type: 'enum',
    enum: MetricConceptType,
  })
  type!: MetricConceptType;

  @Column({
    name: 'aggregation_rule',
    type: 'enum',
    enum: MetricAggregationRule,
    default: MetricAggregationRule.NONE,
  })
  aggregationRule!: MetricAggregationRule;

  @Column({ type: 'varchar', length: 50, nullable: true })
  unit!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @OneToMany(() => MetricConceptAliasEntity, (alias) => alias.concept)
  aliases!: MetricConceptAliasEntity[];

  @OneToMany(() => MetricConceptMemberEntity, (member) => member.concept)
  members!: MetricConceptMemberEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
