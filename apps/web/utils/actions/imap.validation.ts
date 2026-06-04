import { z } from "zod";

export const connectImapBody = z.object({
  email: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().positive().default(993),
  imapSecure: z.boolean().default(true),
  imapUsername: z.string().min(1),
  imapPassword: z.string().min(1),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().positive().optional(),
  smtpSecure: z.boolean().optional(),
});
export type ConnectImapBody = z.infer<typeof connectImapBody>;
