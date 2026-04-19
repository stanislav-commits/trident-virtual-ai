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

@Entity('metric_concept_aliases')
@Index('IDX_metric_concept_aliases_concept_alias', ['conceptId', 'alias'], {
  unique: true,
})
@Index('IDX_metric_concept_aliases_alias', ['alias'])
export class MetricConceptAliasEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'concept_id', type: 'uuid' })
  conceptId!: string;

  @ManyToOne(() => MetricConceptEntity, (concept) => concept.aliases, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'concept_id' })
  concept!: MetricConceptEntity;

  @Column({ type: 'varchar', length: 255 })
  alias!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
