import {
  isCurrentInventoryTelemetryQuery,
  isStrictTelemetryInventoryListQuery,
  isTelemetryInventoryListQuery,
} from '../../../src/common/telemetry-query-intent.utils';

describe('telemetry query intent utils', () => {
  it('detects broad telemetry inventory list requests', () => {
    expect(isTelemetryInventoryListQuery('show all telemetry metrics')).toBe(
      true,
    );
    expect(isTelemetryInventoryListQuery('please list all alarms')).toBe(true);
    expect(isTelemetryInventoryListQuery('show spare parts list')).toBe(false);
  });

  it('keeps strict telemetry list matching narrower for LLM prompt guards', () => {
    expect(isStrictTelemetryInventoryListQuery('show current telemetry')).toBe(
      true,
    );
    expect(isStrictTelemetryInventoryListQuery('show all telemetry signals')).toBe(
      false,
    );
    expect(isTelemetryInventoryListQuery('show all telemetry signals')).toBe(
      true,
    );
  });

  it('detects current inventory telemetry queries with default chat-compatible rules', () => {
    expect(
      isCurrentInventoryTelemetryQuery('what is the fuel level in tank 1'),
    ).toBe(true);
    expect(isCurrentInventoryTelemetryQuery('total def')).toBe(false);
    expect(isCurrentInventoryTelemetryQuery('all oil tanks')).toBe(false);
  });

  it('preserves broader planner inventory matching via options', () => {
    expect(
      isCurrentInventoryTelemetryQuery('total def', {
        includeDefUreaAggregates: true,
      }),
    ).toBe(true);
    expect(
      isCurrentInventoryTelemetryQuery('all oil tanks', {
        includeFluidTankInventoryPhrase: true,
      }),
    ).toBe(true);
  });

  it('rejects historical or ordering inventory wording', () => {
    expect(
      isCurrentInventoryTelemetryQuery(
        'how much fuel was used over the last 7 days',
      ),
    ).toBe(false);
    expect(isCurrentInventoryTelemetryQuery('need to order coolant')).toBe(
      false,
    );
  });
});
