import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { PmsService, UpsertPmsTaskInput } from './pms.service';
import { AssetHoursService, SetHoursConfigInput } from './asset-hours.service';
import {
  PmsImportService,
  PmsImportDraft,
  PmsImportMode,
} from './pms-import.service';
import { CrewService } from '../crew/crew.service';

interface UploadedImportFile {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
}

@Controller('ships/:shipId/pms')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PmsController {
  constructor(
    private readonly pmsService: PmsService,
    private readonly assetHoursService: AssetHoursService,
    private readonly pmsImportService: PmsImportService,
    private readonly crewService: CrewService,
  ) {}

  @Get('tasks')
  async list(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pmsService.list(shipId, await this.viewerDept(shipId, user));
  }

  @Get('assets/:assetId/tasks')
  async listForAsset(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pmsService.listForAsset(
      shipId,
      assetId,
      await this.viewerDept(shipId, user),
    );
  }

  /**
   * The department a viewer is gated to, or undefined for no gating.
   * - admin / sees-all crew (Captain) → undefined (everything)
   * - rostered crew → their department
   * - logged-in but not on the roster → '__none__' (general tasks only)
   */
  private async viewerDept(
    shipId: string,
    user: AuthenticatedUser,
  ): Promise<string | undefined> {
    if (user.role === UserRole.ADMIN) return undefined;
    const access = await this.crewService.accessFor(shipId, user.id);
    if (access?.seesAll) return undefined;
    return access ? access.department : '__none__';
  }

  @Post('tasks')
  @Roles(UserRole.ADMIN)
  create(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: UpsertPmsTaskInput,
  ) {
    return this.pmsService.create(shipId, body);
  }

  @Patch('tasks/:id')
  @Roles(UserRole.ADMIN)
  update(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Partial<UpsertPmsTaskInput>,
  ) {
    return this.pmsService.update(shipId, id, body);
  }

  @Post('tasks/:id/complete')
  @Roles(UserRole.ADMIN)
  complete(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { doneAtHours?: number | null; doneOn?: string | null },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pmsService.complete(shipId, id, body, user);
  }

  @Get('assets/:assetId/hours')
  hoursConfig(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.assetHoursService.getConfig(shipId, assetId);
  }

  @Put('assets/:assetId/hours')
  @Roles(UserRole.ADMIN)
  setHoursConfig(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: SetHoursConfigInput,
  ) {
    return this.assetHoursService.setConfig(shipId, assetId, body);
  }

  @Post('assets/:assetId/hours/readings')
  @Roles(UserRole.ADMIN)
  addHoursReading(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: { hours: number; readOn?: string; note?: string | null },
  ) {
    return this.assetHoursService.addReading(shipId, assetId, body);
  }

  // ── Import (AI-mapped) ──

  @Post('import/preview')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  importPreview(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFile() file: UploadedImportFile | undefined,
    @Body() body: { text?: string; mode?: PmsImportMode },
  ) {
    return this.pmsImportService.preview(
      shipId,
      file ?? null,
      body?.text,
      body?.mode === 'history' ? 'history' : 'tasks',
    );
  }

  @Post('import/commit')
  @Roles(UserRole.ADMIN)
  importCommit(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: { drafts: PmsImportDraft[]; mode?: PmsImportMode },
  ) {
    return this.pmsImportService.commit(
      shipId,
      body?.drafts ?? [],
      body?.mode === 'history' ? 'history' : 'tasks',
    );
  }

  /** Suggest PMS tasks for an asset from its manual's extracted text. */
  @Post('assets/:assetId/suggest')
  @Roles(UserRole.ADMIN)
  suggestFromManual(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: { text: string },
  ) {
    return this.pmsImportService.suggestFromManual(
      shipId,
      assetId,
      body?.text ?? '',
    );
  }

  @Delete('tasks/:id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.pmsService.remove(shipId, id);
  }
}
