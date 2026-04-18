import { Module } from '@nestjs/common';
import { AssistantCanonicalCopyService } from './assistant-canonical-copy.service';
import { AssistantFallbackWriterService } from './assistant-fallback-writer.service';
import { AssistantTextLocalizerService } from './assistant-text-localizer.service';

@Module({
  providers: [
    AssistantCanonicalCopyService,
    AssistantFallbackWriterService,
    AssistantTextLocalizerService,
  ],
  exports: [
    AssistantCanonicalCopyService,
    AssistantFallbackWriterService,
    AssistantTextLocalizerService,
  ],
})
export class AssistantTextModule {}
