import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import {
  isImapProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import type { EmailProvider } from "@/utils/email/types";

export type GetFoldersResponse = Awaited<ReturnType<typeof getFolders>>;

export const GET = withEmailProvider("user/folders", async (request) => {
  const emailProvider = request.emailProvider;

  // Folder-based providers (Outlook, IMAP) expose folders; Gmail uses labels.
  if (
    !isMicrosoftProvider(emailProvider.name) &&
    !isImapProvider(emailProvider.name)
  ) {
    return NextResponse.json(
      { error: "This email provider does not support folders" },
      { status: 400 },
    );
  }

  const result = await getFolders({ emailProvider });
  return NextResponse.json(result);
});

async function getFolders({ emailProvider }: { emailProvider: EmailProvider }) {
  const folders = await emailProvider.getFolders();
  return folders;
}
