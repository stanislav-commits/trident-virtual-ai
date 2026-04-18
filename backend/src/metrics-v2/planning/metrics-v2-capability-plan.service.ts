import { Injectable } from '@nestjs/common';
import { MetricsV2Plan, MetricsV2MetricRequestPlan } from '../metrics-v2.types';

@Injectable()
export class MetricsV2CapabilityPlanService {
  enhancePlan(plan: MetricsV2Plan): MetricsV2Plan {
    return {
      ...plan,
      requests: plan.requests.map((request) => this.enhanceRequest(request)),
    };
  }

  private enhanceRequest(
    request: MetricsV2MetricRequestPlan,
  ): MetricsV2MetricRequestPlan {
    switch (request.businessConcept) {
      case 'vessel_position':
        return this.enhanceVesselPositionRequest(request);
      default:
        return request;
    }
  }

  private enhanceVesselPositionRequest(
    request: MetricsV2MetricRequestPlan,
  ): MetricsV2MetricRequestPlan {
    const explicitCoordinateAxis = this.hasExplicitCoordinateAxisHint(request);
    const entityHints = this.uniqueStrings([
      ...request.entityHints,
      'position',
      'coordinates',
      'gps',
      'latitude',
      'longitude',
    ]);
    const metricHints = this.uniqueStrings([
      ...request.metricHints,
      'latitude',
      'longitude',
      'coordinates',
      'position',
      'gps',
    ]);

    if (explicitCoordinateAxis) {
      return {
        ...request,
        systemDomain: 'navigation',
        measuredSubject: 'vessel_position',
        signalRole: 'primary_vessel_telemetry',
        assetType: 'navigation',
        entityHints,
        metricHints,
      };
    }

    return {
      ...request,
      shape: 'group',
      presentation: 'breakdown',
      systemDomain: 'navigation',
      measuredSubject: 'vessel_position',
      signalRole: 'primary_vessel_telemetry',
      assetType: 'navigation',
      groupTarget: 'navigation',
      aggregation: request.source === 'current' ? 'latest' : request.aggregation,
      entityHints,
      metricHints,
    };
  }

  private hasExplicitCoordinateAxisHint(
    request: MetricsV2MetricRequestPlan,
  ): boolean {
    const haystack = [
      request.concept,
      ...request.entityHints,
      ...request.metricHints,
    ]
      .join('\n')
      .toLowerCase();

    return /\b(latitude|longitude|lat|lon|lng)\b/.test(haystack);
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
}
