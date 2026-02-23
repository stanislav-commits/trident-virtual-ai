import type { Role } from '@prisma/client';

export class CreateUserDto {
  role: Role;
}
