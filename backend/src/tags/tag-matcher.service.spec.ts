import { TagMatcherService } from './tag-matcher.service';

describe('TagMatcherService', () => {
  const service = new TagMatcherService();

  it('prefers fuel storage tanks over unrelated generic water tanks', () => {
    const tags = [
      {
        id: 'fuel-storage',
        key: 'equipment:fuel:storage_tank',
        category: 'equipment',
        subcategory: 'fuel',
        item: 'storage_tank',
        description: 'Main fuel storage tanks.',
      },
      {
        id: 'water-tank',
        key: 'equipment:water:tank',
        category: 'equipment',
        subcategory: 'water',
        item: 'tank',
        description: 'Fresh water tank.',
      },
    ];

    const matches = service.matchTags(
      service.buildProfiles(tags),
      'Trending Tanks Temperatures Fuel_Tank_1P',
      'metric',
    );

    expect(matches.map((match) => match.tagId)).toEqual(['fuel-storage']);
  });

  it('avoids mapping bilge pumps to unrelated generic pump tags', () => {
    const tags = [
      {
        id: 'bilge-pump',
        key: 'equipment:bilge:pump',
        category: 'equipment',
        subcategory: 'bilge',
        item: 'pump',
        description: 'Bilge pump.',
      },
      {
        id: 'fire-pump',
        key: 'equipment:fire:pump',
        category: 'equipment',
        subcategory: 'fire',
        item: 'pump',
        description: 'Fire pump.',
      },
      {
        id: 'pool-pump',
        key: 'equipment:pool:pump',
        category: 'equipment',
        subcategory: 'pool',
        item: 'pump',
        description: 'Pool circulation pump.',
      },
    ];

    const matches = service.matchTags(
      service.buildProfiles(tags),
      'PORT FORE BILGE PUMP SPY',
      'metric',
    );

    expect(matches.map((match) => match.tagId)).toEqual(['bilge-pump']);
  });

  it('does not match alarm phrases inside grouped measurement names like alarms2', () => {
    const tags = [
      {
        id: 'bilge-alarm',
        key: 'equipment:bilge:alarm',
        category: 'equipment',
        subcategory: 'bilge',
        item: 'alarm',
        description: 'Bilge alarm.',
      },
    ];

    const matches = service.matchTags(
      service.buildProfiles(tags),
      'STBD MAIN BILGE PUMP SPY reading from Bilge-Alarms2',
      'metric',
    );

    expect(matches).toHaveLength(0);
  });

  it('matches emergency bilge pump phrasing to the emergency bilge pump tag', () => {
    const tags = [
      {
        id: 'bilge-pump-emergency',
        key: 'equipment:bilge:pump_emergency',
        category: 'equipment',
        subcategory: 'bilge',
        item: 'pump_emergency',
        description: 'Emergency diesel-driven bilge and fire pump.',
      },
    ];

    const matches = service.matchTags(
      service.buildProfiles(tags),
      'How to replace fuel filter on emergency bilge pump',
      'query',
    );

    expect(matches.map((match) => match.tagId)).toEqual([
      'bilge-pump-emergency',
    ]);
  });

  it('does not map generic shaft wording to a side-specific shaft tag', () => {
    const tags = [
      {
        id: 'shaft-ps',
        key: 'equipment:propulsion:shaft_ps',
        category: 'equipment',
        subcategory: 'propulsion',
        item: 'shaft_ps',
        description: 'Port side propeller shaft, shaft seal, and associated bearings.',
      },
    ];

    const matches = service.matchTags(
      service.buildProfiles(tags),
      'Unpack the pump and check that the shaft turns freely before use.',
      'manual',
    );

    expect(matches).toHaveLength(0);
  });
});
