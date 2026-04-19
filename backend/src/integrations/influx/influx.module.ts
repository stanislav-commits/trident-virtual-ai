import { Module } from '@nestjs/common';
import { InfluxHttpService } from './influx-http.service';
import { InfluxService } from './influx.service';

@Module({
  providers: [InfluxHttpService, InfluxService],
  exports: [InfluxHttpService, InfluxService],
})
export class InfluxModule {}
