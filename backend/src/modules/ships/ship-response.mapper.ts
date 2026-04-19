import { ShipEntity } from './entities/ship.entity';

export interface ShipResponseDto {
  id: string;
  name: string;
  organizationName: string | null;
  imoNumber: string | null;
  buildYear: number | null;
  createdAt: string;
  updatedAt: string;
}

export function toShipResponse(ship: ShipEntity): ShipResponseDto {
  return {
    id: ship.id,
    name: ship.name,
    organizationName: ship.organizationName,
    imoNumber: ship.imoNumber,
    buildYear: ship.buildYear,
    createdAt: ship.createdAt.toISOString(),
    updatedAt: ship.updatedAt.toISOString(),
  };
}
