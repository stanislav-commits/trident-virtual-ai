import { Module } from '@nestjs/common';
import { ComposerService } from './composer.service';

@Module({
  providers: [ComposerService],
  exports: [ComposerService],
})
export class ComposerModule {}
