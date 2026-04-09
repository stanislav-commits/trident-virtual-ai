import { LlmService } from './llm.service';
import { IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT } from './chat-core-system-prompt.constants';

describe('LlmService maintenance calculation guard', () => {
  const originalModel = process.env.LLM_MODEL;

  beforeAll(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  });

  afterEach(() => {
    if (originalModel) {
      process.env.LLM_MODEL = originalModel;
    } else {
      delete process.env.LLM_MODEL;
    }
  });

  it('classifies oil change procedure questions as maintenance procedures instead of parts requests', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent(
        'I need the oil change procedure for the port generator.',
      ),
    ).toBe('maintenance_procedure');
  });

  it('classifies how-do-i maintenance questions as procedures instead of parts-only requests', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent(
        'How do I change oil in the port generator?',
      ),
    ).toBe('maintenance_procedure');
  });

  it('classifies current fuel or oil readings as telemetry queries instead of parts lookups', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent('what the current fuel level?'),
    ).toBe('telemetry_status');
    expect(
      (service as any).classifyQueryIntent('what the current oil level?'),
    ).toBe('telemetry_status');
  });

  it('classifies metric list requests as telemetry list queries', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent(
        'Show 10 random active metrics for this ship.',
      ),
    ).toBe('telemetry_list');
  });

  it('classifies manual range/specification questions as manual specifications instead of telemetry', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent(
        'What is the normal coolant temperature range for this Volvo engine?',
      ),
    ).toBe('manual_specification');
  });

  it('classifies exact telemetry-like metric identifiers as telemetry queries', () => {
    const service = new LlmService();

    expect((service as any).classifyQueryIntent('Fuel_Tank_4S')).toBe(
      'telemetry_status',
    );
  });

  it('treats exact reference ids as direct lookups instead of opaque fragments', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent('Reference ID 1P47'),
    ).not.toBe('fragment_reference');
    expect(
      (service as any).isDirectLookupSubjectQuery('Reference ID 1P47'),
    ).toBe(true);
  });

  it('fills ship placeholders in editable system prompt templates', () => {
    const service = new LlmService();

    const prompt = (service as any).buildSystemPrompt(
      'Aurora',
      'Support {{shipName}}|{{shipNameWithParens}}',
    );

    expect(prompt).toBe('Support Aurora| (Aurora)');
  });

  it('uses the immutable core system prompt for chat generation instead of the editable DB prompt', async () => {
    const systemPromptService = {
      getPromptTemplate: jest.fn().mockResolvedValue('DB prompt should be ignored'),
    };
    const service = new LlmService(systemPromptService as never);
    const create = jest.fn().mockResolvedValue({
      id: 'resp_123',
      output_text: 'ok',
    });
    (service as any).client = {
      responses: {
        create,
      },
    };

    await service.generateResponse({
      userQuery: 'What is the normal coolant temperature range for this Volvo engine?',
      citations: [
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          sourceCategory: 'MANUALS',
          snippet: 'Coolant temperature, normal operation 75-95C.',
        },
      ],
    });

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0].instructions).toBe(
      IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT,
    );
  });

  it('uses max_output_tokens for Responses API generation', async () => {
    process.env.LLM_MODEL = 'gpt-5.4';

    const service = new LlmService();
    const create = jest.fn().mockResolvedValue({
      id: 'resp_456',
      output_text: 'ok',
    });
    (service as any).client = {
      responses: {
        create,
      },
    };

    await service.generateResponse({
      userQuery: 'Who is the vessel DPA?',
      citations: [],
    });

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0].max_output_tokens).toBe(1500);
  });

  it('forwards previous_response_id for chained Responses API turns', async () => {
    process.env.LLM_MODEL = 'gpt-4o-mini';

    const service = new LlmService();
    const create = jest.fn().mockResolvedValue({
      id: 'resp_789',
      output_text: 'ok',
    });
    (service as any).client = {
      responses: {
        create,
      },
    };

    await service.generateResponse({
      userQuery: 'Who is the vessel DPA?',
      previousResponseId: 'resp_prev',
      citations: [],
    });

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0].previous_response_id).toBe('resp_prev');
    expect(create.mock.calls[0][0].input).toEqual(expect.any(String));
  });

  it('replays chat history statelessly when no previous response id is available', async () => {
    const service = new LlmService();
    const create = jest.fn().mockResolvedValue({
      id: 'resp_hist',
      output_text: 'ok',
    });
    (service as any).client = {
      responses: {
        create,
      },
    };

    await service.generateResponse({
      userQuery: 'What about the other one?',
      chatHistory: [
        { role: 'user', content: "who is vessel's dpa?" },
        { role: 'assistant', content: 'The DPA contact is JMS.' },
        { role: 'user', content: 'What about the other one?' },
      ],
      citations: [],
    });

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0].input).toEqual([
      { role: 'user', content: "who is vessel's dpa?" },
      { role: 'assistant', content: 'The DPA contact is JMS.' },
      {
        role: 'user',
        content: expect.stringContaining('Question: What about the other one?'),
      },
    ]);
  });

  it('labels documentation sources with category-aware inline source tags', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'When is the next maintenance due?',
      citations: [
        {
          sourceTitle: 'Main Engine Maintenance Tasks.pdf',
          sourceCategory: 'MANUALS',
          snippet: 'Next due: 2200 hours.',
        },
        {
          sourceTitle: 'Flag Survey Due Dates.pdf',
          sourceCategory: 'CERTIFICATES',
          snippet: 'Annual survey due 2026-10-01.',
        },
      ],
    });

    expect(prompt).toContain('[1] [PMS] Main Engine Maintenance Tasks.pdf');
    expect(prompt).toContain(
      '[2] [Certificate: Flag Survey Due Dates.pdf]',
    );
  });

  it('injects operational context with current timestamp and preferred evidence order', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-26T10:15:00.000Z'));
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'When does the fire suppression system certificate expire?',
      citations: [
        {
          sourceTitle: 'Fire Suppression Survey.pdf',
          sourceCategory: 'CERTIFICATES',
          snippet: 'Certificate valid until 14 August 2026.',
        },
      ],
    });

    expect(prompt).toContain(
      'Current operational timestamp (UTC): 2026-03-26T10:15:00.000Z',
    );
    expect(prompt).toContain(
      'Preferred evidence order: CERTIFICATES -> REGULATION -> HISTORY_PROCEDURES -> MANUALS -> TELEMETRY',
    );
    expect(prompt).toContain(
      'Use the current timestamp above whenever you need to determine whether something is overdue',
    );
    expect(prompt).toContain(
      'Answer with the documented expiry or valid-until date first.',
    );

    jest.useRealTimers();
  });

  it('includes a compact structured conversation state block when provided', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'what about the other one?',
      previousUserQuery: 'email only',
      resolvedSubjectQuery: 'vessel dpa contact details',
      structuredConversationState:
        `Recent assistant states:
- answerRoute=llm_generation; generator=llm; sources=documentation; resolvedSubject="who is vessel's dpa?"
- answerRoute=deterministic_contact; generator=deterministic; sources=documentation; resolvedSubject="vessel dpa contact details"; followUpMode=follow_up`,
    });

    expect(prompt).toContain('Structured conversation state:');
    expect(prompt).toContain(
      'answerRoute=deterministic_contact; generator=deterministic',
    );
    expect(prompt).toContain(
      'resolvedSubject="vessel dpa contact details"',
    );
  });

  it('warns the procedure prompt not to invent drain-fill steps or derive oil quantity from parts rows', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'I need the oil change procedure for the port generator.',
      resolvedSubjectQuery:
        'port generator PS ENGINE A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE',
      citations: [
        {
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          snippet:
            'Reference row: Component name: PS ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE Reference ID: 1P47 Included work items: - REPLACE OIL AND FILTERS Spare parts: - Spare Name: Volvo Penta Engine Oil 15 W-40 Quantity: 2',
        },
      ],
    });

    expect(prompt).toContain(
      'do not invent an exact drain, refill, warm-up, or leak-check sequence',
    );
    expect(prompt).toContain(
      'Do not infer oil capacity, fill volume, or consumption from spare-parts quantities',
    );
    expect(prompt).toContain('Tools and Materials Needed:');
    expect(prompt).toContain('Step-by-Step Instructions:');
    expect(prompt).toContain('Safety Warnings:');
    expect(prompt).toContain(
      'If a section is not documented, say it is not specified instead of inventing content.',
    );
    expect(prompt).toContain(
      'Do not add generic safety advice, generic electrical cautions, or invented preparation steps.',
    );
    expect(prompt).toContain(
      'Only include a Safety Warnings section when the cited text contains a warning, caution, danger note, or an explicit safety instruction.',
    );
  });

  it('tells parts prompts to answer partially when an item is mentioned but location or quantity is missing', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'Where are the impeller spares for the port generator stored?',
      citations: [
        {
          sourceTitle: 'Recommended Mase Parts.pdf',
          snippet:
            'List of recommended spare Mase parts. Sea water pump impeller code 913722.',
        },
      ],
    });

    expect(prompt).toContain(
      'If the documentation confirms a specific spare item or part code but omits quantity, location, or part numbers, state what is confirmed and explicitly say which details are not shown.',
    );
    expect(prompt).toContain(
      'Only say that the documentation does not list parts when the asked part itself is not mentioned.',
    );
  });

  it('marks prefiltered telemetry as the best current metric match in the prompt', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'Fuel_Tank_4S',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'exact',
      noDocumentation: true,
      telemetry: {
        'Tanks-Temperatures.Fuel_Tank_4S': 18.2,
      },
    });

    expect(prompt).toContain('Matched Telemetry:');
    expect(prompt).toContain(
      'preselected as the best matches for the current question',
    );
    expect(prompt).toContain(
      'Prefer these matched telemetry readings when they directly answer the request.',
    );
    expect(prompt).toContain(
      'The telemetry below contains an exact metric match for the question.',
    );
  });

  it('tells telemetry-status prompts to answer from matched telemetry before documentation', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'what the current fuel level?',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'direct',
      telemetry: {
        'Tanks.Fuel_Level': 63,
      },
      citations: [
        {
          sourceTitle: 'Volvo Penta operators manual',
          snippet: 'Fuel level gauge can be shown in vessel view.',
        },
      ],
    });

    expect(prompt).toContain('This is a current telemetry/status question.');
    expect(prompt).toContain(
      'Answer from the matched telemetry first when one telemetry item clearly matches the asked metric.',
    );
    expect(prompt).toContain(
      'The telemetry below directly measures the requested current reading.',
    );
  });

  it('tells telemetry list prompts to answer from telemetry instead of documentation', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'Show 10 random active metrics for this ship.',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'sample',
      telemetry: {
        'Tanks.Fuel_Level': 63,
        'Electrical.Battery_Voltage': 26.3,
      },
      noDocumentation: true,
    });

    expect(prompt).toContain(
      'The user is asking for a list or sample of currently active telemetry metrics.',
    );
    expect(prompt).toContain('Answer only from the provided telemetry list.');
  });

  it('tells mixed telemetry-guidance prompts to anchor the answer in current telemetry first', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'Based on the current oil level, what should I do next?',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'direct',
      telemetry: {
        'CleanOilTank.Level': 9,
      },
      citations: [
        {
          sourceTitle: 'Volvo Penta operators manual',
          snippet:
            'Pull out the dipstick and ensure the oil level is between MAX and MIN markings.',
        },
      ],
    });

    expect(prompt).toContain(
      'This question combines a current telemetry reading with a request for guidance or next actions.',
    );
    expect(prompt).toContain(
      'If the matched telemetry already provides one or more direct readings, state those readings explicitly before any recommendation and do not say the reading is unavailable.',
    );
    expect(prompt).toContain(
      'If the documentation does not define an action threshold or recommendation for the matched telemetry reading, say that clearly instead of inventing one.',
    );
  });

  it('adds troubleshooting output structure guidance to the prompt', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery:
        'The port generator has a high coolant temperature alarm, what checks should I do first?',
      citations: [
        {
          sourceTitle: 'Volvo Generator Manual.pdf',
          snippet:
            'Coolant Temperature Possible cause: The coolant temperature is too high. Corrective Action: Check the coolant level. Check the seawater filter.',
        },
      ],
    });

    expect(prompt).toContain('Common causes to check:');
    expect(prompt).toContain('Start with these quick checks:');
    expect(prompt).toContain('If the fault remains:');
  });

  it('tells the LLM to answer from a primary and secondary source when top-two merged sources are provided', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'How do I install the mini alarm?',
      mergeBySource: true,
      sourceMergeTitles: ['Primary Manual.pdf', 'Secondary Manual.pdf'],
      citations: [
        {
          sourceTitle: 'Primary Manual.pdf',
          snippet:
            'Mini alarm installation: remove the cover, mount the base, connect the wiring.',
        },
        {
          sourceTitle: 'Secondary Manual.pdf',
          snippet:
            'Mini alarm installation note: seal the mounting screws and use IP65 cable glands outside.',
        },
      ],
    });

    expect(prompt).toContain(
      'Use Primary Manual.pdf as the primary documented source and Secondary Manual.pdf as a secondary supporting source.',
    );
    expect(prompt).toContain(
      'If the secondary source adds compatible details, fold them in briefly as additional documented guidance.',
    );
    expect(prompt).toContain(
      'If the two sources differ on a material fact, keep the answer separated by source instead of blending the conflicting details.',
    );
  });

  it('tells manual specification prompts to ignore unrelated numeric ranges', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery:
        'According to the manual, what is the normal coolant temperature range for the engine?',
      citations: [
        {
          sourceTitle: 'MMEN06 Manual SPC-II Hybrid - NG.pdf',
          snippet: 'Input Voltage range 170-520V 3ph.',
        },
      ],
    });

    expect(prompt).toContain(
      'Ignore unrelated numeric ranges such as voltage, ambient temperature, or dimensional limits when the cited text does not clearly match the asked subsystem.',
    );
  });

  it('tells telemetry list prompts to keep the list scoped to the requested subject', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'List 5 current active metrics related to fuel tanks.',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'sample',
      telemetry: {
        'Tanks-Temperatures.Fuel_Tank_1P': 3128,
        'Tanks-Temperatures.Fuel_Tank_2S': 2374,
      },
      noDocumentation: true,
    });

    expect(prompt).toContain(
      'If the query narrows the list to a subject such as fuel tanks, generators, or batteries, only use telemetry items that match that subject.',
    );
  });

  it('tells telemetry prompts to calculate combined totals from matched tank readings', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'Calculate how many fuel onboard according to all fuel tanks',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'direct',
      telemetry: {
        'Tanks-Temperatures.Fuel_Tank_1P': 3142,
        'Tanks-Temperatures.Fuel_Tank_2S': 2374,
      },
      noDocumentation: true,
    });

    expect(prompt).toContain(
      'The user is asking for a combined total or calculation from multiple current telemetry readings.',
    );
    expect(prompt).toContain(
      'calculate the combined result explicitly, and state the total in the answer.',
    );
    expect(prompt).toContain(
      'Do not mix unrelated tanks, fluids, or telemetry subjects into the calculation.',
    );
    expect(prompt).toContain(
      'Do not refuse the calculation just because a selected tank reading has imperfect descriptive text.',
    );
  });

  it('tells telemetry prompts to treat latitude and longitude as the vessel location', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'What is the yacht location?',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'direct',
      telemetry: {
        'navigation.latitude': 43.53606,
        'navigation.longitude': 7.006816666666666,
      },
      noDocumentation: true,
    });

    expect(prompt).toContain(
      'treat those coordinates together as the vessel\'s current location',
    );
    expect(prompt).toContain(
      'Do not say the location is unavailable when those coordinates are present.',
    );
  });

  it('warns when only related telemetry is available for a requested metric', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'oil level from telemetry',
      telemetryPrefiltered: true,
      telemetryMatchMode: 'related',
      telemetry: {
        'SIEMENS-MASE-GENSET-PS.Oil Pressure': 0,
        'SIEMENS-MASE-GENSET-PS.Oil temperature': 15,
      },
      noDocumentation: true,
    });

    expect(prompt).toContain(
      'The telemetry below is only related supporting telemetry and may not directly measure the exact value asked for.',
    );
  });

  it('does not provide derived next-due candidates when the evidence is ambiguous', () => {
    const service = new LlmService();

    const prompt = (service as any).buildMaintenanceCalculationPrompt({
      userQuery: 'when should we do next maintenance?',
      citations: [
        {
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          pageNumber: 5,
          snippet:
            'BA COMPRESSOR ANNUAL SERVICE 1P118 500 DIVE COMPRESSOR 16.05.2025 / 40 16.05.2026 / 540',
        },
      ],
      telemetry: {
        'Port generator running hours': 2004,
      },
    });

    expect(prompt).toContain(
      'Do not use telemetry hour counters or generic maintenance intervals to calculate a next-due value',
    );
    expect(prompt).not.toContain('Calculated next-due candidates:');
  });

  it('refuses to calculate next due hours when the question has no asset or task subject', () => {
    const service = new LlmService();

    const prompt = (service as any).buildMaintenanceCalculationPrompt({
      userQuery: 'When is the next maintenance due?',
      citations: [
        {
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          pageNumber: 30,
          snippet:
            'Reference row: Component name: PS ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE Reference ID: 1P47 Interval: 1 Years /500 MAIN GENSET PS Last due: 07.07.2025 / 1534 Next due: 07.07.2026 / 2034',
        },
      ],
      telemetry: {
        'Port side MASE diesel generator operating hours': 2006,
      },
    });

    expect(prompt).toContain(
      'The question does not identify one exact asset, component, maintenance task, or reference ID.',
    );
    expect(prompt).toContain(
      'Do not use telemetry hour counters or generic maintenance intervals to calculate a next-due value',
    );
    expect(prompt).not.toContain('Detected telemetry hour counters:');
    expect(prompt).not.toContain('Calculated next-due candidates:');
    expect(prompt).not.toContain(
      'Remaining-hours candidates using explicit next-due values:',
    );
  });

  it('expands right-engine subject terms to starboard aliases for maintenance calculations', () => {
    const service = new LlmService();

    const prompt = (service as any).buildMaintenanceCalculationPrompt({
      userQuery: 'When should I change the oil in the right engine?',
      citations: [
        {
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          pageNumber: 18,
          snippet:
            'Component name: SB ENGINE Task name: CHANGE OIL Interval: 500 hours Next due: 4500',
        },
      ],
      telemetry: {
        'SB engine running hours': 4520,
      },
    });

    expect(prompt).toContain('Subject terms to match:');
    expect(prompt).toContain('starboard');
    expect(prompt).toContain('sb');
    expect(prompt).toContain('Detected telemetry hour counters:');
    expect(prompt).toContain('SB engine running hours: 4520 hours');
  });

  it('prioritizes remaining-hours reasoning for hour-based next-due questions when telemetry is available', () => {
    const service = new LlmService();

    const prompt = (service as any).buildMaintenanceCalculationPrompt({
      userQuery:
        'How many hours remain until the next annual service on the starboard generator?',
      citations: [
        {
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          pageNumber: 29,
          snippet:
            'Reference row: Component name: SB ENGINE Task name: F MAIN GENERATOR 500 HOURS / ANNUAL SERVICE Reference ID: 1P59 Last due: 07.07.2025 / 1750 Next due: 07.07.2026 / 2250',
        },
      ],
      telemetry: {
        'Starboard genset operating time counter': 2031,
      },
    });

    expect(prompt).toContain(
      'The user explicitly asked for remaining hours.',
    );
    expect(prompt).toContain(
      'Do not replace a supported remaining-hours calculation with only calendar days',
    );
    expect(prompt).toContain(
      'Starboard genset operating time counter: 2031 hours',
    );
    expect(prompt).toContain('remaining is 219 hours');
  });

  it('classifies vessel location questions as telemetry queries', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent('What is the yacht location?'),
    ).toBe('telemetry_status');
    expect(
      (service as any).classifyQueryIntent('Latitude and longitude'),
    ).toBe('telemetry_status');
  });
});
