import { z } from "zod";

// SMTP fields and username are optional (they default to the IMAP host /
// account email). The form normalizes blank inputs to undefined before
// submitting so these stay truly optional.
export const connectImapBody = z.object({
  email: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().positive().default(993),
  imapSecure: z.boolean().default(true),
  imapUsername: z.string().min(1).optional(),
  imapPassword: z.string().min(1),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().positive().optional(),
  smtpSecure: z.boolean().optional(),
});
export type ConnectImapBody = z.infer<typeof connectImapBody>;
