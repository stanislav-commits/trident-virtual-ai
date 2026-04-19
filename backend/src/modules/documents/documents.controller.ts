import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('search')
  search(@Body() body: SearchDocumentsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.search({
      ...body,
      shipId: user.role === UserRole.ADMIN ? body.shipId : user.shipId ?? undefined,
    });
  }
}
