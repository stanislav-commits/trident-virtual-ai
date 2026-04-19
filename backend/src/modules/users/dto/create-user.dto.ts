import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '../../../common/enums/user-role.enum';

export class CreateUserDto {
  @IsEnum(UserRole)
  role!: UserRole;

  @IsOptional()
  @IsString()
  shipId?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  userId?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
