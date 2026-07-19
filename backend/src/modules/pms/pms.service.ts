import { formatError } from '../../common/utils/error.utils';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AssetEntity } from '../assets/entities/asset.entity';
import { UserEntity } from '../users/entities/user.entity';
import { PmsTaskEntity } from './entities/pms-task.entity';
import { AssetHoursService } from './asset-hours.service';
import { addInterval } from './date-interval.util';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import {
  POSITION_LABELS,
  isAccessPosition,
} from '../access-control/access-positions';

export type PmsStatus = 'overdue' | 'due-soon' | 'ok';

const HOURS_SOON_WINDOW = 20; // hrs before due that still count as due-soon
const DAYS_SOON_WINDOW = 10;

// The Tasks (general) board's category vocabulary — must mirror the frontend
// GENERAL_CATEGORIES. A compliance category already in this set is kept;
// anything else (maintenance-only, e.g. 'Service') folds to 'Certificate'.
const GENERAL_BOARD_CATEGORIES = new Set([
  'Certificate',
  'Survey',
  'Drill',
  'Assignment',
  'Inspection',
  'Training',
  'Other',
]);

/**
 * Metric alerts must never surface as maintenance tasks. Auto-spawning is
 * disabled (ALERT_AUTO_TASK_SEVERITY defaults to 'off'), but legacy `alert`
 * rows created before that change can linger in the DB — filter them out of
 * every task list so alarms stay in the alerts panel, not the PMS list.
 */
const isNotAlertTask = (t: PmsTaskEntity): boolean => t.source !== 'alert';

export interface UpsertPmsTaskInput {
  task: string;
  category?: string;
  planning?: string;
  description?: string | null;
  sfiGroup?: string | null;
  assigneeUserId?: string | null;
  responsibleRole?: string | null;
  department?: string | null;
  priority?: string;
  dueDate?: string | null;
  startDate?: string | null;
  repeatDate?: boolean;
  intervalValue?: number | null;
  intervalUnit?: string;
  intervalHours?: number | null;
  startHours?: number | null;
  lastDoneHours?: number | null;
  dueHours?: number | null;
  lastDoneAt?: string | null;
  assetIds?: string[];
  source?: string;
  /** 'maintenance' (asset upkeep) | 'general' (certificates/drills/assignments). */
  board?: string;
  completedAt?: string | null;
  completedByName?: string | null;
  completedByPosition?: string | null;
}

@Injectable()
export class PmsService {
  private readonly logger = new Logger(PmsService.name);

  constructor(
    @InjectRepository(PmsTaskEntity)
    private readonly taskRepository: Repository<PmsTaskEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly assetHoursService: AssetHoursService,
  ) {}

  /**
   * All tasks for a ship, with derived status. When `viewerDepartment` is
   * given (a logged-in crew member who doesn't see all), only that
   * department's tasks + general (null-department) tasks are returned.
   */
  async list(shipId: string, viewerDepartment?: string | null) {
    const tasks = await this.taskRepository.find({
      where: { shipId },
      relations: { assets: true },
      order: { createdAt: 'DESC' },
    });
    const visible = this.filterByDepartment(
      tasks.filter(isNotAlertTask),
      viewerDepartment,
    );
    const names = await this.assigneeNames(visible);
    const hours = await this.hoursForTasks(shipId, visible);
    return visible.map((t) => this.toDto(t, names, hours));
  }

  /** Keep tasks of the viewer's department + general tasks (null dept). */
  private filterByDepartment(
    tasks: PmsTaskEntity[],
    viewerDepartment?: string | null,
  ): PmsTaskEntity[] {
    if (!viewerDepartment) return tasks; // admin / sees-all / no gating
    return tasks.filter(
      (t) => !t.department || t.department === viewerDepartment,
    );
  }

  /** Tasks linked to one asset — feeds the asset drawer PMS tab. */
  async listForAsset(
    shipId: string,
    assetId: string,
    viewerDepartment?: string | null,
  ) {
    const rows = await this.taskRepository
      .createQueryBuilder('t')
      .innerJoin('pms_task_assets', 'l', 'l.task_id = t.id')
      .leftJoinAndSelect('t.assets', 'a')
      .where('t.ship_id = :shipId', { shipId })
      .andWhere('l.asset_id = :assetId', { assetId })
      .orderBy('t.created_at', 'DESC')
      .getMany();
    const visible = this.filterByDepartment(
      rows.filter(isNotAlertTask),
      viewerDepartment,
    );
    const names = await this.assigneeNames(visible);
    const hours = await this.hoursForTasks(shipId, visible);
    return visible.map((t) => this.toDto(t, names, hours));
  }

  async create(shipId: string, input: UpsertPmsTaskInput) {
    if (!input.task?.trim()) {
      throw new BadRequestException('Task title is required');
    }
    const entity = this.taskRepository.create({
      shipId,
      ...this.mapInput(input),
      assets: await this.resolveAssets(shipId, input.assetIds),
    });
    const saved = await this.taskRepository.save(entity);
    return this.reload(saved.id);
  }

  /** Bulk-insert tasks (used by the import flow). Returns the created count. */
  async createMany(shipId: string, inputs: UpsertPmsTaskInput[]): Promise<number> {
    let created = 0;
    let skipped = 0;
    for (const input of inputs) {
      if (!input.task?.trim()) continue;
      // One bad row (over-length field, bad asset id, …) must not abort the
      // whole import — skip it and keep going, so the operator gets everything
      // that IS valid instead of a 500 and a half-written batch.
      try {
        const entity = this.taskRepository.create({
          shipId,
          ...this.mapInput(input),
          assets: await this.resolveAssets(shipId, input.assetIds),
        });
        await this.taskRepository.save(entity);
        created++;
      } catch (error) {
        skipped++;
        this.logger.warn(
          `Skipped import task "${input.task}": ${
            formatError(error)
          }`,
        );
      }
    }
    if (skipped) {
      this.logger.warn(`Import: ${created} created, ${skipped} skipped.`);
    }
    return created;
  }

  async update(shipId: string, id: string, input: Partial<UpsertPmsTaskInput>) {
    const task = await this.taskRepository.findOne({
      where: { id, shipId },
      relations: { assets: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    Object.assign(task, this.mapInput(input, task));
    if (input.assetIds !== undefined) {
      task.assets = await this.resolveAssets(shipId, input.assetIds);
    }
    await this.taskRepository.save(task);
    return this.reload(id);
  }

  async remove(shipId: string, id: string): Promise<void> {
    const task = await this.taskRepository.findOne({ where: { id, shipId } });
    if (!task) throw new NotFoundException('Task not found');
    await this.taskRepository.delete(id);
  }

  /**
   * Mark a task done. Recurring tasks roll forward (stay active with a new
   * due date / hours mark); one-offs get completedAt set and move to
   * history.
   */
  async complete(
    shipId: string,
    id: string,
    input?: {
      doneAtHours?: number | null;
      doneOn?: string | null;
      notes?: string | null;
    },
    user?: AuthenticatedUser,
  ) {
    const task = await this.taskRepository.findOne({
      where: { id, shipId },
      relations: { assets: true },
    });
    if (!task) throw new NotFoundException('Task not found');

    // Snapshot WHO completed it — the actual person (name) + their position at
    // this moment. The responsible field is a position; history shows the person.
    if (user) {
      const account = await this.userRepository.findOne({
        where: { id: user.id },
      });
      task.completedByName = user.name ?? account?.name ?? user.userId;
      const pos = account?.accessPosition;
      task.completedByPosition =
        pos && isAccessPosition(pos) ? POSITION_LABELS[pos] : null;
    }

    const doneOn = input?.doneOn ?? new Date().toISOString().slice(0, 10);
    task.lastDoneAt = doneOn;
    // Always reflect THIS completion's note — a recurring task rolls forward
    // keeping completionNotes, so a later completion with no note must clear
    // the previous cycle's note rather than keep mislabelling it as latest.
    task.completionNotes = input?.notes?.trim() || null;
    if (input?.doneAtHours != null) {
      task.lastDoneHours = String(input.doneAtHours);
      if (task.intervalHours != null) {
        task.dueHours = String(input.doneAtHours + task.intervalHours);
      }
    }

    const recurring =
      task.planning === 'planned' &&
      (task.repeatDate || task.intervalHours != null);

    if (recurring) {
      // Roll the calendar due date forward by the interval from the done
      // date, so the next occurrence stays active.
      if (task.source === 'hours_reminder') {
        // Hours-reading reminders are always due on the 1st of a month,
        // regardless of which day the crew logs the reading.
        const d = new Date(`${doneOn}T00:00:00Z`);
        task.dueDate = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
        )
          .toISOString()
          .slice(0, 10);
      } else if (
        task.repeatDate &&
        task.intervalValue != null &&
        task.intervalValue > 0
      ) {
        task.dueDate = addInterval(
          doneOn,
          task.intervalValue,
          task.intervalUnit,
        );
      }
      task.completedAt = null;
    } else {
      task.completedAt = new Date();
    }
    await this.taskRepository.save(task);
    return this.reload(id);
  }

  // ── helpers ──

  private async reload(id: string) {
    const t = await this.taskRepository.findOne({
      where: { id },
      relations: { assets: true },
    });
    const names = await this.assigneeNames(t ? [t] : []);
    const hours = t ? await this.hoursForTasks(t.shipId, [t]) : new Map();
    return t ? this.toDto(t, names, hours) : null;
  }

  private mapInput(
    input: Partial<UpsertPmsTaskInput>,
    existing?: PmsTaskEntity,
  ): Partial<PmsTaskEntity> {
    const out: Partial<PmsTaskEntity> = {};
    const set = <K extends keyof UpsertPmsTaskInput>(
      key: K,
      apply: (v: NonNullable<UpsertPmsTaskInput[K]> | null) => void,
    ) => {
      if (input[key] !== undefined) apply((input[key] ?? null) as never);
    };
    // Cap string fields to their column length — the AI import can produce
    // values longer than the schema allows (e.g. a group name in sfiGroup).
    const cap = (v: unknown, n: number): string | null => {
      const s = v == null ? null : String(v);
      return s == null ? null : s.slice(0, n);
    };
    set('task', (v) => (out.task = (v as string)?.trim() || existing!.task));
    set('category', (v) => (out.category = cap(v, 24) ?? 'Service'));
    set('planning', (v) => (out.planning = cap(v, 12) ?? 'planned'));
    set('description', (v) => (out.description = v as string | null));
    set('sfiGroup', (v) => (out.sfiGroup = cap(v, 64)));
    set('assigneeUserId', (v) => (out.assigneeUserId = v as string | null));
    set('responsibleRole', (v) => (out.responsibleRole = cap(v, 80)));
    set('department', (v) => (out.department = cap(v, 16)));
    set('priority', (v) => (out.priority = cap(v, 12) ?? 'medium'));
    set('dueDate', (v) => (out.dueDate = v as string | null));
    set('startDate', (v) => (out.startDate = v as string | null));
    set('repeatDate', (v) => (out.repeatDate = Boolean(v)));
    set('intervalValue', (v) => (out.intervalValue = v as number | null));
    set('intervalUnit', (v) => (out.intervalUnit = cap(v, 8) ?? 'months'));
    set('intervalHours', (v) => (out.intervalHours = v as number | null));
    set(
      'startHours',
      (v) => (out.startHours = v != null ? String(v) : null),
    );
    set(
      'lastDoneHours',
      (v) => (out.lastDoneHours = v != null ? String(v) : null),
    );
    set('dueHours', (v) => (out.dueHours = v != null ? String(v) : null));
    set('lastDoneAt', (v) => (out.lastDoneAt = v as string | null));
    set('source', (v) => (out.source = (v as string) ?? 'manual'));
    // Only accept the two known boards; null/junk leaves the field untouched
    // (a PATCH {board: null} must not silently move a task between boards).
    set('board', (v) => {
      if (v === 'general' || v === 'maintenance') out.board = v;
    });
    set('completedByName', (v) => (out.completedByName = cap(v, 120)));
    set('completedByPosition', (v) => (out.completedByPosition = cap(v, 64)));
    if (input.completedAt !== undefined) {
      out.completedAt = input.completedAt ? new Date(input.completedAt) : null;
    }
    return out;
  }

  /**
   * Keep a PMS task in sync with a compliance document (doc-control D4: the
   * document wins, the PMS follows). Upserts a task keyed by sourceDocId;
   * a null dueDate removes it. Linked to the same assets as the cert.
   */
  async syncFromCompliance(
    shipId: string,
    input: {
      docId: string;
      title: string;
      dueDate: string | null;
      category: string;
      assetIds: string[];
    },
  ): Promise<void> {
    const existing = await this.taskRepository.findOne({
      where: { shipId, sourceDocId: input.docId },
      relations: { assets: true },
    });
    if (!input.dueDate) {
      if (existing) await this.taskRepository.delete(existing.id);
      return;
    }
    const assets = await this.resolveAssets(shipId, input.assetIds);
    // Map the compliance spec's category onto the general board's vocabulary:
    // keep any category that already IS a general one (Survey, Inspection…),
    // only fold the maintenance-only ones (e.g. renewal 'Service') into
    // 'Certificate', so the Tasks board's category filter can find them.
    const category = GENERAL_BOARD_CATEGORIES.has(input.category)
      ? input.category
      : 'Certificate';
    if (existing) {
      existing.task = input.title.slice(0, 200);
      existing.category = category;
      existing.dueDate = input.dueDate;
      existing.assets = assets;
      // Certificate deadlines are people-work, not equipment upkeep.
      existing.board = 'general';
      // A moved deadline re-activates the task (the cert was renewed).
      existing.completedAt = null;
      await this.taskRepository.save(existing);
    } else {
      await this.taskRepository.save(
        this.taskRepository.create({
          shipId,
          task: input.title.slice(0, 200),
          category,
          planning: 'planned',
          priority: 'medium',
          dueDate: input.dueDate,
          repeatDate: false,
          source: 'compliance',
          board: 'general',
          sourceDocId: input.docId,
          assets,
        }),
      );
    }
  }

  /** Drop the PMS task owned by a compliance document (on record delete). */
  async removeForCompliance(docId: string): Promise<void> {
    await this.taskRepository.delete({ sourceDocId: docId });
  }

  private async resolveAssets(
    shipId: string,
    assetIds?: string[],
  ): Promise<AssetEntity[]> {
    if (!assetIds?.length) return [];
    return this.assetRepository.find({
      where: { id: In(assetIds), shipId },
    });
  }

  private async assigneeNames(
    tasks: PmsTaskEntity[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(tasks.map((t) => t.assigneeUserId).filter(Boolean)),
    ] as string[];
    if (!ids.length) return new Map();
    const users = await this.userRepository.find({ where: { id: In(ids) } });
    return new Map(users.map((u) => [u.id, u.name ?? u.userId]));
  }

  /**
   * Resolve currentHours per task = the hours of the first linked asset
   * that has an hours source configured. Cached per asset within the call.
   */
  private async hoursForTasks(
    shipId: string,
    tasks: PmsTaskEntity[],
  ): Promise<Map<string, number | null>> {
    const assetIds = [
      ...new Set(tasks.flatMap((t) => (t.assets ?? []).map((a) => a.id))),
    ];
    const byAsset = new Map<string, number | null>();
    await Promise.all(
      assetIds.map(async (id) => {
        byAsset.set(id, await this.assetHoursService.currentHours(shipId, id));
      }),
    );
    const byTask = new Map<string, number | null>();
    for (const t of tasks) {
      let h: number | null = null;
      for (const a of t.assets ?? []) {
        const v = byAsset.get(a.id);
        if (v != null) {
          h = v;
          break;
        }
      }
      byTask.set(t.id, h);
    }
    return byTask;
  }

  private toDto(
    task: PmsTaskEntity,
    names: Map<string, string>,
    hoursByTask: Map<string, number | null>,
  ) {
    const currentHours: number | null = hoursByTask.get(task.id) ?? null;
    const lastDoneHours =
      task.lastDoneHours != null ? Number(task.lastDoneHours) : null;
    const startHours =
      task.startHours != null ? Number(task.startHours) : null;
    // Hours baseline = last completion, else the start-hours anchor. Without
    // either, an hours interval has no reference point and is not evaluated.
    const hoursBaseline = lastDoneHours ?? startHours;
    const dueHours =
      task.dueHours != null
        ? Number(task.dueHours)
        : task.intervalHours != null && hoursBaseline != null
          ? hoursBaseline + task.intervalHours
          : null;
    // Calendar reference before the first completion = explicit due date, else
    // the start-date anchor (schedule may begin in the future).
    const effectiveDueDate = task.dueDate ?? task.startDate;
    const { status, due } = this.deriveTask({
      dueDate: effectiveDueDate,
      currentHours,
      dueHours,
    });
    return {
      id: task.id,
      task: task.task,
      category: task.category,
      planning: task.planning,
      source: task.source ?? undefined,
      board: task.board ?? 'maintenance',
      description: task.description ?? undefined,
      sfiGroup: task.sfiGroup ?? undefined,
      sfiGroupName: undefined,
      assigneeId: task.assigneeUserId ?? undefined,
      assigneeName: task.assigneeUserId
        ? (names.get(task.assigneeUserId) ?? undefined)
        : undefined,
      responsibleRole: task.responsibleRole ?? undefined,
      department: task.department ?? undefined,
      priority: task.priority,
      dueDate: task.dueDate,
      startDate: task.startDate,
      repeatDate: task.repeatDate,
      intervalValue: task.intervalValue,
      intervalUnit: task.intervalUnit,
      intervalHours: task.intervalHours,
      startHours,
      currentHours,
      dueHours,
      lastDoneHours,
      lastDone: task.lastDoneAt,
      status,
      due,
      completedAt: task.completedAt ? task.completedAt.toISOString() : null,
      completedByName: task.completedByName ?? null,
      completedByPosition: task.completedByPosition ?? null,
      completionNotes: task.completionNotes ?? null,
      assets: (task.assets ?? []).map((a) => ({
        id: a.id,
        name: a.displayName,
      })),
    };
  }

  // status logic mirrors the prototype (PmsSection deriveTask/deriveDue/deriveHours)
  private deriveTask(t: {
    dueDate: string | null;
    currentHours: number | null;
    dueHours: number | null;
  }): { status: PmsStatus; due: string } {
    const parts: { status: PmsStatus; due: string; rank: number }[] = [];
    if (t.dueDate) {
      const days = this.daysUntil(t.dueDate);
      parts.push({ ...this.deriveDue(days), rank: days });
    }
    if (t.currentHours != null && t.dueHours != null) {
      const left = Math.round(t.dueHours - t.currentHours);
      parts.push({ ...this.deriveHours(left), rank: left });
    }
    if (!parts.length) return { status: 'ok', due: '—' };
    const order: Record<PmsStatus, number> = {
      overdue: 0,
      'due-soon': 1,
      ok: 2,
    };
    parts.sort((a, b) => order[a.status] - order[b.status] || a.rank - b.rank);
    return { status: parts[0].status, due: parts[0].due };
  }

  private deriveDue(days: number): { status: PmsStatus; due: string } {
    const status: PmsStatus =
      days < 0 ? 'overdue' : days <= DAYS_SOON_WINDOW ? 'due-soon' : 'ok';
    const due =
      days < 0
        ? `${-days} day${days === -1 ? '' : 's'} ago`
        : days === 0
          ? 'today'
          : `in ${days} day${days === 1 ? '' : 's'}`;
    return { status, due };
  }

  private deriveHours(left: number): { status: PmsStatus; due: string } {
    const status: PmsStatus =
      left < 0 ? 'overdue' : left <= HOURS_SOON_WINDOW ? 'due-soon' : 'ok';
    const due =
      left < 0 ? `${-left} hrs over` : left === 0 ? 'due now' : `${left} hrs left`;
    return { status, due };
  }

  private daysUntil(dateStr: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(`${dateStr}T00:00:00`);
    return Math.round((d.getTime() - today.getTime()) / 86_400_000);
  }

}
