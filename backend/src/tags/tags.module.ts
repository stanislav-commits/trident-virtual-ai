import { Module } from '@nestjs/common';
import { RagflowModule } from '../ragflow/ragflow.module';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { TagLinksService } from './tag-links.service';
import { TagMatcherService } from './tag-matcher.service';

@Module({
  imports: [RagflowModule],
  controllers: [TagsController],
  providers: [TagsService, TagMatcherService, TagLinksService],
  exports: [TagsService, TagMatcherService, TagLinksService],
})
export class TagsModule {}
