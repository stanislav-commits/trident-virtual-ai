import {
  MetricsV2BusinessConcept,
  MetricsV2MetricRequestPlan,
} from '../metrics-v2.types';

export function isMetricsV2BusinessConceptCompatible(params: {
  planBusinessConcept: MetricsV2BusinessConcept;
  entryBusinessConcept: MetricsV2BusinessConcept;
}): boolean {
  const { planBusinessConcept, entryBusinessConcept } = params;

  if (planBusinessConcept === 'unknown' || entryBusinessConcept === 'unknown') {
    return true;
  }

  if (planBusinessConcept === entryBusinessConcept) {
    return true;
  }

  return (
    (planBusinessConcept === 'fuel_onboard_inventory' &&
      entryBusinessConcept === 'fuel_tank_inventory_member') ||
    (planBusinessConcept === 'oil_onboard_inventory' &&
      entryBusinessConcept === 'oil_tank_inventory_member') ||
    (planBusinessConcept === 'water_onboard_inventory' &&
      entryBusinessConcept === 'water_tank_inventory_member') ||
    (planBusinessConcept === 'def_onboard_inventory' &&
      entryBusinessConcept === 'def_tank_inventory_member')
  );
}

export function isMetricsV2StrictInventoryRequest(
  plan: MetricsV2MetricRequestPlan,
): boolean {
  return (
    plan.shape === 'group' &&
    (plan.presentation === 'breakdown_with_total' ||
      plan.presentation === 'total_only' ||
      plan.aggregation === 'sum' ||
      plan.businessConcept === 'fuel_onboard_inventory' ||
      plan.businessConcept === 'oil_onboard_inventory' ||
      plan.businessConcept === 'water_onboard_inventory' ||
      plan.businessConcept === 'def_onboard_inventory')
  );
}

export function isMetricsV2InventoryBusinessConcept(
  businessConcept: MetricsV2BusinessConcept,
): boolean {
  return (
    businessConcept === 'fuel_onboard_inventory' ||
    businessConcept === 'fuel_tank_inventory_member' ||
    businessConcept === 'oil_onboard_inventory' ||
    businessConcept === 'oil_tank_inventory_member' ||
    businessConcept === 'water_onboard_inventory' ||
    businessConcept === 'water_tank_inventory_member' ||
    businessConcept === 'def_onboard_inventory' ||
    businessConcept === 'def_tank_inventory_member' ||
    businessConcept === 'generic_tank_inventory_member'
  );
}
