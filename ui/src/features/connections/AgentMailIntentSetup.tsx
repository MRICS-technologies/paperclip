import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { AgentMailApiKeyField } from "./AgentMailApiKeyField";

/** Same account and inbox APIs as Apps; task setup fixes the access defaults. */
export function AgentMailIntentSetup({ companyId, agentId, requestId, savedCredentialId, readyConnectionId, onComplete, onDecline, declining = false }: {
  companyId: string;
  agentId: string;
  requestId: string;
  savedCredentialId?: string | null;
  readyConnectionId?: string | null;
  onComplete(connectionId: string): Promise<void>;
  onDecline(): void;
  declining?: boolean;
}) {
  const [apiKey, setApiKey] = useState("");
  const [credentialId, setCredentialId] = useState(savedCredentialId ?? null);
  const [inboxConnectionId, setInboxConnectionId] = useState(readyConnectionId ?? null);
  const setup = useMutation({
    mutationFn: async () => {
      let connectionId = inboxConnectionId;
      if (!connectionId) {
        let accountId = credentialId;
        if (!accountId) {
          const account = await emailApi.connect(companyId, {
            apiKey: apiKey.trim(), grantKind: "organization", allAgents: false,
            agentIds: [agentId], idempotencyKey: requestId,
          });
          accountId = account.id;
          setCredentialId(accountId);
          setApiKey("");
        }
        const inbox = await emailApi.setup(companyId, {
          assignedAgentId: agentId, credentialConnectionId: accountId,
          receiveMode: "websocket", idempotencyKey: requestId,
        });
        connectionId = inbox.connectionId;
        setInboxConnectionId(connectionId);
      }
      // Only the server's completed intent may resume the task. A saved API key
      // alone is not an inbox, and failures remain retryable in this same form.
      await onComplete(connectionId);
    },
  });
  return <form className="mt-4 space-y-4" data-testid="agentmail-inline-setup" onSubmit={event => {
    event.preventDefault();
    if (!setup.isPending && !declining) setup.mutate();
  }}>
    {credentialId || inboxConnectionId
      ? <p className="text-sm text-muted-foreground">{inboxConnectionId ? "Your inbox is ready. Continue to resume the chat." : "API key saved. Finish creating the inbox."}</p>
      : <AgentMailApiKeyField value={apiKey} onChange={setApiKey} disabled={setup.isPending || declining} />}
    {setup.error && <p className="text-sm text-destructive" role="alert">{setup.error.message}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button type="button" variant="ghost" disabled={setup.isPending || declining} onClick={onDecline}>Not now</Button>
      <Button type="submit" disabled={setup.isPending || declining || (!credentialId && !inboxConnectionId && !apiKey.trim())}>
        {setup.isPending ? "Connecting…" : inboxConnectionId ? "Continue" : credentialId ? "Finish setup" : "Connect AgentMail"}
      </Button>
    </div>
  </form>;
}
