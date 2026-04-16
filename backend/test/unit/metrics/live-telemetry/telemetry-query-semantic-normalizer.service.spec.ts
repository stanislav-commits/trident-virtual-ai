import { TelemetryQuerySemanticNormalizerService } from '../../../../src/metrics/live-telemetry/telemetry-query-semantic-normalizer.service';

describe('TelemetryQuerySemanticNormalizerService', () => {
  it('maps conversational vessel whereabouts and pace wording to location and speed fallback hints', async () => {
    const service = new TelemetryQuerySemanticNormalizerService({
      isConfigured: () => false,
      generateStructuredObject: jest.fn(),
    } as never);

    const result = await service.normalize({
      userQuery: 'what are our current whereabouts and pace?',
    });

    expect(result.measurementKinds).toEqual(
      expect.arrayContaining(['location', 'speed']),
    );
    expect(result.semanticPhrases).toEqual(
      expect.arrayContaining([
        'vessel location',
        'vessel position',
        'speed over ground',
      ]),
    );
    expect(result.preferredSpeedKind).toBe('sog');
  });

  it('maps vessel heading wording to heading fallback hints', async () => {
    const service = new TelemetryQuerySemanticNormalizerService({
      isConfigured: () => false,
      generateStructuredObject: jest.fn(),
    } as never);

    const result = await service.normalize({
      userQuery: 'what is the current vessel heading?',
    });

    expect(result.measurementKinds).toEqual(
      expect.arrayContaining(['heading']),
    );
    expect(result.semanticPhrases).toEqual(
      expect.arrayContaining(['vessel heading', 'heading true']),
    );
  });
});
