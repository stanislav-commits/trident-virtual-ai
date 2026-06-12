import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateServiceRuleDto {
  @IsString()
  @MaxLength(160)
  taskName!: string;

  @IsOptional() @IsInt() @Min(1)
  intervalHours?: number;

  @IsOptional() @IsInt() @Min(1)
  intervalMonths?: number;

  @IsOptional() @IsDateString()
  lastDoneAt?: string;

  @IsOptional() @IsNumber()
  lastDoneRuntimeHours?: number;

  @IsOptional() @IsIn(['manual', 'ai_extracted'])
  source?: string;

  @IsOptional() @IsString()
  notes?: string;
}

export class UpdateServiceRuleDto {
  @IsOptional() @IsString() @MaxLength(160)
  taskName?: string;

  @IsOptional() @IsInt() @Min(1)
  intervalHours?: number | null;

  @IsOptional() @IsInt() @Min(1)
  intervalMonths?: number | null;

  @IsOptional() @IsDateString()
  lastDoneAt?: string | null;

  @IsOptional() @IsNumber()
  lastDoneRuntimeHours?: number | null;

  @IsOptional() @IsString()
  notes?: string | null;
}

/**
 * "Mark done" — closes a service: stamps lastDoneAt (now unless given)
 * and optionally the runtime-hours baseline read off the counter.
 */
export class CompleteServiceRuleDto {
  @IsOptional() @IsDateString()
  doneAt?: string;

  @IsOptional() @IsNumber()
  runtimeHours?: number;

  @IsOptional() @IsString()
  notes?: string;
}
