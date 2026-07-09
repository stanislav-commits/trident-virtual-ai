import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrewMemberEntity } from '../crew/entities/crew-member.entity';
import { seesAllDepartments } from '../crew/crew-ranks';
import { AccessMatrixCellEntity } from './entities/access-matrix-cell.entity';
import {
  AccessPosition,
  DEFAULT_MATRIX,
  PermissionLevel,
  RESOURCE_CATEGORIES,
  ResourceCategory,
  resolvePosition,
} from './access-positions';

export type PermissionRow = Record<ResourceCategory, PermissionLevel>;
export type AccessMatrix = Record<AccessPosition, PermissionRow>;

@Injectable()
export class AccessControlService {
  constructor(
    @InjectRepository(AccessMatrixCellEntity)
    private readonly cellRepo: Repository<AccessMatrixCellEntity>,
    @InjectRepository(CrewMemberEntity)
    private readonly crewRepo: Repository<CrewMemberEntity>,
  ) {}

  /** The effective matrix for a ship = platform default with per-ship overrides applied. */
  async getMatrix(shipId: string): Promise<AccessMatrix> {
    const overrides = await this.cellRepo.find({ where: { shipId } });
    const matrix = structuredCloneMatrix(DEFAULT_MATRIX);
    for (const cell of overrides) {
      const pos = cell.position as AccessPosition;
      const cat = cell.resourceCategory as ResourceCategory;
      if (matrix[pos] && cat in matrix[pos]) {
        matrix[pos][cat] = cell.level as PermissionLevel;
      }
    }
    return matrix;
  }

  /**
   * Set one cell for a ship. If the value equals the platform default we delete
   * the override row (keeps the table to genuine deviations only).
   */
  async setCell(
    shipId: string,
    position: AccessPosition,
    category: ResourceCategory,
    level: PermissionLevel,
  ): Promise<void> {
    const isDefault = DEFAULT_MATRIX[position]?.[category] === level;
    const existing = await this.cellRepo.findOne({
      where: { shipId, position, resourceCategory: category },
    });

    if (isDefault) {
      if (existing) await this.cellRepo.remove(existing);
      return;
    }

    if (existing) {
      existing.level = level;
      await this.cellRepo.save(existing);
    } else {
      await this.cellRepo.save(
        this.cellRepo.create({
          shipId,
          position,
          resourceCategory: category,
          level,
        }),
      );
    }
  }

  /** Resolve a logged-in user's position + permission row on a given ship. */
  async resolveForUser(
    userId: string,
    shipId: string,
  ): Promise<{ position: AccessPosition; permissions: PermissionRow } | null> {
    const crew = await this.crewRepo.findOne({ where: { userId, shipId } });
    if (!crew) return null;
    const position = resolvePosition(crew);
    const matrix = await this.getMatrix(shipId);
    return { position, permissions: matrix[position] };
  }

  /**
   * The set of categories a user may at least READ on a ship, or `null` when
   * the user is NOT linked to a crew member (admins + unlinked accounts) —
   * `null` means "no RBAC restriction", i.e. legacy full access. Enforcement is
   * therefore opt-in per user via crew linkage and never breaks admins.
   */
  async allowedCategories(
    userId: string,
    shipId: string,
  ): Promise<Set<ResourceCategory> | null> {
    const resolved = await this.resolveForUser(userId, shipId);
    if (!resolved) return null;
    const allowed = new Set<ResourceCategory>();
    for (const cat of RESOURCE_CATEGORIES) {
      if (resolved.permissions[cat] !== PermissionLevel.NONE) allowed.add(cat);
    }
    return allowed;
  }

  /**
   * PMS/department content scope for a crew-linked user. Returns the RAW crew
   * department string to pass to PmsService.list (matches task.department), or
   * `null` department when the member sees all departments (Captain / bridge
   * head). Returns `null` overall when the user is NOT crew-linked (admins /
   * legacy) → no department scoping.
   */
  async crewScopeForUser(
    userId: string,
    shipId: string,
  ): Promise<{ department: string | null } | null> {
    const crew = await this.crewRepo.findOne({ where: { userId, shipId } });
    if (!crew) return null;
    if (
      seesAllDepartments({
        department: crew.department,
        rank: crew.rank,
        rankLevel: crew.rankLevel,
      })
    ) {
      return { department: null };
    }
    return { department: crew.department };
  }

  /** Convenience: can this user at least READ a category on this ship? */
  async canRead(
    userId: string,
    shipId: string,
    category: ResourceCategory,
  ): Promise<boolean> {
    const resolved = await this.resolveForUser(userId, shipId);
    if (!resolved) return false;
    return resolved.permissions[category] !== PermissionLevel.NONE;
  }
}

function structuredCloneMatrix(source: AccessMatrix): AccessMatrix {
  const out = {} as AccessMatrix;
  for (const pos of Object.keys(source) as AccessPosition[]) {
    out[pos] = { ...source[pos] } as PermissionRow;
    // ensure every category key exists
    for (const c of RESOURCE_CATEGORIES) {
      if (!(c in out[pos])) out[pos][c] = PermissionLevel.NONE;
    }
  }
  return out;
}
