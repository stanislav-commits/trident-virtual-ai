import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { ShipMetricCatalogEntity } from '../entities/ship-metric-catalog.entity';

export type IssueSeverity = 'high' | 'medium' | 'low';

export type IssueCode =
  | 'impossible_temperature'
  | 'impossible_percent'
  | 'impossible_pressure_bar'
  | 'impossible_rpm'
  | 'impossible_voltage'
  | 'sensor_overflow_value'
  | 'counter_not_monotonic'
  | 'rate_is_monotonic'
  | 'state_with_high_values'
  | 'low_unit_confidence'
  | 'low_bound_confidence'
  | 'extreme_p95_vs_p50'
  | 'kind_missing'
  | 'unit_missing'
  | 'all_zero_typical';

export interface QualityIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
}

export interface MetricIssueReport {
  metricId: string;
  measurement: string;
  field: string;
  aiKind: string | null;
  aiUnit: string | null;
  aiUnitConfidence: number | null;
  aiBoundConfidence: number | null;
  boundAssetIdInternal: string | null;
  typicalP5: number | null;
  typicalP50: number | null;
  typicalP95: number | null;
  nonZeroSharePct: number | null;
  isMonotonic: boolean | null;
  issues: QualityIssue[];
  maxSeverity: IssueSeverity;
}

export interface DetectIssuesOptions {
  severity?: IssueSeverity; // minimum severity to include
  limit?: number;
  offset?: number;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

@Injectable()
export class MetricQualityDetectorService {
  constructor(
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly metricRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
  ) {}

  async detectForShip(
    shipId: string,
    opts: DetectIssuesOptions = {},
  ): Promise<{
    total: number;
    scanned: number;
    flagged: number;
    items: MetricIssueReport[];
  }> {
    const metrics = await this.metricRepository.find({
      where: { shipId, aiGeneratedAt: Not(IsNull()) },
      order: { id: 'ASC' },
    });

    const boundIds = Array.from(
      new Set(
        metrics
          .map((m) => m.boundAssetId)
          .filter((v): v is string => v !== null),
      ),
    );
    const assetMap = new Map<string, string>();
    if (boundIds.length > 0) {
      const assets = await this.assetRepository.findByIds(boundIds);
      for (const a of assets) {
        assetMap.set(a.id, a.assetIdInternal);
      }
    }

    const reports: MetricIssueReport[] = [];
    for (const m of metrics) {
      const issues = this.detectOne(m);
      if (issues.length === 0) continue;
      const maxSeverity = this.maxSeverity(issues);
      reports.push({
        metricId: m.id,
        measurement: this.measurementOfKey(m.key, m.field),
        field: m.field,
        aiKind: m.aiKind,
        aiUnit: m.aiUnit,
        aiUnitConfidence: m.aiUnitConfidence,
        aiBoundConfidence: m.aiBoundConfidence,
        boundAssetIdInternal: m.boundAssetId
          ? assetMap.get(m.boundAssetId) ?? null
          : null,
        typicalP5: m.aiTypicalP5,
        typicalP50: m.aiTypicalP50,
        typicalP95: m.aiTypicalP95,
        nonZeroSharePct: m.aiNonZeroSharePct,
        isMonotonic: m.aiIsMonotonic,
        issues,
        maxSeverity,
      });
    }

    const minRank = opts.severity ? SEVERITY_RANK[opts.severity] : 1;
    const filtered = reports.filter(
      (r) => SEVERITY_RANK[r.maxSeverity] >= minRank,
    );
    filtered.sort(
      (a, b) => SEVERITY_RANK[b.maxSeverity] - SEVERITY_RANK[a.maxSeverity],
    );

    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return {
      total: reports.length,
      scanned: metrics.length,
      flagged: filtered.length,
      items: filtered.slice(offset, offset + limit),
    };
  }

  private detectOne(m: ShipMetricCatalogEntity): QualityIssue[] {
    const issues: QualityIssue[] = [];
    const p5 = m.aiTypicalP5;
    const p50 = m.aiTypicalP50;
    const p95 = m.aiTypicalP95;
    const unit = (m.aiUnit ?? '').trim();
    const unitLower = unit.toLowerCase();
    const kind = m.aiKind;
    const mono = m.aiIsMonotonic;
    const nzShare = m.aiNonZeroSharePct;

    if (!m.aiKind) {
      issues.push({
        code: 'kind_missing',
        severity: 'medium',
        message: 'ai_kind is null despite ai_generated_at being set',
      });
    }
    if (!m.aiUnit) {
      issues.push({
        code: 'unit_missing',
        severity: 'low',
        message: 'ai_unit is null despite ai_generated_at being set',
      });
    }

    if (this.isTemperatureUnit(unitLower)) {
      const isExhaust = /exhaust|scr/i.test(m.field);
      const upper = isExhaust ? 800 : 250;
      if ((p95 !== null && p95 > upper) || (p5 !== null && p5 < -100)) {
        issues.push({
          code: 'impossible_temperature',
          severity: 'high',
          message: `temperature unit ${unit} but p5=${p5} p95=${p95} outside [-100,${upper}]°C`,
        });
      }
    }
    if (unit === '%' || unitLower === 'percent') {
      if ((p95 !== null && p95 > 110) || (p5 !== null && p5 < -5)) {
        issues.push({
          code: 'impossible_percent',
          severity: 'high',
          message: `percent unit but p5=${p5} p95=${p95} outside [-5,110]`,
        });
      }
    }
    if (unitLower === 'bar' && p95 !== null && p95 > 500) {
      issues.push({
        code: 'impossible_pressure_bar',
        severity: 'high',
        message: `bar unit but p95=${p95} > 500`,
      });
    }
    if (
      (unitLower === 'rpm' || unitLower === 'r/min') &&
      p95 !== null &&
      p95 > 15000
    ) {
      issues.push({
        code: 'impossible_rpm',
        severity: 'high',
        message: `rpm unit but p95=${p95} > 15000`,
      });
    }
    if (unit === 'V' && p95 !== null && p95 > 10000) {
      issues.push({
        code: 'impossible_voltage',
        severity: 'high',
        message: `V unit but p95=${p95} > 10000`,
      });
    }

    if (kind === 'counter' && mono === false && nzShare !== null && nzShare > 5) {
      issues.push({
        code: 'counter_not_monotonic',
        severity: 'medium',
        message:
          'kind=counter but is_monotonic=false (data does not strictly grow)',
      });
    }
    if (kind === 'rate' && mono === true) {
      issues.push({
        code: 'rate_is_monotonic',
        severity: 'medium',
        message: 'kind=rate but is_monotonic=true (looks more like a counter)',
      });
    }
    if (kind === 'state') {
      if (p95 !== null && p95 > 100) {
        issues.push({
          code: 'state_with_high_values',
          severity: 'medium',
          message: `kind=state but p95=${p95} — state should be a small enum`,
        });
      }
    }

    if (m.aiUnitConfidence !== null && m.aiUnitConfidence < 0.3) {
      issues.push({
        code: 'low_unit_confidence',
        severity: 'low',
        message: `ai_unit_confidence=${m.aiUnitConfidence}`,
      });
    }
    if (m.aiBoundConfidence !== null && m.aiBoundConfidence < 0.3) {
      issues.push({
        code: 'low_bound_confidence',
        severity: 'low',
        message: `ai_bound_confidence=${m.aiBoundConfidence}`,
      });
    }

    if (
      p50 !== null &&
      p95 !== null &&
      p50 !== 0 &&
      Math.abs(p95) > 1000 &&
      Math.abs(p95 / p50) > 100
    ) {
      issues.push({
        code: 'extreme_p95_vs_p50',
        severity: 'low',
        message: `p95=${p95} is >100x p50=${p50}`,
      });
    }

    // Sensor stuck at 0xFFFF / 0xFFFE etc. — common when a sensor disconnects
    // and the bus reports the max value of an unsigned 16-bit reg.
    const overflowHits = [p5, p50, p95].filter(
      (v): v is number => v !== null && v >= 65490 && v <= 65540,
    ).length;
    if (overflowHits >= 1) {
      issues.push({
        code: 'sensor_overflow_value',
        severity: 'high',
        message: `at least one percentile matches a 16-bit overflow value (~65535): p5=${p5} p50=${p50} p95=${p95}`,
      });
    }

    if (
      p5 === 0 &&
      p50 === 0 &&
      p95 === 0 &&
      (nzShare === null || nzShare === 0)
    ) {
      issues.push({
        code: 'all_zero_typical',
        severity: 'low',
        message:
          'all three percentiles are 0 and non_zero_share is 0/null — metric may be dead',
      });
    }

    return issues;
  }

  private isTemperatureUnit(unitLower: string): boolean {
    return (
      unitLower === '°c' ||
      unitLower === 'c' ||
      unitLower === 'celsius' ||
      unitLower === 'deg c' ||
      unitLower === 'degc'
    );
  }

  private maxSeverity(issues: QualityIssue[]): IssueSeverity {
    let max: IssueSeverity = 'low';
    for (const i of issues) {
      if (SEVERITY_RANK[i.severity] > SEVERITY_RANK[max]) max = i.severity;
    }
    return max;
  }

  private measurementOfKey(key: string, fallbackField: string): string {
    const parts = key.split('::');
    return parts.length === 3 ? parts[1] : fallbackField;
  }
}
