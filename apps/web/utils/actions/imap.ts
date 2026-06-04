"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import { connectImapBody } from "@/utils/actions/imap.validation";
import prisma from "@/utils/prisma";
import { encryptToken } from "@/utils/encryption";
import { verifyImapConnection } from "@/utils/imap/connection";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { SafeError } from "@/utils/error";

export const connectImapAccountAction = actionClientUser
  .metadata({ name: "connectImapAccount" })
  .schema(connectImapBody)
  .action(async ({ ctx: { userId }, parsedInput }) => {
    const email = parsedInput.email.trim().toLowerCase();

    try {
      await verifyImapConnection({
        host: parsedInput.imapHost,
        port: parsedInput.imapPort,
        secure: parsedInput.imapSecure,
        auth: {
          user: parsedInput.imapUsername,
          pass: parsedInput.imapPassword,
        },
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

    try {
      await prisma.account.create({
        data: {
          userId,
          type: "imap",
          provider: "imap",
          providerAccountId: email,
          imapHost: parsedInput.imapHost,
          imapPort: parsedInput.imapPort,
          imapSecure: parsedInput.imapSecure,
          imapUsername: parsedInput.imapUsername,
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
      });
    } catch (error) {
      if (isDuplicateError(error)) {
        throw new SafeError("This email account is already connected.");
      }
      throw error;
    }

    return { success: true };
  });
