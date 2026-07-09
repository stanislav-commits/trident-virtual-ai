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
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { AlertsService, GrafanaWebhookPayload } from './alerts.service';

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
  ) {}

  @Post('grafana')
  async grafana(@Req() req: Request, @Body() body: GrafanaWebhookPayload) {
    this.assertSecret(req);
    return this.alertsService.ingest(body);
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
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  list(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Query('status') status?: string,
  ) {
    return this.alertsService.list(shipId, status);
  }

  @Get('asset/:assetId')
  listForAsset(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.alertsService.listForAsset(shipId, assetId);
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
