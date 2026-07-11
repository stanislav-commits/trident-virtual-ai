import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** One Grafana alert rule, as much as the admin UI needs. */
export interface GrafanaRuleInfo {
  uid: string;
  /** Rule title = the `alertname` label the webhook delivers. */
  ruleName: string;
  folder: string;
  group: string;
  /** Raw rule labels (Severity, department, …). */
  labels: Record<string, string>;
  paused: boolean;
}

/**
 * Read-only view of the Grafana alert-rule list (provisioning API) so the
 * admin can see and bind ALL configured rules — not just those that already
 * fired into the webhook. Needs a service-account token with alerting read
 * (GRAFANA_ALERTS_SA_TOKEN); without one the rules panel degrades to the
 * observed-rules-only view. Responses are cached briefly — the rule set
 * changes rarely and the admin panel polls.
 */
@Injectable()
export class GrafanaRulesService {
  private readonly logger = new Logger(GrafanaRulesService.name);
  private cache: { at: number; rules: GrafanaRuleInfo[] } | null = null;
  private static readonly CACHE_MS = 60_000;

  constructor(private readonly configService: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.token);
  }

  private get baseUrl(): string {
    return (
      this.configService.get<string>('integrations.grafanaAlerts.apiUrl') ?? ''
    ).replace(/\/+$/, '');
  }

  private get token(): string {
    return (
      this.configService.get<string>('integrations.grafanaAlerts.saToken') ?? ''
    );
  }

  /** null = not configured or Grafana unreachable (caller falls back). */
  async listRules(): Promise<GrafanaRuleInfo[] | null> {
    if (!this.isConfigured || !this.baseUrl) return null;
    if (this.cache && Date.now() - this.cache.at < GrafanaRulesService.CACHE_MS) {
      return this.cache.rules;
    }
    try {
      const [rules, folders] = await Promise.all([
        this.getJson<GrafanaProvisionedRule[]>('/api/v1/provisioning/alert-rules'),
        this.getJson<Array<{ uid: string; title: string }>>('/api/folders'),
      ]);
      const folderTitle = new Map(folders.map((f) => [f.uid, f.title]));
      const mapped = rules.map<GrafanaRuleInfo>((r) => ({
        uid: r.uid,
        ruleName: r.title,
        folder: folderTitle.get(r.folderUID) ?? r.folderUID,
        group: r.ruleGroup,
        labels: r.labels ?? {},
        paused: Boolean(r.isPaused),
      }));
      this.cache = { at: Date.now(), rules: mapped };
      return mapped;
    } catch (error) {
      this.logger.warn(
        `Grafana rule list unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`${path} -> HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

interface GrafanaProvisionedRule {
  uid: string;
  title: string;
  folderUID: string;
  ruleGroup: string;
  labels?: Record<string, string>;
  isPaused?: boolean;
}
