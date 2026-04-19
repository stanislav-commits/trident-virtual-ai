import { Injectable } from '@nestjs/common';
import { InfluxService } from '../../integrations/influx/influx.service';
import { SourceReferenceDto } from '../../common/dto/source-reference.dto';
import { QueryMetricsDto } from './dto/query-metrics.dto';

@Injectable()
export class MetricsService {
  constructor(private readonly influxService: InfluxService) {}

  getCatalog() {
    return {
      status: 'scaffolded',
      capabilities: [
        'semantic-concepts',
        'snapshot-values',
        'point-in-time-values',
        'comparisons',
        'aggregations',
      ],
      integration: this.influxService.getStatus(),
    };
  }

  async query(input: QueryMetricsDto): Promise<{
    summary: string;
    data: Record<string, unknown>;
    references: SourceReferenceDto[];
  }> {
    return {
      summary:
        'Metrics query pipeline is wired. Real InfluxDB execution will plug into this service next.',
      data: {
        normalizedQuestion: input.question,
        shipId: input.shipId ?? null,
        timeRange: input.timeRange ?? 'not-provided',
        executionState: 'pending-influx-wiring',
      },
      references: [
        {
          source: 'metrics',
          title: 'Telemetry adapter',
          snippet: 'Influx execution is not connected yet.',
        },
      ],
    };
  }
}
