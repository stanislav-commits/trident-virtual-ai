import { UserRole } from '../../common/enums/user-role.enum';

export interface AuthenticatedUser {
  id: string;
  userId: string;
  role: UserRole;
  shipId: string | null;
  name: string | null;
}

export interface JwtPayload {
  sub: string;
  userId: string;
  role: UserRole;
  shipId: string | null;
}
