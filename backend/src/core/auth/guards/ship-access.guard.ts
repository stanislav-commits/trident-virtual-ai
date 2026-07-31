import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth.types';
import { UserRole } from '../../../common/enums/user-role.enum';

/**
 * Cross-cutting per-ship access check for `ships/:shipId/*` routes (and any
 * route with a `:shipId` param). RolesGuard only inspects the role, so before
 * this guard existed any authenticated user could name any shipId on a read
 * endpoint. Admins see every vessel; a user sees only the one they are
 * assigned to. The mismatch answers 404, not 403 — same convention as
 * DocumentsService / ShipsQueryService — so a foreign shipId does not reveal
 * that the vessel exists.
 *
 * Routes without a `:shipId` param pass through, which makes the guard safe
 * to apply at class level on controllers that mix scoped and unscoped routes.
 * It must run after JwtAuthGuard (it reads `request.user`).
 */
@Injectable()
export class ShipAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      params?: { shipId?: string };
    }>();

    const shipId = request.params?.shipId;
    if (!shipId) {
      return true;
    }

    const user = request.user;
    if (!user) {
      return false;
    }

    if (user.role === UserRole.ADMIN || user.shipId === shipId) {
      return true;
    }

    throw new NotFoundException('Ship not found');
  }
}
