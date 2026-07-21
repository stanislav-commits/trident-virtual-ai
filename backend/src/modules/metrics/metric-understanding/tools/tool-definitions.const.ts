import { ChatToolDefinition } from '../../../../integrations/shared/openai-compatible-http';

export const TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'query_metric',
      description:
        'Single aggregated Influx query — returns one numeric value.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string', description: 'Influx _measurement value — copy verbatim from the catalog' },
          field: { type: 'string', description: 'Influx _field value — copy verbatim INCLUDING any (unit) parenthetical' },
          aggregation: {
            type: 'string',
            enum: ['mean', 'last', 'first', 'min', 'max', 'sum', 'delta', 'integral'],
            description: 'Aggregation. delta = last − first (counters). integral = ∫value·1h (rates).',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -10m, -24h, -7d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
        },
        required: ['measurement', 'field', 'aggregation', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_asset',
      description:
        'Asset details by asset_id_internal (brand, model, location, criticality, parent).',
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: { type: 'string', description: 'The asset_id_internal value from the ship register' },
        },
        required: ['asset_id_internal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_asset_metrics',
      description:
        'List analyzed metrics bound to an asset_id_internal.',
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: { type: 'string', description: 'Yard-issued asset id' },
        },
        required: ['asset_id_internal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_assets_by_sfi',
      description:
        'In-service assets in an SFI subgroup (e.g. "3.2" propulsion).',
      parameters: {
        type: 'object',
        properties: {
          sfi_sub: { type: 'string', description: 'SFI sub code like "3.2" or "8.1"' },
        },
        required: ['sfi_sub'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_event',
      description:
        'Detect step changes in a metric (tank refill, counter reset, equipment on/off). Returns timestamps with delta ≥ min_delta.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string', description: 'Influx _measurement value — copy verbatim from the catalog' },
          field: { type: 'string', description: 'Influx _field value — copy verbatim INCLUDING any (unit) parenthetical' },
          kind: {
            type: 'string',
            enum: ['step_up', 'step_down', 'both'],
            description: 'step_up = positive jump (refill, fill, recharge). step_down = negative drop. both = either direction.',
          },
          min_delta: {
            type: 'number',
            description: 'Minimum absolute jump to consider an event. Use unit context: for fuel-tank L, ~500. For Wh counters, ~1000.',
          },
          every: {
            type: 'string',
            description: 'Window size for the down-sample, Flux duration. Default 30m. Use 10m for finer events, 1h for slower ones.',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -7d, -30d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          limit: { type: 'integer', description: 'Max events to return (default 10, max 50)' },
        },
        required: ['measurement', 'field', 'kind', 'min_delta', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reverse_geocode',
      description:
        'GPS lat/lon → human place name (city/coastline/harbour). ALWAYS call when reporting coordinates.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude in decimal degrees.' },
          lon: { type: 'number', description: 'Longitude in decimal degrees.' },
          language: {
            type: 'string',
            description: 'Result language, e.g. "ru", "en", "it". Default "en".',
          },
        },
        required: ['lat', 'lon'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Public web search — for generic procedures, brand-equivalent guidance, regulatory refs. Always cite sources + flag "public, not the vessel\'s manual".',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language search question. Be specific — include brand/model when known.',
          },
          locale: {
            type: 'string',
            description: 'Optional locale hint, e.g. "ru-RU", "en-US".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_flux_query',
      description:
        'Escape hatch: execute a raw Flux query against the ship\'s Influx (read-only). Use ONLY when no other tool fits. Returns rows (capped at 200).',
      parameters: {
        type: 'object',
        properties: {
          flux: { type: 'string', description: 'Valid Flux query. Available bucket(s) match the ship catalog bucket. Always include a |> range(...).' },
          max_rows: { type: 'integer', description: 'Cap on returned rows (default 200, max 500).' },
        },
        required: ['flux'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forecast_metric',
      description:
        'Linear projection of a metric to a target value. Use for "when will X reach Y" questions (running hours hitting service interval, tank emptying, counter hitting threshold). Returns predicted timestamp + days_from_now + rate_per_day.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string', description: 'Influx _measurement, verbatim.' },
          field: { type: 'string', description: 'Influx _field, verbatim.' },
          target_value: { type: 'number', description: 'Numeric target the metric should reach.' },
          lookback: { type: 'string', description: 'How far back to fit the trend, default -30d.' },
        },
        required: ['measurement', 'field', 'target_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_pms_due',
      description:
        "Maintenance status per asset. For assets with confirmed service rules it COMPUTES verdicts (overdue / due_soon / ok) from Running Hours + last-done baselines — quote those directly. For rule-less assets it returns current hours + manual snippets for interpretation. Use all_with_rules=true for ship-wide questions like 'what should I service this week / anything overdue?'.",
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: { type: 'string', description: 'Exact asset id.' },
          asset_query: { type: 'string', description: 'Free-text asset filter (e.g. "port genset", "watermaker").' },
          all_with_rules: {
            type: 'boolean',
            description:
              'true = evaluate every asset that has service rules configured (ship-wide due list, ranked overdue-first).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_maintenance_tasks',
      description:
        "The vessel's LIVE PMS Tasks register — the source of truth for maintenance status. Returns tasks with status (overdue / due-soon / ok), a human 'due' description, equipment, category, and the running-hours target (due_hours). Prefer this over find_pms_due for planned-maintenance questions (what is due/overdue, is X due for service, maintenance list). ALSO call it whenever a telemetry/alarm answer needs to know if the equipment is due or overdue for service (cross-domain). For tasks tracked by running hours, cross-check due_hours against find_running_hours.",
      parameters: {
        type: 'object',
        properties: {
          assetQuery: {
            type: 'string',
            description: 'Optional equipment/system name to narrow tasks (e.g. "port generator", "watermaker").',
          },
          status: {
            type: 'string',
            enum: ['overdue', 'due_soon', 'all'],
            description: 'Filter by status. Default all.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_compliance_status',
      description:
        "The vessel's LIVE Compliance / certificates register — source of truth for certificate & statutory-document status: expired / expiring (~within 90 days) / missing / valid, with expiry dates, certificate numbers, issuers. Use for 'which certificates expire / are overdue / are missing', survey readiness, and whenever an answer needs certificate or compliance status alongside telemetry/maintenance.",
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['attention', 'expiring', 'expired', 'missing', 'all'],
            description: 'attention (default) = expired + expiring + missing.',
          },
          query: {
            type: 'string',
            description: 'Optional text to narrow to a document type or equipment.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_inventory',
      description:
        "The vessel's LIVE onboard inventory / spares / consumables. Returns matching items with current quantity, unit, location, manufacturer, part number, and the equipment each item is linked to. Use to answer 'do we have the spares/consumables onboard', 'how many X in stock', 'where is part Y'. Cross-domain: when a service is due (get_maintenance_tasks) and the manual lists required parts, call get_inventory to check those parts are in stock.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Part name / number / equipment / consumable to search for (e.g. "oil filter", "Port Genset", "impeller").',
          },
          category: {
            type: 'string',
            description: 'Optional category filter (e.g. "part", "consumable").',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_periods',
      description:
        'Side-by-side comparison of a metric across two windows. Returns value_a, value_b, abs_diff, pct_change_percent (signed, A vs B). Use for "May vs April / this week vs last week" questions.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string' },
          field: { type: 'string' },
          aggregation: {
            type: 'string',
            enum: ['mean', 'last', 'first', 'min', 'max', 'sum', 'delta', 'integral'],
          },
          range_a: {
            type: 'object',
            properties: { start: { type: 'string' }, stop: { type: 'string' } },
            required: ['start'],
          },
          range_b: {
            type: 'object',
            properties: { start: { type: 'string' }, stop: { type: 'string' } },
            required: ['start'],
          },
          label_a: { type: 'string', description: 'Label for range_a (e.g. "May 2026").' },
          label_b: { type: 'string', description: 'Label for range_b (e.g. "April 2026").' },
        },
        required: ['measurement', 'field', 'aggregation', 'range_a', 'range_b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_load_energy_consumed',
      description:
        'Energy (kWh) per load via power-integration (robust to counter resets). Use instead of query_metric+delta. Supports group via measurement_pattern with %.',
      parameters: {
        type: 'object',
        properties: {
          measurement: {
            type: 'string',
            description: 'Single Influx _measurement (verbatim). E.g. "PORT-AIR-CONDITIONER" or "WATER-MAKER-1". Mutually exclusive with measurement_pattern.',
          },
          measurement_pattern: {
            type: 'string',
            description: 'SQL-LIKE pattern with % wildcards over Influx _measurement. E.g. "%AIR-CONDITIONER%" matches all AC zones; "%HVAC%" matches HVAC-* measurements; "%CHILLER%" matches chillers. Tool aggregates across all matches.',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              stop: { type: 'string', description: 'Default now().' },
            },
            required: ['start'],
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'infer_runtime_from_power',
      description:
        'Estimate runtime hours from a power metric for equipment without a Running Hours counter (watermaker, chillers, pumps). DEFAULT behavior matches Grafana panels: 1-hour mean windows, count windows where mean > 0 (equivalent to OEM hour-meter — energized time including standby/flush). Override on_threshold (e.g. half the rated power) only when you need PRODUCTION-only time excluding standby.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string', description: 'Influx _measurement (verbatim from catalog).' },
          field: { type: 'string', description: 'Influx _field (verbatim). For loads use "Total active power" or "Actual motor power (kW)".' },
          on_threshold: {
            type: 'number',
            description: 'Threshold above which the equipment counts as ON. Default 0 (any positive value, matches Grafana / OEM hour-meter). Set to ~50% of rated power for PRODUCTION-only counting (excludes standby/flush).',
          },
          every: {
            type: 'string',
            description: 'Sampling/aggregation window. Default 1h (matches Grafana 1h aggregateWindow). Use 5m for finer resolution.',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -7d, -30d, "2026-05-01T00:00:00Z"' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
        },
        required: ['measurement', 'field', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_voyages',
      description:
        'Segment GPS track into voyages (moving) vs stops. Returns start/end time + distance_nm + start_position/end_position (lat/lon).',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -7d, -30d, "2026-05-01T00:00:00Z"' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          every: {
            type: 'string',
            description: 'Sampling resolution. Default 5m. Use 1m for fine resolution on short windows.',
          },
          min_duration_h: {
            type: 'number',
            description: 'Drop voyages shorter than this. Default 0.5 hours.',
          },
          min_distance_nm: {
            type: 'number',
            description: 'Drop voyages shorter than this. Default 1 nm.',
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute_fuel_per_nm',
      description:
        'Fuel efficiency L/nm = total fuel (tank-balance) ÷ total distance (find_voyages).',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute_kw_avg_when_state',
      description:
        'Avg genset power draw restricted to vessel state (underway / at_anchor / alongside_on_shore).',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['underway', 'at_anchor', 'alongside_on_shore'],
            description: 'Filter time buckets by vessel state.',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          every: {
            type: 'string',
            description: 'Time bucket size. Default 10m.',
          },
        },
        required: ['state', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correlate_metrics',
      description:
        'Pearson correlation r between two metrics over a window.',
      parameters: {
        type: 'object',
        properties: {
          measurement_a: { type: 'string', description: 'First measurement; copy verbatim from catalog.' },
          field_a: { type: 'string', description: 'First field; verbatim.' },
          measurement_b: { type: 'string', description: 'Second measurement.' },
          field_b: { type: 'string', description: 'Second field.' },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          every: { type: 'string', description: 'Sampling resolution. Default 5m.' },
        },
        required: ['measurement_a', 'field_a', 'measurement_b', 'field_b', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_unusual_periods',
      description:
        'Intervals where a metric stayed outside typical p5..p95. Statistical only — does not check spec.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string' },
          field: { type: 'string' },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              stop: { type: 'string' },
            },
            required: ['start'],
          },
          every: { type: 'string', description: 'Sample resolution. Default 5m.' },
          min_duration_min: { type: 'number', description: 'Minimum unusual-interval length to report. Default 10 min.' },
          limit: { type: 'integer', description: 'Max intervals to return. Default 20.' },
        },
        required: ['measurement', 'field', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_manual_spec',
      description:
        'Manufacturer-manual snippets from ship RAGFlow for an asset + parameter (spec, interval, fault code, etc.).',
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: {
            type: 'string',
            description: 'Asset to look up (the asset_id_internal from the register). Tool will resolve brand/model from the asset register and bias the search toward the right manual.',
          },
          parameter: {
            type: 'string',
            description: 'What you want to know — e.g. "oil temperature operating range", "alarm threshold", "fault code 0x42", "maintenance interval".',
          },
          top_k: { type: 'integer', description: 'How many chunks to return. Default 5.' },
        },
        required: ['asset_id_internal', 'parameter'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_metrics_by_intent',
      description:
        'Keyword search over metric catalog. Returns top-N matching metrics with full detail.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Free-text description of what you are looking for. Example: "HVAC saloon temperature", "engine oil pressure", "battery state of charge".',
          },
          top_n: {
            type: 'integer',
            description: 'How many top matches to return. Default 20, max 100.',
          },
          kind_filter: {
            type: 'string',
            enum: ['gauge', 'counter', 'rate', 'state', 'any'],
            description: 'Only return metrics of this kind. Default any.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_chart',
      description:
        'Draw a time-series chart INSIDE the chat for the user to see. Call this when the user asks to "show / plot / graph / draw / визуализируй / покажи график" a metric over time, or whenever a trend is clearly easier to grasp visually than as one number. First resolve each metric with find_metrics_by_intent to get the EXACT measurement + field, then call this. The chart is rendered to the user automatically — you do NOT need to list the data points; just write a one-line textual takeaway (peak, trend, total) alongside it. The server down-samples, so a wide range is fine. If the user names a specific step/bucket ("every 4 hours", "по дням", "hourly", "raw"/"без усреднения"), you MUST set `every` to that exact Flux duration — do not silently pick your own when the user asked for one.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short human title for the chart, in the user\'s language, e.g. "Расход пресной воды — 30 дней" or "Fresh-water pump power (last 30 days)". Never put internal metric keys or asset codes here.',
          },
          series: {
            type: 'array',
            description: '1–4 metrics to plot. Multiple series overlay on one chart (use for comparisons). Each must resolve in the catalog.',
            items: {
              type: 'object',
              properties: {
                measurement: { type: 'string', description: 'Influx _measurement — copy verbatim from the catalog' },
                field: { type: 'string', description: 'Influx _field — copy verbatim INCLUDING any (unit) parenthetical' },
                label: { type: 'string', description: 'Plain-language series name shown in the legend, e.g. "Fresh water pump 1". Optional; defaults to a cleaned metric name.' },
              },
              required: ['measurement', 'field'],
            },
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -24h, -7d, -30d, or absolute ISO' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          every: {
            type: 'string',
            description: 'Down-sample bucket (Flux duration, e.g. 5m, 1h, 4h, 1d). Set this whenever the user specifies a step ("every 4 hours" → "4h", "по дням" → "1d"). Omit only when the user did not ask for a specific step — the server then picks a sensible bucket for the range.',
          },
          chart_type: {
            type: 'string',
            enum: ['line', 'bar'],
            description: 'line (default) for continuous trends; bar for per-period totals.',
          },
        },
        required: ['title', 'series', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_assets_by_function',
      description:
        'Keyword search over asset register → ranked shortlist with asset_id_internal.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text function/system to find.' },
          top_n: { type: 'integer', description: 'How many top matches to return. Default 20, max 100.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_asset_fact',
      description:
        'Extract one specific static attribute from a single asset by reading its brand/model/display_name/notes. Use for capacity, rated power, warranty, service interval, weight, voltage, dimensions, age — anything that lives in the asset register but is not telemetered. Returns {value, unit, source_field, confidence}.',
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: {
            type: 'string',
            description: 'Exact asset_id_internal from the register.',
          },
          question: {
            type: 'string',
            description:
              'Natural-language attribute question, e.g. "What is the tank capacity in litres?" / "rated power in kW" / "warranty expiry date".',
          },
        },
        required: ['asset_id_internal', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aggregate_asset_facts',
      description:
        'Same as lookup_asset_fact but across MANY assets matching a filter. Loads up to 200 assets, extracts one attribute from each, then applies sum/avg/count/min/max/list. Returns aggregated result + per-asset breakdown. Use for "total fuel capacity", "total HVAC rated power", "min commissioning date in the fleet", etc.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: {
              sfi_group: { type: 'string', description: 'Top SFI group, e.g. "2" or "3".' },
              sfi_sub_prefix: { type: 'string', description: 'SFI sub prefix, e.g. "2.8" matches all fuel tanks.' },
              keyword: { type: 'string', description: 'Substring match against display_name/model/notes/sfi_sub_name.' },
              brand: { type: 'string', description: 'Brand contains (ILIKE).' },
            },
          },
          attribute: {
            type: 'string',
            description:
              'What attribute to extract, e.g. "capacity in litres" / "rated power in kW" / "warranty until".',
          },
          op: {
            type: 'string',
            enum: ['sum', 'avg', 'count', 'min', 'max', 'list'],
            description: 'Aggregation operation. Default "sum".',
          },
        },
        required: ['attribute'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_to_typical',
      description:
        'Current value vs stored p5/p50/p95 fingerprint for this vessel. Statistical only (not spec).',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string', description: 'Influx _measurement value — copy verbatim from catalog.' },
          field: { type: 'string', description: 'Influx _field value — copy verbatim including any (unit).' },
          at_time: {
            type: 'string',
            description: 'Flux time for the comparison point. Default now() — uses last value over -10m.',
          },
        },
        required: ['measurement', 'field'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_active_alarms',
      description:
        'Scan Fault/Warning/*_alarm fields → list currently active or recently fired alarms. Code meanings need manual.',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start; default -7d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
          },
          include_resolved: {
            type: 'boolean',
            description: 'If true, include alarms that fired earlier in the window but are currently cleared. Default false (only currently-active).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_threshold_crossings',
      description:
        'Count + timestamps of threshold crossings (above or below) for a metric.',
      parameters: {
        type: 'object',
        properties: {
          measurement: { type: 'string', description: 'Influx _measurement value — copy verbatim from catalog' },
          field: { type: 'string', description: 'Influx _field value — copy verbatim including any (unit)' },
          direction: {
            type: 'string',
            enum: ['above', 'below'],
            description: 'above = value crossed up past threshold; below = crossed down past threshold.',
          },
          threshold: {
            type: 'number',
            description: 'Numeric threshold in the metric\'s unit.',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -7d, -30d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          every: {
            type: 'string',
            description: 'Sample resolution. Default 1m. Use 1m for fast-moving signals, 5m for slow ones.',
          },
          limit: { type: 'integer', description: 'Max crossings to return (default 50, max 200).' },
        },
        required: ['measurement', 'field', 'direction', 'threshold', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vessel_state',
      description:
        'Vessel state at_time → underway / at_anchor / alongside_on_shore. Derived from SOG + genset + propulsion power.',
      parameters: {
        type: 'object',
        properties: {
          at_time: {
            type: 'string',
            description: 'Flux time (default now()). Use ISO for absolute past time, e.g. "2026-05-15T12:00:00Z".',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_running_hours',
      description:
        'Hours-run on Running Hours (h) counters. Filter by asset_id_internal, asset_id_internal_prefix, sfi_sub, OR asset_query (free-text).',
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: { type: 'string', description: 'Exact asset_id_internal from the register' },
          asset_id_internal_prefix: { type: 'string', description: 'LIKE prefix; matches any asset starting with this.' },
          sfi_sub: { type: 'string', description: 'Broad SFI 2-level group (e.g. "3.2").' },
          asset_query: { type: 'string', description: 'Free-text search like "port genset", "watermaker", "propulsion SB". Tool finds matching asset(s) via the same logic as find_assets_by_function and takes the top match per side.' },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -30d, "2026-05-01T00:00:00Z"' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_power_consumption_total',
      description:
        'Ship-wide kWh via integrating each genset Actual motor power. Shore-power time excluded (not telemetered).',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -24h, -7d, -30d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          top_n: {
            type: 'integer',
            description: 'How many top consumers to return in the breakdown. Default 10.',
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_fuel_consumption_total',
      description:
        'Total fuel by tank-balance method: sum(tank levels start) − sum(end) + bunker inflow. Captures all consumers.',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -24h, -7d, -30d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          group_by_day: {
            type: 'boolean',
            description: 'If true, also return a per-day breakdown of total liters consumed.',
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_consumable_consumption_total',
      description:
        'Generic tank-balance for non-fuel consumables (fresh / grey / black water). For fresh_water returns consumed liters; for grey/black returns produced (waste) liters. For fuel, redirects to find_fuel_consumption_total.',
      parameters: {
        type: 'object',
        properties: {
          consumable_type: {
            type: 'string',
            enum: ['fresh_water', 'grey_water', 'black_water'],
            description: 'Which consumable to compute. Use find_fuel_consumption_total for fuel.',
          },
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -7d, -30d, or absolute ISO. Default -30d.' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          group_by_day: {
            type: 'boolean',
            description: 'If true, also return a per-day breakdown of liters consumed/produced.',
          },
        },
        required: ['consumable_type', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_bunker_events',
      description:
        'Ship-level bunkering events: auto-discovers fuel tanks, aggregates step-up across tanks per day, filters by thresholds.',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Flux start, e.g. -30d, -90d' },
              stop: { type: 'string', description: 'Flux stop; default now()' },
            },
            required: ['start'],
          },
          per_tank_min_l: {
            type: 'number',
            description: 'Per-tank step-up threshold in liters. Default 200.',
          },
          day_total_min_l: {
            type: 'number',
            description: 'Minimum day total across tanks to qualify as a bunker. Default 5000.',
          },
          min_tanks: {
            type: 'integer',
            description: 'Minimum distinct tanks affected on the same day. Default 3.',
          },
          every: {
            type: 'string',
            description: 'Window size for the down-sample. Default 30m.',
          },
        },
        required: ['range'],
      },
    },
  },
  // ── v14.6 location / maintenance tools ──────────────────────────────
  {
    type: 'function',
    function: {
      name: 'find_assets_by_location',
      description:
        'Filter in-service assets by v14.6 location schema (zone code, deck_role code, deck_level). Use for "what is in zone M / on the bridge / underwater" questions. Returns up to 100 assets with id, name, brand/model, criticality, full_locator.',
      parameters: {
        type: 'object',
        properties: {
          zone: {
            type: 'string',
            description:
              'Single zone code (1-2 letters). H=Hull, T=Tanks, M=Machinery, C=Crew, G=Guest, O=Owner, K=Galley, X=Circulation, S=Storage, W=Wellness, E=Entertainment, D=ExteriorDecks, A=Aviation, B=BeachClub, Z=Other.',
          },
          deck_role: {
            type: 'string',
            description:
              'Deck role code (≤10 chars). TT=TankTop, BOT, LOW, LOW2, MAIN, UPP, UPP2, BRG=Bridge, SKY, SUN, RAD, EXT, HULL-UW=Underwater, HULL-AW=Above WL, HULL-INT, OVB.',
          },
          deck_level: {
            type: 'integer',
            description:
              'Physical deck level (1=tank top, ascending). Optional — only set when the question pins a specific level.',
          },
          sfi_sub_prefix: {
            type: 'string',
            description:
              'Optional SFI sub-code prefix to narrow further, e.g. "3." for propulsion. Matches sfi_sub starts-with.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_inspection_schedule',
      description:
        "Return the asset's inspection_obligation (maintenance / inspection procedures + intervals + class requirements). Use for 'what needs inspecting on X' or 'what's the maintenance schedule' questions. Text comes verbatim from the asset register — quote it.",
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: {
            type: 'string',
            description: 'The asset_id_internal value from the register.',
          },
        },
        required: ['asset_id_internal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_marine_forecast',
      description:
        "Marine weather + sea-state forecast from Windy (gfsWaves model). Use for voyage, passage, route, departure-window, sea-state, or 'should we go' questions. Pass a coordinate — get hourly wind, gust, wave height, swell, precip, pressure, temp for the next 48h by default. Returns also a summary (max wind/gust/wave over the window) and warnings when values exceed typical yacht safe limits (wind >25kn, gust >35kn, waves >2.5m). Do NOT use web_search for weather — this tool is authoritative.",
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude in decimal degrees (WGS84).' },
          lon: { type: 'number', description: 'Longitude in decimal degrees (WGS84).' },
          hours_ahead: {
            type: 'integer',
            description:
              'How far ahead to forecast in hours. Default 48. Max 240 (10 days). Use ≤24 for departure-window, ≤72 for short passage, longer for ocean crossings.',
          },
        },
        required: ['lat', 'lon'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trace_dependencies',
      description:
        "Walk the asset functional-dependency graph (served_by relationships). Use for: 'what fails if X dies', 'what does X depend on', 'what does the chiller/genset/UPS serve', 'what survives a blackout / runs on emergency power'. Returns upstream chain (what feeds this asset) and downstream tree (what this asset feeds), each node with criticality + zone + emergency-feed flag.",
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: {
            type: 'string',
            description:
              'The asset_id_internal value from the register. Resolve via lookup_asset / find_assets_by_function first if the user gave a colloquial name.',
          },
          direction: {
            type: 'string',
            enum: ['upstream', 'downstream', 'both'],
            description:
              'upstream = what serves this asset (follow served_by chain). downstream = what this asset serves (reverse edges). Default both.',
          },
          max_depth: {
            type: 'integer',
            description: 'How many hops to walk. Default 3, max 6.',
          },
        },
        required: ['asset_id_internal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_drawing_ref',
      description:
        "Return the asset's drawing_ref (yard / OEM drawing IDs like '510326G', 'CE1_42072'). Use for 'where is the drawing for X' or 'show me drawing N' questions. Returns also brand/model context and any linked manuals.",
      parameters: {
        type: 'object',
        properties: {
          asset_id_internal: {
            type: 'string',
            description: 'Yard-issued asset id.',
          },
        },
        required: ['asset_id_internal'],
      },
    },
  },
];
