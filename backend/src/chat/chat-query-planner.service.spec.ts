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
    expect(plan.hardDocumentCategories).toEqual(['HISTORY_PROCEDURES']);
    expect(plan.requiresCurrentDateTime).toBe(true);
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.allowsMaintenanceCalculation).toBe(true);
  });

  it('routes generic due-date maintenance phrasing to next-due calculation', () => {
    const plan = service.planQuery(
      'When is the starboard engine oil change due?',
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

  it('routes remaining-hours maintenance phrasing to next-due calculation', () => {
    const plan = service.planQuery(
      'How many hours remain until the next annual service on the starboard generator?',
    );

    expect(plan.primaryIntent).toBe('next_due_calculation');
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.allowsMaintenanceCalculation).toBe(true);
  });

  it('routes procedures to manuals first', () => {
    const plan = service.planQuery(
      'How do I carry out the monthly bilge pump run on the port bilge pump?',
    );

    expect(plan.primaryIntent).toBe('maintenance_procedure');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
    expect(plan.prefersExactDocumentRows).toBe(true);
  });

  it('routes hyphenated interval maintenance list questions to manuals with exact-row preference', () => {
    const plan = service.planQuery(
      'list all 500-hour maintenance items for the diesel generator',
    );

    expect(plan.primaryIntent).toBe('maintenance_procedure');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
    expect(plan.prefersExactDocumentRows).toBe(true);
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
    expect(plan.hardDocumentCategories).toEqual(['CERTIFICATES']);
    expect(plan.requiresCurrentDateTime).toBe(true);
  });

  it('routes broad certificate expiry questions to certificates first', () => {
    const plan = service.planQuery('Which certificates will expire soon?');

    expect(plan.primaryIntent).toBe('certificate_status');
    expect(plan.sourcePriorities.slice(0, 2)).toEqual([
      'CERTIFICATES',
      'REGULATION',
    ]);
    expect(plan.requiresCurrentDateTime).toBe(true);
  });

  it('routes broad certification expiry wording to certificates first', () => {
    const plan = service.planQuery('Which certifications will expire soon?');

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
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
    expect(plan.requiresTelemetry).toBe(false);
  });

  it('routes replacement-interval maintenance questions to manuals first', () => {
    const plan = service.planQuery(
      'What is the replacement interval for the seawater pump impeller?',
    );

    expect(plan.primaryIntent).toBe('manual_specification');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
  });

  it('routes explicit manual phrasing to manuals first', () => {
    const plan = service.planQuery(
      'What manual says about replacing the fuel separator element?',
    );

    expect(plan.primaryIntent).toBe('manual_specification');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
  });

  it('routes natural-language kit and seal contents questions to manuals', () => {
    const plan = service.planQuery(
      'Which kit contains the O-rings and lip seals for the waterjet?',
    );

    expect(plan.primaryIntent).toBe('parts_fluids_consumables');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
    expect(plan.requiresTelemetry).toBe(false);
  });

  it('routes tank capacity table questions to manuals instead of telemetry', () => {
    const plan = service.planQuery('show tank capacities for fuel tanks');

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
    expect(plan.hardDocumentCategories).toEqual(['REGULATION']);
  });

  it('does not hard-route technical requirement questions to regulation without a regulation anchor', () => {
    const plan = service.planQuery(
      'What ventilation is required in the battery room during normal operation and gas release?',
    );

    expect(plan.primaryIntent).not.toBe('regulation_compliance');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toBeUndefined();
  });

  it('still routes requirement phrasing to regulation when a regulation anchor is explicit', () => {
    const plan = service.planQuery(
      'What is required under MARPOL Annex I for oily water discharge?',
    );

    expect(plan.primaryIntent).toBe('regulation_compliance');
    expect(plan.sourcePriorities[0]).toBe('REGULATION');
    expect(plan.hardDocumentCategories).toEqual(['REGULATION']);
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
    expect(plan.hardDocumentCategories).toEqual(['HISTORY_PROCEDURES']);
    expect(plan.requiresTelemetryHistory).toBe(true);
    expect(plan.supportsMultiSourceAggregation).toBe(true);
  });

  it('allows explicit mixed-source retrieval only when the query asks for both categories', () => {
    const plan = service.planQuery(
      'Which certificates expire soon plus all relevant regulations?',
    );

    expect(plan.primaryIntent).toBe('certificate_status');
    expect(plan.hardDocumentCategories).toEqual([
      'CERTIFICATES',
      'REGULATION',
    ]);
  });

  it('routes coming-month fuel ordering questions to forecasting', () => {
    const plan = service.planQuery(
      'How much fuel should we order for the coming month?',
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

  it('routes current coordinate shorthand questions to telemetry status', () => {
    const plan = service.planQuery('what lon and lat is now?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetryHistory).toBe(false);
  });

  it('routes current vessel location questions to telemetry status', () => {
    const plan = service.planQuery('Where is the yacht now?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetryHistory).toBe(false);
  });

  it('routes explicit metric inventory alarm questions to telemetry list instead of troubleshooting', () => {
    const plan = service.planQuery('Write all actual metrics of bilge alarms');

    expect(plan.primaryIntent).toBe('telemetry_list');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
  });

  it('routes live alarm-state lookups to telemetry status instead of troubleshooting', () => {
    const plan = service.planQuery('Are any bilge alarms active right now?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
  });

  it('routes plural current reading queries to telemetry status', () => {
    const plan = service.planQuery(
      'What are the port generator battery charger voltages right now?',
    );

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
  });
});
