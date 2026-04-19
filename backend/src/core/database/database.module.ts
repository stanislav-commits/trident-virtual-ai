import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const sslEnabled = configService.get<boolean>('database.ssl', false);
        const sslRejectUnauthorized = configService.get<boolean>(
          'database.sslRejectUnauthorized',
          true,
        );

        return {
          type: 'postgres' as const,
          host: configService.getOrThrow<string>('database.host'),
          port: configService.getOrThrow<number>('database.port'),
          database: configService.getOrThrow<string>('database.name'),
          username: configService.getOrThrow<string>('database.user'),
          password: configService.getOrThrow<string>('database.password'),
          autoLoadEntities: true,
          synchronize: false,
          migrationsRun: false,
          logging:
            configService.get<string>('app.environment') === 'development' ? ['error'] : false,
          ssl: sslEnabled
            ? {
                rejectUnauthorized: sslRejectUnauthorized,
              }
            : undefined,
        };
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
