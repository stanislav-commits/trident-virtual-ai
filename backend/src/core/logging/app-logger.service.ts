import { ConsoleLogger, Injectable } from '@nestjs/common';

@Injectable()
export class AppLoggerService extends ConsoleLogger {}
