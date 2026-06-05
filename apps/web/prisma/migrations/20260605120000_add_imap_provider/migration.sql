-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "imapHost" TEXT,
ADD COLUMN     "imapPassword" TEXT,
ADD COLUMN     "imapPort" INTEGER,
ADD COLUMN     "imapSecure" BOOLEAN DEFAULT true,
ADD COLUMN     "imapUsername" TEXT,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpSecure" BOOLEAN DEFAULT true;

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "imapFolderState" JSONB,
ADD COLUMN     "imapSpecialFolders" JSONB;

-- CreateTable
CREATE TABLE "ImapMessage" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "uid" BIGINT NOT NULL,
    "messageIdHdr" TEXT,
    "threadId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" TEXT,
    "fromAddr" TEXT NOT NULL,
    "subject" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "flagsSeen" BOOLEAN NOT NULL DEFAULT false,
    "flagsFlagged" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "snippet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImapMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_threadId_idx" ON "ImapMessage"("emailAccountId", "threadId");

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_messageIdHdr_idx" ON "ImapMessage"("emailAccountId", "messageIdHdr");

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_fromAddr_idx" ON "ImapMessage"("emailAccountId", "fromAddr");

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_folder_idx" ON "ImapMessage"("emailAccountId", "folder");

-- CreateIndex
CREATE INDEX "ImapMessage_emailAccountId_date_idx" ON "ImapMessage"("emailAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ImapMessage_emailAccountId_folder_uidValidity_uid_key" ON "ImapMessage"("emailAccountId", "folder", "uidValidity", "uid");

-- AddForeignKey
ALTER TABLE "ImapMessage" ADD CONSTRAINT "ImapMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

