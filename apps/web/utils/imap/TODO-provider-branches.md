# IMAP provider — `isGoogle/isMicrosoft` branch triage

Tracks every place the app branches on provider, and what `"imap"` should do.
`isGoogleProvider`/`isMicrosoftProvider` are strict equality, so `"imap"` always
falls into the `else`/default branch.

**Key finding:** there are **no reachable crashes** on the core mail flow.
Connecting an IMAP account and reading/sending works today; the rest is UX.

Legend: ☐ todo · ☑ done · — leave as default (acceptable)

## Priority 1 — core mail UI (imap goes blind here) — DONE

- ☑ `app/api/user/folders/route.ts` — now allows microsoft OR imap (folder-based providers).
- ☑ `hooks/useFolders.ts` — `enabled` now true for microsoft OR imap.
- ☑ `app/api/messages/route.ts` — imap branch hides sent messages via `isSentMessage`.
- ☑ `components/EmailViewer.tsx` — generic copy ("this provider") instead of "Outlook".

## Priority 2 — rules & actions (imap supports moves) — DONE

- ☑ `utils/ai/rule/action-availability.ts` — MOVE_FOLDER offered for imap.
- ☑ `utils/rule/rule.ts` — MOVE_FOLDER folderId/folderName resolved+persisted for imap (folder-based).
- ☑ `utils/ai/rule/create-rule-schema.ts` — `folderName` schema field for imap.
- ☑ `app/(app)/[emailAccountId]/onboarding/OnboardingCategories.tsx` — imap shows "Move to folder".
- ☑ `utils/rule/consts.ts` — `getCategoryAction` uses folder action for imap.

## Priority 3 — terminology / UX (medium)

- ☐ `app/(app)/[emailAccountId]/onboarding/StepInboxProcessed.tsx:92` — "labeled" vs folder wording.
- ☐ `app/(app)/[emailAccountId]/reply-zero/ReplyTrackerEmails.tsx:59,387` — reply marked unsupported though SMTP send works.
- ☐ `components/EmailMessageCellLabels.ts:73,77` — Archived badge not shown for imap (low priority).

## Leave as default (Gmail-only features hidden for imap — acceptable)

- `components/EmailMessageCell.tsx:59`, `components/ActionButtons.tsx:51`, `components/ViewEmailButton.tsx:22` — in-app/Open-in-Gmail viewer.
- `components/SideNav.tsx:123`, `hooks/useCommandPaletteCommands.ts:91` — Deep Clean.
- `components/NavUser.tsx:124,142`, `setup/SetupContent.tsx:413`, `early-access/page.tsx:23` — extension / Reply Zero / cold email.
- `bulk-unsubscribe/common.tsx:333` — Open in Gmail search.
- `assistant/settings/PersonalSignatureSetting.tsx:73`, `settings/SignatureSectionForm.tsx:40` — provider signature (none for imap).
- `assistant/settings/FollowUpRemindersSetting.tsx:341` — "View in Gmail" toast.
- `app/api/follow-up-reminders/process.ts:835`, `utils/messaging/rule-notifications.ts:2179` — label deep-links.
- `utils/actions/rule.ts:888` — Gmail label-name validation.
- `utils/actions/clean.ts:40`, `utils/actions/permissions.ts:77` — guarded throws, UI already hidden / admin-only.

## OK boundary — OAuth / webhook / calendar / drive (imap never reaches)

- `utils/auth.ts:491,518,549`, `app/(app)/accounts/AddAccount.tsx:22,33`, `utils/account-linking.ts:31`
- `app/api/google/webhook/route.ts:70`, `utils/webhook/process-history.ts:34,48`, `utils/webhook/validate-webhook-account.ts:321,326`
- `utils/email/watch-manager.ts:231` (imap watch = polling/no-op)
- `utils/calendar/*`, `utils/actions/booking.ts:258`, `app/(app)/[emailAccountId]/calendars/booking-calendar-helpers.ts:53`
- `utils/drive/provider.ts:39,43,77,82`
- `utils/actions/whitelist.ts:16`, `app/(app)/[emailAccountId]/onboarding-brief/StepReady.tsx:139`

## Already handled

- ☑ `utils/terminology.ts:22` — imap → "folder"
- ☑ `providers/EmailProvider.tsx:32` — imap → no color (also guards the throw at :51)
- ☑ `utils/email/provider.ts` — factory imap branch
- ☑ `utils/email/provider-types.ts` — `isImapProvider`
