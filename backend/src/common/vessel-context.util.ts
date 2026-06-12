import { Repository } from 'typeorm';
import { AssetEntity } from '../modules/assets/entities/asset.entity';
import { ShipEntity } from '../modules/ships/entities/ship.entity';

/**
 * Builds a short, vessel-specific summary that callers can paste into prompts
 * (web-search, LLM tool descriptions, etc.) to scope answers to THIS vessel.
 *
 * Pure function (no NestJS DI) — pass the repositories directly. Lives in
 * /common/ so both `ships` and `metrics` modules can use it without creating
 * a circular module-level dependency (ships → metrics is already established
 * by MetricsCatalogService consumers; adding metrics → ships would cycle).
 *
 * Returns null when the ship cannot be resolved — callers should treat the
 * absence as "no vessel context, answer generically".
 */
export async function buildVesselContextString(
  shipRepository: Repository<ShipEntity>,
  assetRepository: Repository<AssetEntity>,
  shipId: string,
): Promise<string | null> {
  const ship = await shipRepository.findOne({ where: { id: shipId } });
  if (!ship) return null;

  const parts: string[] = [];
  const header = [
    ship.name,
    ship.organizationName ? `(${ship.organizationName})` : null,
    ship.imoNumber ? `IMO ${ship.imoNumber}` : null,
    ship.buildYear ? `built ${ship.buildYear}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (header) parts.push(header + '.');

  const critical = await assetRepository
    .createQueryBuilder('a')
    .where('a.ship_id = :shipId', { shipId })
    .andWhere(`a.lifecycle_status = 'in-service'`)
    .andWhere('a.brand IS NOT NULL OR a.model IS NOT NULL')
    .orderBy('a.criticality', 'DESC', 'NULLS LAST')
    .addOrderBy('a.sfi_group', 'ASC')
    .limit(20)
    .getMany();

  if (critical.length > 0) {
    const equipment = critical
      .slice(0, 12)
      .map((a) => {
        const brandModel = [a.brand, a.model].filter(Boolean).join(' ');
        const name = a.displayName?.split('—')[0]?.trim() ?? a.displayName;
        return `${name}${brandModel ? ` (${brandModel})` : ''}`;
      })
      .join('; ');
    parts.push(`Key equipment: ${equipment}.`);
  }

  return parts.join(' ');
}
