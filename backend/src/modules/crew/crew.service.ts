import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CrewMemberEntity } from './entities/crew-member.entity';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { UserRole } from '../../common/enums/user-role.enum';
import { AdminEventBus } from '../admin-events/admin-event.bus';
import {
  CREW_DEPARTMENTS,
  DEPARTMENT_KEYS,
  defaultRankLevel,
  seesAllDepartments,
} from './crew-ranks';

/** What a logged-in crew member is allowed to see (phase 5c). */
export interface CrewAccess {
  department: string;
  rank: string;
  rankLevel: number;
  seesAll: boolean;
}

export interface UpsertCrewInput {
  name: string;
  department?: string;
  rank?: string;
  rankLevel?: number | null;
  email?: string | null;
  phone?: string | null;
  userId?: string | null;
  active?: boolean;
  joinedAt?: string | null;
  notes?: string | null;
}

@Injectable()
export class CrewService {
  constructor(
    @InjectRepository(CrewMemberEntity)
    private readonly crewRepository: Repository<CrewMemberEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly usersService: UsersService,
    private readonly adminEvents: AdminEventBus,
  ) {}

  private emitChange(
    shipId: string,
    action: 'created' | 'updated' | 'deleted',
    entityId?: string,
  ): void {
    this.adminEvents.emit({ domain: 'crew', action, shipId, entityId });
  }

  /** Static rank catalog for the UI selectors. */
  catalog() {
    return { departments: CREW_DEPARTMENTS };
  }

  /**
   * Resolve a logged-in user's crew access on a ship, or null if they aren't
   * on the roster. Drives department-based gating of tasks/documents.
   */
  async accessFor(shipId: string, userId: string): Promise<CrewAccess | null> {
    const row = await this.crewRepository.findOne({
      where: { shipId, userId },
    });
    if (!row) return null;
    return {
      department: row.department,
      rank: row.rank,
      rankLevel: row.rankLevel,
      seesAll: seesAllDepartments(row),
    };
  }

  /** Full roster for a ship, grouped by department in seniority order. */
  async list(shipId: string) {
    const rows = await this.crewRepository.find({
      where: { shipId },
      order: { department: 'ASC', rankLevel: 'ASC', name: 'ASC' },
    });
    const usernames = await this.usernamesFor(rows);
    return rows.map((r) => this.toDto(r, usernames));
  }

  async create(shipId: string, input: UpsertCrewInput) {
    if (!input.name?.trim()) {
      throw new BadRequestException('Crew member name is required');
    }
    const entity = this.crewRepository.create({
      shipId,
      ...this.mapInput(input),
    });
    const saved = await this.crewRepository.save(entity);
    this.emitChange(shipId, 'created', saved.id);
    return this.toDto(saved, await this.usernamesFor([saved]));
  }

  async update(shipId: string, id: string, input: Partial<UpsertCrewInput>) {
    const row = await this.crewRepository.findOne({ where: { id, shipId } });
    if (!row) throw new NotFoundException('Crew member not found');
    Object.assign(row, this.mapInput(input, row));
    const saved = await this.crewRepository.save(row);
    this.emitChange(shipId, 'updated', id);
    return this.toDto(saved, await this.usernamesFor([saved]));
  }

  async remove(shipId: string, id: string): Promise<void> {
    const row = await this.crewRepository.findOne({ where: { id, shipId } });
    if (!row) throw new NotFoundException('Crew member not found');
    // Drop the linked login account too, so access is fully revoked.
    if (row.userId) await this.safeDeleteUser(row.userId);
    await this.crewRepository.delete(id);
    this.emitChange(shipId, 'deleted', id);
  }

  // ── login provisioning (bridge to the users/auth layer) ──

  /** Create a platform login (role=user, this ship) and link it. */
  async createLogin(shipId: string, id: string) {
    const row = await this.requireCrew(shipId, id);
    if (row.userId) {
      throw new BadRequestException('This crew member already has a login.');
    }
    const account = await this.usersService.create({
      role: UserRole.USER,
      shipId,
      name: row.name,
    });
    row.userId = account.id;
    await this.crewRepository.save(row);
    this.emitChange(shipId, 'updated', id);
    return { userId: account.userId, password: account.password };
  }

  /** Reset the linked login's password; returns the new credentials once. */
  async resetLogin(shipId: string, id: string) {
    const row = await this.requireCrew(shipId, id);
    if (!row.userId) {
      throw new BadRequestException('This crew member has no login yet.');
    }
    return this.usersService.resetPassword(row.userId);
  }

  /** Revoke access: delete the login account and unlink it. */
  async revokeLogin(shipId: string, id: string) {
    const row = await this.requireCrew(shipId, id);
    if (!row.userId) return { revoked: false };
    const userId = row.userId;
    row.userId = null;
    await this.crewRepository.save(row);
    await this.safeDeleteUser(userId);
    this.emitChange(shipId, 'updated', id);
    return { revoked: true };
  }

  // ── helpers ──

  private async requireCrew(
    shipId: string,
    id: string,
  ): Promise<CrewMemberEntity> {
    const row = await this.crewRepository.findOne({ where: { id, shipId } });
    if (!row) throw new NotFoundException('Crew member not found');
    return row;
  }

  /** Map crew.user_id → login username, for the rows that have a login. */
  private async usernamesFor(
    rows: CrewMemberEntity[],
  ): Promise<Map<string, string>> {
    const ids = rows.map((r) => r.userId).filter((v): v is string => !!v);
    if (ids.length === 0) return new Map();
    const users = await this.userRepository.find({
      where: { id: In(ids) },
      select: ['id', 'userId'],
    });
    return new Map(users.map((u) => [u.id, u.userId]));
  }

  private async safeDeleteUser(userId: string): Promise<void> {
    try {
      await this.usersService.delete(userId);
    } catch {
      // account already gone, or blocked by a FK — leave it, the crew link
      // is already cleared so access no longer resolves through the roster.
    }
  }

  private mapInput(
    input: Partial<UpsertCrewInput>,
    existing?: CrewMemberEntity,
  ): Partial<CrewMemberEntity> {
    const out: Partial<CrewMemberEntity> = {};
    if (input.name !== undefined) out.name = input.name.trim().slice(0, 120);
    if (input.department !== undefined) {
      out.department = DEPARTMENT_KEYS.includes(input.department)
        ? input.department
        : 'other';
    }
    if (input.rank !== undefined) out.rank = (input.rank ?? '').slice(0, 60);
    if (input.email !== undefined) out.email = input.email || null;
    if (input.phone !== undefined) out.phone = input.phone || null;
    if (input.userId !== undefined) out.userId = input.userId || null;
    if (input.active !== undefined) out.active = Boolean(input.active);
    if (input.joinedAt !== undefined) out.joinedAt = input.joinedAt || null;
    if (input.notes !== undefined) out.notes = input.notes || null;

    // rankLevel: explicit value wins; else derive from catalog when we know
    // the resulting department + rank.
    if (input.rankLevel != null) {
      out.rankLevel = input.rankLevel;
    } else if (input.department !== undefined || input.rank !== undefined) {
      const dept = out.department ?? existing?.department ?? 'other';
      const rank = out.rank ?? existing?.rank ?? '';
      out.rankLevel = defaultRankLevel(dept, rank);
    }
    return out;
  }

  private toDto(r: CrewMemberEntity, usernames: Map<string, string>) {
    return {
      id: r.id,
      name: r.name,
      department: r.department,
      rank: r.rank,
      rankLevel: r.rankLevel,
      email: r.email ?? undefined,
      phone: r.phone ?? undefined,
      active: r.active,
      joinedAt: r.joinedAt ?? undefined,
      notes: r.notes ?? undefined,
      // login linkage: hasLogin + the username (never the password)
      hasLogin: !!r.userId,
      loginUserId: r.userId ? (usernames.get(r.userId) ?? null) : null,
    };
  }
}
