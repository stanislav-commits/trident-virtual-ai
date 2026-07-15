import { Injectable, Logger } from '@nestjs/common';
import { PmsService } from '../../pms/pms.service';
import { AccessControlService } from '../../access-control/access-control.service';
import { ResourceCategory } from '../../access-control/access-positions';
import { ChatLlmService } from '../chat-llm.service';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

type PmsTask = Awaited<ReturnType<PmsService['list']>>[number];

/**
 * Answers planned-maintenance / PMS questions ("what's overdue", "when is the
 * next service for the watermaker", "show upcoming tasks", maintenance history)
 * from the STRUCTURED Tasks register (PmsService), not from documents. This is
 * the chat bridge that replaces the legacy `historical_procedure` document
 * retrieval: maintenance now lives in Tasks, so the chat reads it there.
 *
 * Route-gated: the orchestrator dispatches here when
 * `ask.semanticRoute.route === ChatSemanticRoute.PMS`.
 */
@Injectable()
export class ChatPmsResponderService {
  private readonly logger = new Logger(ChatPmsResponderService.name);

  // Keep the composed prompt bounded; a vessel can carry hundreds of tasks.
  // Equipment-relevant + most-urgent tasks are surfaced first, so the cap
  // rarely hides anything the user asked about.
  private readonly maxTasksInContext = 80;

  constructor(
    private readonly pmsService: PmsService,
    private readonly chatLlmService: ChatLlmService,
    private readonly accessControlService: AccessControlService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const shipId = input.session.shipId;
    const question = input.ask.question;
    const userId = input.session.userId;

    // RBAC: gate PMS access by matrix category; scope tasks to the crew-linked
    // user's department (null = sees-all / admins / legacy).
    let viewerDepartment: string | null = null;
    if (userId && shipId) {
      const allowed = await this.accessControlService.allowedCategories(
        userId,
        shipId,
      );
      if (allowed && !allowed.has(ResourceCategory.PMS_TASKS)) {
        return this.buildNoAccessResponse(input);
      }
      const scope = await this.accessControlService.crewScopeForUser(
        userId,
        shipId,
      );
      viewerDepartment = scope?.department ?? null;
    }

    const tasks = await this.loadTasks(shipId, viewerDepartment);
    const ranked = this.rankForQuestion(tasks, question);
    const included = ranked.slice(0, this.maxTasksInContext);

    const summary = await this.composeAnswer({
      question,
      responseLanguage: input.plan.responseLanguage,
      tasks: included,
      totalCount: tasks.length,
    });

    const overdue = tasks.filter((task) => task.status === 'overdue').length;
    const dueSoon = tasks.filter((task) => task.status === 'due-soon').length;

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.PMS,
      question,
      capabilityEnabled: true,
      capabilityLabel: 'maintenance tasks (PMS)',
      summary,
      data: {
        taskCount: tasks.length,
        includedCount: included.length,
        overdue,
        dueSoon,
      },
      contextReferences: this.buildContextReferences(included),
    };
  }

  private buildNoAccessResponse(
    input: ChatTurnResponderInput,
  ): ChatTurnResponderOutput {
    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.PMS,
      question: input.ask.question,
      capabilityEnabled: true,
      capabilityLabel: 'maintenance tasks (PMS)',
      summary:
        'You do not have access to the maintenance (PMS) register on this vessel. Please contact the Master or a department head.',
      data: { taskCount: 0, includedCount: 0, overdue: 0, dueSoon: 0 },
      contextReferences: [],
    };
  }

  private async loadTasks(
    shipId: string | null,
    viewerDepartment: string | null,
  ): Promise<PmsTask[]> {
    if (!shipId) {
      return [];
    }

    try {
      // null viewerDepartment = sees-all; else scoped to the department.
      return await this.pmsService.list(shipId, viewerDepartment);
    } catch (error) {
      this.logger.error(
        `Failed to load PMS tasks for ship ${shipId}: ${String(error)}`,
      );
      return [];
    }
  }

  /**
   * Surface equipment-relevant tasks first, then by urgency, so a
   * "next service for the watermaker" question keeps its tasks within the cap
   * even on a vessel with a large register.
   */
  private rankForQuestion(tasks: PmsTask[], question: string): PmsTask[] {
    const normalizedQuestion = question.toLowerCase();

    const relevance = (task: PmsTask): number => {
      const haystack = [task.task, ...task.assets.map((asset) => asset.name)]
        .filter(Boolean)
        .map((value) => value.toLowerCase());

      return haystack.some(
        (value) =>
          value.length >= 4 &&
          (normalizedQuestion.includes(value) ||
            this.shareSignificantToken(normalizedQuestion, value)),
      )
        ? 0
        : 1;
    };

    const statusRank: Record<string, number> = {
      overdue: 0,
      'due-soon': 1,
      ok: 2,
    };

    return [...tasks].sort((left, right) => {
      const relevanceDelta = relevance(left) - relevance(right);
      if (relevanceDelta !== 0) return relevanceDelta;

      const statusDelta =
        (statusRank[left.status] ?? 3) - (statusRank[right.status] ?? 3);
      if (statusDelta !== 0) return statusDelta;

      return this.compareDueDate(left.dueDate, right.dueDate);
    });
  }

  private shareSignificantToken(question: string, value: string): boolean {
    const tokens = value.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
    return tokens.some((token) => question.includes(token));
  }

  private compareDueDate(
    left: string | null,
    right: string | null,
  ): number {
    const leftTime = left ? Date.parse(left) : Number.POSITIVE_INFINITY;
    const rightTime = right ? Date.parse(right) : Number.POSITIVE_INFINITY;
    const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
    const safeRight = Number.isFinite(rightTime)
      ? rightTime
      : Number.POSITIVE_INFINITY;
    return safeLeft - safeRight;
  }

  private async composeAnswer(input: {
    question: string;
    responseLanguage: string | null;
    tasks: PmsTask[];
    totalCount: number;
  }): Promise<string> {
    const register = this.formatRegister(input.tasks, input.totalCount);

    const systemPrompt = [
      'You are the planned-maintenance (PMS) assistant for the Trident yacht platform.',
      "Answer the user's maintenance question using ONLY the PMS task register below.",
      'These tasks come from the vessel\'s structured Tasks module — they are the source of truth for maintenance, not manuals.',
      'Status meaning: OVERDUE = past its due point; DUE-SOON = within the warning window; OK = not yet due.',
      '"due" is a human-readable description of when the task is next due (by date and/or running hours).',
      'Hours fields are running-hours based: "hours current X / due Y" means the task is due at Y equipment hours and the asset is currently at X.',
      'If no task in the register is relevant to the question, say so plainly — do NOT invent tasks, dates, equipment, or hours.',
      'Be concise and practical. Group by equipment or urgency when it helps. Lead with overdue/due-soon items when the user asks what needs attention.',
      input.responseLanguage
        ? `Write the answer in this language: ${input.responseLanguage}.`
        : 'Write the answer in the same language as the question.',
    ].join('\n');

    const userPrompt = [
      `Question: ${input.question}`,
      '',
      'PMS task register:',
      register,
    ].join('\n');

    const reply = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 700,
      useMainModel: true,
    });

    return (
      reply?.trim() ||
      'I could not compose a maintenance answer right now. Please try again.'
    );
  }

  private formatRegister(tasks: PmsTask[], totalCount: number): string {
    if (!tasks.length) {
      return 'No maintenance tasks are registered for this vessel.';
    }

    const lines = tasks.map((task, index) => {
      const parts: string[] = [
        `[${index + 1}] "${task.task}"`,
        `status: ${task.status.toUpperCase()}`,
      ];

      if (task.due) parts.push(`due: ${task.due}`);

      const equipment = task.assets.map((asset) => asset.name).filter(Boolean);
      if (equipment.length) parts.push(`equipment: ${equipment.join(', ')}`);

      if (task.category) parts.push(`category: ${task.category}`);
      if (task.priority) parts.push(`priority: ${task.priority}`);
      if (task.department) parts.push(`department: ${task.department}`);

      if (task.currentHours != null || task.dueHours != null) {
        parts.push(
          `hours current ${task.currentHours ?? '—'} / due ${task.dueHours ?? '—'}`,
        );
      }

      if (task.lastDone) parts.push(`last done: ${task.lastDone}`);
      if (task.completedAt) parts.push(`completed: ${task.completedAt}`);

      return parts.join(' | ');
    });

    if (totalCount > tasks.length) {
      lines.push(
        `(showing ${tasks.length} of ${totalCount} tasks — ask about a specific piece of equipment to narrow down)`,
      );
    }

    return lines.join('\n');
  }

  private buildContextReferences(tasks: PmsTask[]): unknown[] {
    return tasks.map((task, index) => ({
      id: `pms-task-${task.id}`,
      sourceType: 'pms_task',
      rank: index + 1,
      sourceTitle: task.task,
      taskId: task.id,
      status: task.status,
      snippet: [task.status.toUpperCase(), task.due, task.assets.map((a) => a.name).join(', ')]
        .filter(Boolean)
        .join(' · '),
    }));
  }
}
