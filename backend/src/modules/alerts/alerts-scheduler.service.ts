import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ComplianceService } from '../compliance/compliance.service';
import { AlertsService } from './alerts.service';

/**
 * Daily reconciliation of certificate-expiry reminder alerts. For every real
 * vessel it asks the compliance register which certificates are expiring (or
 * expired) and upserts/resolves matching `certificate`-source alerts so they
 * surface in the same bell as metric alarms, gated by the access matrix.
 */
@Injectable()
export class AlertsSchedulerService {
  private readonly logger = new Logger(AlertsSchedulerService.name);

  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    private readonly complianceService: ComplianceService,
    private readonly alertsService: AlertsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async syncCertificateAlerts(): Promise<{ ships: number; certs: number }> {
    const ships = await this.shipRepository.find({
      where: { isPlatform: false },
      select: ['id'],
    });
    let certTotal = 0;
    for (const ship of ships) {
      try {
        const certs = await this.complianceService.expiringCertificates(ship.id);
        await this.alertsService.reconcileCertificateAlerts(ship.id, certs);
        certTotal += certs.length;
      } catch (error) {
        this.logger.error(
          `Certificate-alert sync failed for ship ${ship.id}: ${String(error)}`,
        );
      }
    }
    this.logger.log(
      `Certificate-alert sync: ${ships.length} ships, ${certTotal} expiring/expired certs`,
    );
    return { ships: ships.length, certs: certTotal };
  }
}
