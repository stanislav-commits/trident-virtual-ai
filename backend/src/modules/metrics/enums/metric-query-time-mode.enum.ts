export enum MetricQueryTimeMode {
  SNAPSHOT = 'snapshot',
  POINT_IN_TIME = 'point_in_time',
  RANGE = 'range',
}

// Time-axis aggregation strategy used when timeMode = RANGE.
//
// When to pick which (per concept):
//   gauge          (depth, RPM, voltage)       → MEAN | MIN | MAX
//   instantaneous  (snapshot reading)          → LAST | FIRST
//   cumulative     (counter — fuel.total, kWh) → DELTA (last − first)
//   rate           (L/h, W average)            → INTEGRAL (∫ rate dt) for
//                                                "total over period", or
//                                                MEAN for "avg over period"
//
// Default `mean` is interpretable across gauges and rates, but is wrong for
// cumulative counters where DELTA is needed, and wrong for "how much fuel
// did we burn yesterday" where INTEGRAL of the rate is the answer.
export enum MetricRangeAggregation {
  MEAN = 'mean',
  SUM = 'sum',
  LAST = 'last',
  FIRST = 'first',
  MIN = 'min',
  MAX = 'max',
  DELTA = 'delta',
  INTEGRAL = 'integral',
}
