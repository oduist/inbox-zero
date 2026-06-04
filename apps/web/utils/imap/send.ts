import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import prisma from "@/utils/prisma";
import { decryptToken } from "@/utils/encryption";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("imap/send");

export interface SmtpConfig {
  auth: { user: string; pass: string };
  host: string;
  port: number;
  secure: boolean;
}

/**
 * Builds a raw RFC822 message buffer. Used both for SMTP sending and for
 * APPENDing a copy into the Sent/Drafts mailboxes (IMAP has no API that does
 * this for us, unlike Gmail/Outlook).
 */
export async function buildMime(options: Mail.Options): Promise<Buffer> {
  return new MailComposer(options).compile().build();
}

export async function sendViaSmtp(
  config: SmtpConfig,
  options: Mail.Options,
): Promise<{ messageId: string }> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  const info = await transport.sendMail(options);
  return { messageId: info.messageId };
}

export async function getSmtpConfig({
  emailAccountId,
}: {
  emailAccountId: string;
}): Promise<SmtpConfig> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: {
          imapHost: true,
          imapUsername: true,
          imapPassword: true,
          smtpHost: true,
          smtpPort: true,
          smtpSecure: true,
        },
      },
    },
  });

  const account = emailAccount?.account;
  if (!account) {
    logger.error("Account not found for SMTP config", { emailAccountId });
    throw new Error("Account not found");
  }

  const host = account.smtpHost ?? account.imapHost;
  const pass = decryptToken(account.imapPassword);
  if (!host || !account.imapUsername || !pass) {
    throw new Error("SMTP account is not configured");
  }

  const port = account.smtpPort ?? 587;
  return {
    host,
    port,
    // Implicit TLS on 465, STARTTLS otherwise.
    secure: account.smtpSecure ?? port === 465,
    auth: { user: account.imapUsername, pass },
  };
}
