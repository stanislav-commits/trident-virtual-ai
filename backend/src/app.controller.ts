import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller()
export class AppController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  getInfo() {
    return {
      name: this.configService.get<string>('app.name', 'trident-virtual-ai-backend'),
      environment: this.configService.get<string>('app.environment', 'development'),
      version: '0.1.0',
      architecture: {
        style: 'nest-monolith-modular',
        modules: [
          'chat',
          'planner',
          'composer',
          'executors',
          'metrics',
          'documents',
          'web',
          'admin',
        ],
      },
    };
  }
}
