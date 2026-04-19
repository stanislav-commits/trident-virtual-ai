import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { SearchWebDto } from './dto/search-web.dto';
import { WebService } from './web.service';

@Controller('web')
@UseGuards(JwtAuthGuard)
export class WebController {
  constructor(private readonly webService: WebService) {}

  @Post('search')
  search(@Body() body: SearchWebDto) {
    return this.webService.search(body);
  }
}
