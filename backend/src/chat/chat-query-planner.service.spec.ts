import { ChatQueryPlannerService } from './chat-query-planner.service';

describe('ChatQueryPlannerService', () => {
  const service = new ChatQueryPlannerService();

  it('routes next-due maintenance questions to history first with telemetry support', () => {
    const plan = service.planQuery(
      'When should I change the oil in the right engine?',
    );

    expect(plan.primaryIntent).toBe('next_due_calculation');
    expect(plan.sourcePriorities.slice(0, 3)).toEqual([
      'HISTORY_PROCEDURES',
      'TELEMETRY',
      'MANUALS',
    ]);
    expect(plan.requiresCurrentDateTime).toBe(true);
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.allowsMaintenanceCalculation).toBe(true);
  });

  it('routes procedures to manuals first', () => {
    const plan = service.planQuery(
      'How do I carry out the monthly bilge pump run on the port bilge pump?',
    );

    expect(plan.primaryIntent).toBe('maintenance_procedure');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.prefersExactDocumentRows).toBe(false);
  });

  it('routes certificate expiry questions to certificates first and regulations second', () => {
    const plan = service.planQuery(
      'When does the fire suppression system certificate expire?',
    );

    expect(plan.primaryIntent).toBe('certificate_status');
    expect(plan.sourcePriorities.slice(0, 2)).toEqual([
      'CERTIFICATES',
      'REGULATION',
    ]);
    expect(plan.requiresCurrentDateTime).toBe(true);
  });

  it('routes manual specification questions to manuals instead of telemetry', () => {
    const plan = service.planQuery(
      'What is the normal coolant temperature range for this Volvo engine?',
    );

    expect(plan.primaryIntent).toBe('manual_specification');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.requiresTelemetry).toBe(false);
  });

  it('routes compliance questions to regulations first', () => {
    const plan = service.planQuery(
      'What are our obligations for bilge water discharge under MARPOL?',
    );

    expect(plan.primaryIntent).toBe('regulation_compliance');
    expect(plan.sourcePriorities[0]).toBe('REGULATION');
  });

  it('routes forecasting questions to historical data with telemetry support', () => {
    const plan = service.planQuery(
      'How much fuel do we need to order for next month?',
    );

    expect(plan.primaryIntent).toBe('analytics_forecast');
    expect(plan.sourcePriorities.slice(0, 2)).toEqual([
      'HISTORY_PROCEDURES',
      'TELEMETRY',
    ]);
    expect(plan.requiresTelemetryHistory).toBe(true);
    expect(plan.supportsMultiSourceAggregation).toBe(true);
  });

  it('treats plain current average telemetry questions as telemetry status, not forecasting', () => {
    const plan = service.planQuery('What is the average generator load?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetryHistory).toBe(false);
  });
});
