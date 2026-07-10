import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { UserRole } from '../../common/enums/user-role.enum';
import { AlertsService, GrafanaWebhookPayload } from './alerts.service';
import { AlertsSchedulerService } from './alerts-scheduler.service';
import { AccessControlService } from '../access-control/access-control.service';
import { ResourceCategory } from '../access-control/access-positions';

/**
 * Public webhook for Grafana's alerting contact point. No JWT — authenticated
 * by a shared secret (configure Grafana's webhook with header
 * `Authorization: Bearer <GRAFANA_WEBHOOK_SECRET>`).
 */
@Controller('alerts')
export class AlertsWebhookController {
  constructor(
    private readonly alertsService: AlertsService,
    private readonly configService: ConfigService,
    private readonly schedulerService: AlertsSchedulerService,
  ) {}

  @Post('grafana')
  async grafana(@Req() req: Request, @Body() body: GrafanaWebhookPayload) {
    this.assertSecret(req);
    return this.alertsService.ingest(body);
  }

  /** Admin: run the certificate-expiry reminder sync now (also runs daily). */
  @Post('sync-certificates')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  syncCertificates() {
    return this.schedulerService.syncCertificateAlerts();
  }

  private assertSecret(req: Request): void {
    const expected = this.configService.get<string>(
      'integrations.grafanaAlerts.webhookSecret',
    );
    if (!expected) return; // unset (dev) — accept; set it in prod
    const auth = req.headers['authorization'];
    const header =
      (Array.isArray(auth) ? auth[0] : auth) ??
      (req.headers['x-grafana-secret'] as string | undefined) ??
      '';
    const provided = header.replace(/^Bearer\s+/i, '').trim();
    if (provided !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
  }
}

/** Authenticated, ship-scoped read + acknowledge. */
@Controller('ships/:shipId/alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AlertsController {
  constructor(
    private readonly alertsService: AlertsService,
    private readonly accessControlService: AccessControlService,
  ) {}

  @Get()
  async list(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ) {
    const allowedSources = await this.allowedAlertSources(user, shipId);
    return this.alertsService.list(shipId, status, allowedSources);
  }

  /**
   * Which alert kinds this viewer may see in the bell, from the access matrix:
   * 'metric' (ALERTS) and/or 'certificate' (ALERTS_CERTIFICATES). Returns
   * undefined for admins / crew-unlinked users = no restriction.
   */
  private async allowedAlertSources(
    user: AuthenticatedUser,
    shipId: string,
  ): Promise<string[] | undefined> {
    if (user.role === UserRole.ADMIN) return undefined;
    const allowed = await this.accessControlService.allowedCategories(
      user.id,
      shipId,
    );
    if (!allowed) return undefined; // not crew-linked → no restriction
    const sources: string[] = [];
    if (allowed.has(ResourceCategory.ALERTS)) sources.push('metric');
    if (allowed.has(ResourceCategory.ALERTS_CERTIFICATES)) {
      sources.push('certificate');
    }
    return sources;
  }

  @Get('asset/:assetId')
  async listForAsset(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const allowedSources = await this.allowedAlertSources(user, shipId);
    return this.alertsService.listForAsset(shipId, assetId, allowedSources);
  }

  @Post(':id/ack')
  acknowledge(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.alertsService.acknowledge(shipId, id, user?.id ?? null);
  }
}
