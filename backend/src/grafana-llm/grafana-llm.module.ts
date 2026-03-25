import { Module } from '@nestjs/common';
import { GrafanaLlmService } from './grafana-llm.service';

@Module({
  providers: [GrafanaLlmService],
  exports: [GrafanaLlmService],
})
export class GrafanaLlmModule {}
