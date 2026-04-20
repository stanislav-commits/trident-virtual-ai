import { IsString, IsUUID } from 'class-validator';

export class UpdateUserShipDto {
  @IsUUID()
  @IsString()
  shipId!: string;
}
