"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import { connectImapBody } from "@/utils/actions/imap.validation";
import prisma from "@/utils/prisma";
import { encryptToken } from "@/utils/encryption";
import { verifyImapConnection } from "@/utils/imap/connection";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { syncImapAccount } from "@/utils/imap/sync-account";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";

const logger = createScopedLogger("actions/imap");

export const connectImapAccountAction = actionClientUser
  .metadata({ name: "connectImapAccount" })
  .schema(connectImapBody)
  .action(async ({ ctx: { userId }, parsedInput }) => {
    const email = parsedInput.email.trim().toLowerCase();
    const username = parsedInput.imapUsername ?? email;

    try {
      await verifyImapConnection({
        host: parsedInput.imapHost,
        port: parsedInput.imapPort,
        secure: parsedInput.imapSecure,
        auth: { user: username, pass: parsedInput.imapPassword },
      });
    } catch {
      throw new SafeError(
        "Could not connect to the IMAP server with these credentials.",
      );
    }

    const encryptedPassword = encryptToken(parsedInput.imapPassword);
    if (!encryptedPassword) {
      throw new SafeError("Encryption is not configured on this server.");
    }

    let emailAccountId: string;
    try {
      const account = await prisma.account.create({
        data: {
          userId,
          type: "imap",
          provider: "imap",
          providerAccountId: email,
          imapHost: parsedInput.imapHost,
          imapPort: parsedInput.imapPort,
          imapSecure: parsedInput.imapSecure,
          imapUsername: username,
          imapPassword: encryptedPassword,
          smtpHost: parsedInput.smtpHost ?? null,
          smtpPort: parsedInput.smtpPort ?? null,
          smtpSecure: parsedInput.smtpSecure ?? null,
          emailAccount: {
            create: {
              email,
              userId,
            },
          },
        },
        include: { emailAccount: true },
      });
      emailAccountId = account.emailAccount?.id ?? "";
    } catch (error) {
      if (isDuplicateError(error)) {
        throw new SafeError("This email account is already connected.");
      }
      throw error;
    }

    // Populate the inbox so the account is not empty on first view. Best-effort:
    // a sync failure must not fail the connection itself.
    try {
      if (emailAccountId) {
        await syncImapAccount({
          emailAccountId,
          initialLimit: 50,
          includeAllFolders: true,
        });
      }
    } catch (error) {
      logger.warn("Initial IMAP sync failed", { email, error });
    }

    return { success: true };
  });
