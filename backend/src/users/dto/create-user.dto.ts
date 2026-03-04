import type { Role } from '@prisma/client';

export class CreateUserDto {
  role: Role;
  // Display name (first name + last name)
  name: string;
  // When creating a non-admin user, optionally bind them to a ship.
  // If ships exist in the system, providing `shipId` becomes required.
  shipId?: string;
}
