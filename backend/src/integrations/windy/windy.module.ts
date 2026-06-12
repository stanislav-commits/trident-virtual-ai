import { Module } from '@nestjs/common';
import { WindyClient } from './windy.client';

@Module({
  providers: [WindyClient],
  exports: [WindyClient],
})
export class WindyModule {}
