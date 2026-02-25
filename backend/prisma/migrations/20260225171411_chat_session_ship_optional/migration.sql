-- DropForeignKey
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_ship_id_fkey";

-- AlterTable
ALTER TABLE "chat_sessions" ALTER COLUMN "ship_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "Ship"("id") ON DELETE SET NULL ON UPDATE CASCADE;
