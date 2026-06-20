import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A person on a vessel's crew roster. Distinct from a platform login
 * (users): a roster entry exists for everyone aboard (incl. ratings with no
 * account); when they DO log in, userId links to their users row and their
 * department+rank drive rank-based access (phase 5c).
 *
 * Departments: engine | bridge | ratings | other.
 * rankLevel = within-department seniority, 1 = most senior (head of dept).
 */
@Entity('crew_members')
@Index('IDX_crew_ship', ['shipId'])
export class CrewMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'other' })
  department!: string;

  @Column({ type: 'varchar', length: 60 })
  rank!: string;

  @Column({ name: 'rank_level', type: 'integer', default: 5 })
  rankLevel!: number;

  @Column({ type: 'varchar', length: 160, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone!: string | null;

  /** Optional link to a platform login (users.id). */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'joined_at', type: 'date', nullable: true })
  joinedAt!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
