import { Module } from '@nestjs/common';
import { InfluxdbModule } from '../influxdb/influxdb.module';
import { MetricsSyncScheduler } from './metrics-sync.scheduler';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [InfluxdbModule],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsSyncScheduler],
  exports: [MetricsService],
})
export class MetricsModule {}
