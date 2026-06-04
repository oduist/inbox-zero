"use client";

import { useForm } from "react-hook-form";
import { Input } from "@/components/Input";
import { Button } from "@/components/ui/button";
import { toastError, toastSuccess } from "@/components/Toast";
import { connectImapAccountAction } from "@/utils/actions/imap";
import type { ConnectImapBody } from "@/utils/actions/imap.validation";

export function ConnectImapForm({ onSuccess }: { onSuccess?: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConnectImapBody>({
    defaultValues: { imapPort: 993, imapSecure: true },
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await connectImapAccountAction({
      ...values,
      imapUsername: values.imapUsername || values.email,
    });

    if (result?.serverError) {
      toastError({
        title: "Could not connect",
        description: result.serverError,
      });
      return;
    }

    toastSuccess({ description: "IMAP account connected." });
    onSuccess?.();
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Input
        type="email"
        name="email"
        label="Email address"
        registerProps={register("email", { required: true })}
        error={errors.email}
      />
      <Input
        type="text"
        name="imapHost"
        label="IMAP server"
        placeholder="imap.example.com"
        registerProps={register("imapHost", { required: true })}
        error={errors.imapHost}
      />
      <Input
        type="number"
        name="imapPort"
        label="IMAP port"
        registerProps={register("imapPort", { valueAsNumber: true })}
        error={errors.imapPort}
      />
      <Input
        type="text"
        name="imapUsername"
        label="Username (defaults to email)"
        registerProps={register("imapUsername")}
        error={errors.imapUsername}
      />
      <Input
        type="password"
        name="imapPassword"
        label="Password"
        registerProps={register("imapPassword", { required: true })}
        error={errors.imapPassword}
      />
      <Input
        type="text"
        name="smtpHost"
        label="SMTP server (optional, defaults to IMAP host)"
        placeholder="smtp.example.com"
        registerProps={register("smtpHost")}
        error={errors.smtpHost}
      />
      <Input
        type="number"
        name="smtpPort"
        label="SMTP port (optional)"
        registerProps={register("smtpPort", { valueAsNumber: true })}
        error={errors.smtpPort}
      />
      <Button type="submit" loading={isSubmitting}>
        Connect
      </Button>
    </form>
  );
}
