import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ComplianceDocTypeEntity } from './compliance-doc-type.entity';

/**
 * A dependency edge between two catalogue rows (v60 Phase 4), from the
 * Behaviour Matrix Dependency columns: DOC → SMC, SSP → ISSC, DMLC I/II →
 * MLC, Certificate of Classification → Interim Class… When the PARENT's
 * current record is replaced or invalidated, the CHILD's current records get
 * a TO-REVIEW flag — a Form R that lists equipment under a radio certificate
 * that no longer exists must be looked at, not silently trusted.
 */
@Entity('compliance_type_relations')
@Unique('UQ_compliance_type_relation', ['parentTypeId', 'childTypeId'])
@Index('IDX_compliance_type_relations_ship', ['shipId'])
export class ComplianceTypeRelationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ name: 'parent_type_id', type: 'uuid' })
  parentTypeId!: string;

  @ManyToOne(() => ComplianceDocTypeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_type_id' })
  parentType!: ComplianceDocTypeEntity;

  @Column({ name: 'child_type_id', type: 'uuid' })
  childTypeId!: string;

  @ManyToOne(() => ComplianceDocTypeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'child_type_id' })
  childType!: ComplianceDocTypeEntity;

  /** child (statutory pair) | derived | asset — from the Dependency Type column. */
  @Column({ name: 'relation', type: 'varchar', length: 30, default: 'child' })
  relation!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
