import { Injectable } from '@nestjs/common';
import {
  MetricsV2CatalogEntry,
  MetricsV2ExplainCandidateDecision,
  MetricsV2ExplainEntrySnapshot,
  MetricsV2MetricRequestPlan,
  MetricsV2ResolvedPlan,
  MetricsV2ResolvedPlanDebug,
  MetricsV2ResolvedRequest,
  MetricsV2ResolvedRequestDebug,
} from '../metrics-v2.types';
import {
  isMetricsV2BusinessConceptCompatible,
  isMetricsV2InventoryBusinessConcept,
  isMetricsV2StrictInventoryRequest,
} from '../semantic';

@Injectable()
export class MetricsV2MetricResolverService {
  resolve(params: {
    planRequests: MetricsV2MetricRequestPlan[];
    catalog: MetricsV2CatalogEntry[];
  }): MetricsV2ResolvedPlan & { debug: MetricsV2ResolvedPlanDebug } {
    const requests = params.planRequests.map((plan) =>
      this.resolveRequest(plan, params.catalog),
    );

    return {
      requests,
      debug: {
        requestCount: requests.length,
        requests: requests
          .map((request) => request.debug)
          .filter((debug): debug is MetricsV2ResolvedRequestDebug => Boolean(debug)),
      },
    };
  }

  private resolveRequest(
    plan: MetricsV2MetricRequestPlan,
    catalog: MetricsV2CatalogEntry[],
  ): MetricsV2ResolvedRequest {
    const evaluated = catalog.map((entry) => this.evaluateEntry(entry, plan));

    const rankedEntries = evaluated
      .filter(
        (
          candidate,
        ): candidate is {
          entry: MetricsV2CatalogEntry;
          score: number;
          decision: 'matched';
          reasons: string[];
        } => candidate.decision === 'matched',
      )
      .sort((left, right) => right.score - left.score);

    if (plan.shape === 'group') {
      const groupEntries = this.pickGroupEntries(
        plan,
        rankedEntries.map((candidate) => candidate.entry),
      );

      if (groupEntries.length === 0) {
        return {
          plan,
          entries: [],
          clarificationKind: 'group_not_confident',
          clarificationQuestion:
            'I could not confidently determine which grouped metrics to use for this request.',
          debug: this.buildRequestDebug({
            plan,
            catalogSize: catalog.length,
            selectedEntries: [],
            rankedEntries,
            evaluated,
          }),
        };
      }

      return {
        plan,
        entries: groupEntries,
        debug: this.buildRequestDebug({
          plan,
          catalogSize: catalog.length,
          selectedEntries: groupEntries,
          rankedEntries,
          evaluated,
        }),
      };
    }

    const topCandidate = rankedEntries[0];
    if (!topCandidate) {
      return {
        plan,
        entries: [],
        clarificationKind: 'exact_metric_not_found',
        clarificationQuestion:
          'I could not determine which exact metric matches this request.',
        debug: this.buildRequestDebug({
          plan,
          catalogSize: catalog.length,
          selectedEntries: [],
          rankedEntries,
          evaluated,
        }),
      };
    }

    const ambiguitySlice = rankedEntries
      .slice(0, 4)
      .filter((candidate) => topCandidate.score - candidate.score <= 1.5);

    if (ambiguitySlice.length > 1) {
      return {
        plan,
        entries: ambiguitySlice.map((candidate) => candidate.entry),
        clarificationKind: 'ambiguous_metrics',
        clarificationQuestion:
          'I found several similar metrics that could match this request. Which one do you want?',
        clarificationOptions: ambiguitySlice.map(
          (candidate) => candidate.entry.label,
        ),
        debug: this.buildRequestDebug({
          plan,
          catalogSize: catalog.length,
          selectedEntries: ambiguitySlice.map((candidate) => candidate.entry),
          rankedEntries,
          evaluated,
        }),
      };
    }

    return {
      plan,
      entries: [topCandidate.entry],
      debug: this.buildRequestDebug({
        plan,
        catalogSize: catalog.length,
        selectedEntries: [topCandidate.entry],
        rankedEntries,
        evaluated,
      }),
    };
  }

  private pickGroupEntries(
    plan: MetricsV2MetricRequestPlan,
    entries: MetricsV2CatalogEntry[],
  ): MetricsV2CatalogEntry[] {
    const uniqueEntries = entries.filter((entry, index, currentEntries) => {
      return !currentEntries
        .slice(0, index)
        .some((existing) => existing.key === entry.key);
    });

    if (plan.businessConcept === 'vessel_position') {
      const coordinateEntries = uniqueEntries.filter((entry) =>
        this.isCoordinateAxisEntry(entry),
      );

      if (coordinateEntries.length >= 2) {
        return coordinateEntries.slice(0, 4);
      }

      if (coordinateEntries.length > 0) {
        return coordinateEntries;
      }
    }

    return uniqueEntries.slice(0, 12);
  }

  private isCoordinateAxisEntry(entry: MetricsV2CatalogEntry): boolean {
    const haystack = [
      entry.key,
      entry.label,
      entry.field ?? '',
    ]
      .join('\n')
      .toLowerCase();

    return /\b(latitude|longitude|lat|lon|lng)\b/.test(haystack);
  }

  private evaluateEntry(
    entry: MetricsV2CatalogEntry,
    plan: MetricsV2MetricRequestPlan,
  ):
    | {
        entry: MetricsV2CatalogEntry;
        score: number;
        decision: 'matched';
        reasons: string[];
      }
    | {
        entry: MetricsV2CatalogEntry;
        score: number;
        decision: 'rejected';
        reasons: string[];
      } {
    const reasons = this.getCompatibilityRejectionReasons(entry, plan);
    if (reasons.length > 0) {
      return {
        entry,
        score: 0,
        decision: 'rejected',
        reasons,
      };
    }

    const score = this.scoreEntry(entry, plan);
    if (score <= 0) {
      return {
        entry,
        score,
        decision: 'rejected',
        reasons: ['low_semantic_score'],
      };
    }

    return {
      entry,
      score,
      decision: 'matched',
      reasons: ['compatible_semantic_match'],
    };
  }

  private buildRequestDebug(params: {
    plan: MetricsV2MetricRequestPlan;
    catalogSize: number;
    selectedEntries: MetricsV2CatalogEntry[];
    rankedEntries: Array<{
      entry: MetricsV2CatalogEntry;
      score: number;
      decision: 'matched';
      reasons: string[];
    }>;
    evaluated: Array<
      | {
          entry: MetricsV2CatalogEntry;
          score: number;
          decision: 'matched';
          reasons: string[];
        }
      | {
          entry: MetricsV2CatalogEntry;
          score: number;
          decision: 'rejected';
          reasons: string[];
        }
    >;
  }): MetricsV2ResolvedRequestDebug {
    const selectedKeys = new Set(params.selectedEntries.map((entry) => entry.key));

    const matchedEntries = params.rankedEntries
      .slice(0, 8)
      .map((candidate) =>
        this.toExplainDecision(
          candidate.entry,
          selectedKeys.has(candidate.entry.key) ? 'selected' : 'matched',
          candidate.score,
          candidate.reasons,
        ),
      );

    const rejectedEntries = params.evaluated
      .filter(
        (
          candidate,
        ): candidate is {
          entry: MetricsV2CatalogEntry;
          score: number;
          decision: 'rejected';
          reasons: string[];
        } => candidate.decision === 'rejected',
      )
      .slice(0, 12)
      .map((candidate) =>
        this.toExplainDecision(
          candidate.entry,
          'rejected',
          candidate.score,
          candidate.reasons,
        ),
      );

    return {
      requestId: params.plan.requestId,
      queryConcept: params.plan.concept,
      businessConcept: params.plan.businessConcept,
      source: params.plan.source,
      shape: params.plan.shape,
      presentation: params.plan.presentation,
      catalogSize: params.catalogSize,
      matchedCount: params.rankedEntries.length,
      selectedCount: params.selectedEntries.length,
      selectedEntries: matchedEntries.filter(
        (decision) => decision.decision === 'selected',
      ),
      matchedEntries,
      rejectedEntries,
    };
  }

  private toExplainDecision(
    entry: MetricsV2CatalogEntry,
    decision: 'selected' | 'matched' | 'rejected',
    score: number,
    reasons: string[],
  ): MetricsV2ExplainCandidateDecision {
    return {
      entry: this.toExplainSnapshot(entry),
      decision,
      score,
      reasons,
    };
  }

  private toExplainSnapshot(
    entry: MetricsV2CatalogEntry,
  ): MetricsV2ExplainEntrySnapshot {
    return {
      key: entry.key,
      label: entry.label,
      businessConcept: entry.businessConcept,
      measurementKind: entry.measurementKind,
      systemDomain: entry.systemDomain,
      measuredSubject: entry.measuredSubject,
      signalRole: entry.signalRole,
      motionReference: entry.motionReference,
      fluidType: entry.fluidType,
      assetType: entry.assetType,
      unitKind: entry.unitKind,
      unit: entry.unit,
      groupFamily: entry.groupFamily,
      groupMemberKey: entry.groupMemberKey,
    };
  }

  private getCompatibilityRejectionReasons(
    entry: MetricsV2CatalogEntry,
    plan: MetricsV2MetricRequestPlan,
  ): string[] {
    const reasons: string[] = [];

    if (
      plan.businessConcept !== 'unknown' &&
      entry.businessConcept !== 'unknown' &&
      !isMetricsV2BusinessConceptCompatible({
        planBusinessConcept: plan.businessConcept,
        entryBusinessConcept: entry.businessConcept,
      })
    ) {
      reasons.push('business_concept_mismatch');
    }

    if (
      plan.measurementKind !== 'unknown' &&
      entry.measurementKind !== 'unknown' &&
      entry.measurementKind !== plan.measurementKind
    ) {
      const equivalentKinds = new Set([
        `${plan.measurementKind}:${entry.measurementKind}`,
        `${entry.measurementKind}:${plan.measurementKind}`,
      ]);
      if (
        !equivalentKinds.has('level:volume') &&
        !equivalentKinds.has('level:quantity') &&
        !equivalentKinds.has('volume:quantity')
      ) {
        reasons.push('measurement_kind_mismatch');
      }
    }

    if (
      plan.measuredSubject &&
      plan.measuredSubject !== 'unknown' &&
      entry.measuredSubject &&
      entry.measuredSubject !== 'unknown' &&
      entry.measuredSubject !== plan.measuredSubject
    ) {
      reasons.push('measured_subject_mismatch');
    }

    if (
      plan.systemDomain &&
      plan.systemDomain !== 'unknown' &&
      entry.systemDomain &&
      entry.systemDomain !== 'unknown' &&
      entry.systemDomain !== plan.systemDomain
    ) {
      reasons.push('system_domain_mismatch');
    }

    if (
      plan.signalRole &&
      plan.signalRole !== 'unknown' &&
      entry.signalRole &&
      entry.signalRole !== 'unknown' &&
      entry.signalRole !== plan.signalRole
    ) {
      reasons.push('signal_role_mismatch');
    }

    if (
      plan.motionReference &&
      plan.motionReference !== 'unknown' &&
      entry.motionReference &&
      entry.motionReference !== 'unknown' &&
      entry.motionReference !== plan.motionReference
    ) {
      reasons.push('motion_reference_mismatch');
    }

    if (
      isMetricsV2StrictInventoryRequest(plan) &&
      entry.measurementKind === 'unknown'
    ) {
      reasons.push('strict_inventory_requires_known_measurement_kind');
    }

    if (
      plan.fluidType &&
      plan.fluidType !== 'unknown' &&
      (entry.fluidType == null || entry.fluidType !== plan.fluidType)
    ) {
      reasons.push('fluid_type_mismatch');
    }

    if (
      plan.assetType &&
      plan.assetType !== 'unknown' &&
      (entry.assetType == null || entry.assetType !== plan.assetType)
    ) {
      reasons.push('asset_type_mismatch');
    }

    if (plan.groupTarget === 'storage_tanks' && entry.assetType !== 'storage_tank') {
      reasons.push('group_target_requires_storage_tank');
    }

    if (plan.groupTarget === 'engines' && entry.assetType !== 'engine') {
      reasons.push('group_target_requires_engine');
    }

    if (plan.groupTarget === 'generators' && entry.assetType !== 'generator') {
      reasons.push('group_target_requires_generator');
    }

    if (plan.groupTarget === 'batteries' && entry.assetType !== 'battery') {
      reasons.push('group_target_requires_battery');
    }

    if (plan.groupTarget === 'chargers' && entry.assetType !== 'charger') {
      reasons.push('group_target_requires_charger');
    }

    if (plan.groupTarget === 'navigation' && entry.assetType !== 'navigation') {
      reasons.push('group_target_requires_navigation');
    }

    if (isMetricsV2StrictInventoryRequest(plan)) {
      if (!isMetricsV2InventoryBusinessConcept(entry.businessConcept)) {
        reasons.push('strict_inventory_requires_inventory_business_concept');
      }
      if (entry.assetType !== 'storage_tank') {
        reasons.push('strict_inventory_requires_storage_tank');
      }
      if (
        !(
          entry.measurementKind === 'level' ||
          entry.measurementKind === 'volume' ||
          entry.measurementKind === 'quantity'
        )
      ) {
        reasons.push('strict_inventory_requires_level_or_volume');
      }
      if (entry.unitKind !== 'volume') {
        reasons.push('strict_inventory_requires_volume_unit');
      }
      if (!entry.aggregationCompatibility.includes('sum_total_onboard')) {
        reasons.push('strict_inventory_requires_sum_compatibility');
      }
    }

    return [...new Set(reasons)];
  }

  private scoreEntry(
    entry: MetricsV2CatalogEntry,
    plan: MetricsV2MetricRequestPlan,
  ): number {
    const haystack = entry.searchText;
    let score = 0;

    for (const hint of [...plan.entityHints, ...plan.metricHints]) {
      const normalizedHint = hint.trim().toLowerCase();
      if (!normalizedHint) {
        continue;
      }

      if (haystack.includes(normalizedHint)) {
        score += normalizedHint.length > 6 ? 4 : 2;
      } else {
        const tokens = normalizedHint.split(/\s+/g).filter(Boolean);
        score += tokens.filter((token) => haystack.includes(token)).length;
      }
    }

    if (plan.concept && haystack.includes(plan.concept.toLowerCase())) {
      score += 4;
    }

    if (
      plan.businessConcept !== 'unknown' &&
      plan.businessConcept === entry.businessConcept
    ) {
      score += 10;
    } else if (
      plan.businessConcept !== 'unknown' &&
      entry.businessConcept !== 'unknown' &&
      isMetricsV2BusinessConceptCompatible({
        planBusinessConcept: plan.businessConcept,
        entryBusinessConcept: entry.businessConcept,
      })
    ) {
      score += 6;
    }

    if (
      plan.measuredSubject &&
      plan.measuredSubject !== 'unknown' &&
      plan.measuredSubject === entry.measuredSubject
    ) {
      score += 8;
    }

    if (
      plan.systemDomain &&
      plan.systemDomain !== 'unknown' &&
      plan.systemDomain === entry.systemDomain
    ) {
      score += 4;
    }

    if (
      plan.signalRole &&
      plan.signalRole !== 'unknown' &&
      plan.signalRole === entry.signalRole
    ) {
      score += 3;
    }

    if (
      plan.motionReference &&
      plan.motionReference !== 'unknown' &&
      plan.motionReference === entry.motionReference
    ) {
      score += 5;
    }

    if (
      plan.businessConcept === 'vessel_speed' &&
      plan.measuredSubject === 'vessel_motion'
    ) {
      if (!plan.motionReference || plan.motionReference === 'unknown') {
        if (entry.motionReference === 'through_water') {
          score += 4;
        } else if (entry.motionReference === 'over_ground') {
          score += 2;
        }
      }
    }

    if (
      plan.groupTarget === 'storage_tanks' &&
      entry.assetType === 'storage_tank'
    ) {
      score += 5;
    }

    if (
      isMetricsV2StrictInventoryRequest(plan) &&
      entry.groupFamily &&
      entry.aggregationCompatibility.includes('sum_total_onboard')
    ) {
      score += 8;
    }

    if (plan.fluidType && plan.fluidType === entry.fluidType) {
      score += 4;
    }

    if (
      (plan.measurementKind === 'level' || plan.measurementKind === 'volume') &&
      (entry.measurementKind === 'level' || entry.measurementKind === 'volume')
    ) {
      score += 4;
    } else if (plan.measurementKind === entry.measurementKind) {
      score += 5;
    }

    if (entry.groupMemberKey && plan.shape === 'group') {
      score += 1;
    }

    if (entry.valueUpdatedAt) {
      score += 0.25;
    }

    return score;
  }
}
