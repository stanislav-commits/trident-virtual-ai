import { ChatQueryPlannerService } from '../../../../src/chat-shared/query/chat-query-planner.service';
import { ChatQueryNormalizationService } from '../../../../src/chat-shared/query/chat-query-normalization.service';

describe('ChatQueryPlannerService', () => {
  const service = new ChatQueryPlannerService();
  const normalizationService = new ChatQueryNormalizationService();

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

  it('routes alarm installation and connection procedures to manuals first', () => {
    const plan = service.planQuery(
      'How should the 15 ppm bilge alarm be installed and connected?',
    );

    expect(plan.primaryIntent).toBe('maintenance_procedure');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
    expect(plan.requiresTelemetry).toBe(false);
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

  it('routes explicit selected-document prompts to manual specification instead of telemetry', () => {
    const plan = service.planQuery(
      'From VSS001980 - VSS Fire Extinguisher Powder Kg 6_Data sheets.pdf document: fire extinguisher technical specification',
    );

    expect(plan.primaryIntent).toBe('manual_specification');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
    expect(plan.hardDocumentCategories).toEqual(['MANUALS']);
    expect(plan.requiresTelemetry).toBe(false);
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

  it('routes conversational telemetry follow-ups about the current vessel location back to telemetry', () => {
    const normalized = normalizationService.normalizeTurn({
      userQuery: 'can you show me where this is?',
      messageHistory: [
        {
          role: 'user',
          content: "what's current yacht speed and location",
        },
        {
          role: 'assistant',
          content: 'The current matched telemetry readings are: ...',
          ragflowContext: {
            answerRoute: 'current_telemetry',
            resolvedSubjectQuery: "what's current yacht speed and location",
            telemetryFollowUpQuery: "what's current yacht speed and location",
          },
        },
      ],
    });
    const plan = service.planQuery(normalized, normalized.retrievalQuery);

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
  });

  it('routes telemetry counter wording like operating time to telemetry status', () => {
    const normalized = normalizationService.normalizeTurn({
      userQuery: 'What is the operating time on the starboard diesel generator?',
    });
    const plan = service.planQuery(normalized, normalized.retrievalQuery);

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.requiresTelemetryHistory).toBe(false);
  });

  it('routes current vessel location questions to telemetry status', () => {
    const plan = service.planQuery('Where is the yacht now?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetryHistory).toBe(false);
  });

  it('routes conversational own-ship motion questions to telemetry status', () => {
    const plan = service.planQuery('where are we and how fast are we moving?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.requiresTelemetryHistory).toBe(false);
  });

  it('routes named-vessel current motion questions to telemetry status', () => {
    const plan = service.planQuery(
      'Where is Sea Wolf X right now and how fast is it moving?',
    );

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.requiresTelemetryHistory).toBe(false);
  });

  it('routes current onboard inventory questions to telemetry status', () => {
    const plan = service.planQuery('How many fresh water onboard right now?');

    expect(plan.primaryIntent).toBe('telemetry_status');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.hardDocumentCategories).toBeUndefined();
  });

  it('routes counter-guided maintenance follow-ups to next-due calculation', () => {
    const plan = service.planQuery(
      'Should I perform any maintenance at this counter for the starboard generator running hours?',
    );

    expect(plan.primaryIntent).toBe('next_due_calculation');
    expect(plan.sourcePriorities.slice(0, 3)).toEqual([
      'HISTORY_PROCEDURES',
      'TELEMETRY',
      'MANUALS',
    ]);
    expect(plan.requiresTelemetry).toBe(true);
    expect(plan.allowsMaintenanceCalculation).toBe(true);
  });

  it('routes explicit metric inventory alarm questions to telemetry list instead of troubleshooting', () => {
    const plan = service.planQuery('Write all actual metrics of bilge alarms');

    expect(plan.primaryIntent).toBe('telemetry_list');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
  });

  it('routes explicit alarm inventory requests without the word metrics to telemetry list', () => {
    const plan = service.planQuery('Show all bilge alarms right now');

    expect(plan.primaryIntent).toBe('telemetry_list');
    expect(plan.sourcePriorities[0]).toBe('TELEMETRY');
    expect(plan.requiresTelemetry).toBe(true);
  });

  it('does not treat alarm-list troubleshooting phrasing as a telemetry inventory request', () => {
    const plan = service.planQuery(
      'What does the generator alarm list say about low oil pressure or high coolant temperature?',
    );

    expect(plan.primaryIntent).toBe('troubleshooting');
    expect(plan.sourcePriorities[0]).toBe('MANUALS');
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
