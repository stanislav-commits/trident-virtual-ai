import { IsOptional, IsString } from 'class-validator';

export class UpdateUserNameDto {
  @IsOptional()
  @IsString()
  name?: string | null;
}
