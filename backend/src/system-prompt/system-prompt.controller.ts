import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UpdateSystemPromptDto } from './dto/update-system-prompt.dto';
import { SystemPromptService } from './system-prompt.service';

@Controller('system-prompt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SystemPromptController {
  constructor(private readonly systemPromptService: SystemPromptService) {}

  @Get()
  getSystemPrompt() {
    return this.systemPromptService.getSystemPrompt();
  }

  @Patch()
  updateSystemPrompt(
    @Body() dto: UpdateSystemPromptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.systemPromptService.updateSystemPrompt(dto.prompt, user.id);
  }
}
