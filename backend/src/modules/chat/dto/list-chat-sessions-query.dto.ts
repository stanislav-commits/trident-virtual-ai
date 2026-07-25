import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class ListChatSessionsQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Scope the history to one vessel. An admin switches vessels constantly,
   * and a single mixed list made it impossible to tell which ship a chat was
   * about. Sessions with no ship recorded (everything created before chats
   * were vessel-scoped) stay visible under every vessel so no history
   * disappears.
   */
  @IsOptional()
  @IsUUID()
  shipId?: string;

  @IsOptional()
  @IsString()
  cursor?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
