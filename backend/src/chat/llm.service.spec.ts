import { LlmService } from './llm.service';

describe('LlmService maintenance calculation guard', () => {
  beforeAll(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
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

  it('treats exact reference ids as direct lookups instead of opaque fragments', () => {
    const service = new LlmService();

    expect(
      (service as any).classifyQueryIntent('Reference ID 1P47'),
    ).not.toBe('fragment_reference');
    expect(
      (service as any).isDirectLookupSubjectQuery('Reference ID 1P47'),
    ).toBe(true);
  });

  it('warns the procedure prompt not to invent drain-fill steps or derive oil quantity from parts rows', () => {
    const service = new LlmService();

    const prompt = (service as any).buildUserPrompt({
      userQuery: 'I need the oil change procedure for the port generator.',
      resolvedSubjectQuery: 'port generator PS ENGINE A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE',
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
    expect(prompt).not.toContain('Remaining-hours candidates using explicit next-due values:');
  });
});
