import { isUuidLike } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { AgentMailApiKeyField } from "@/features/connections/AgentMailApiKeyField";
import { ChatSetupNavigation } from "@/components/chat/ChatSetupNavigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Mail,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "@/components/AgentIconPicker";
import { SearchableSelect } from "@/components/SearchableSelect";
import { TrustPresetSection } from "@/components/TrustPresetSection";
import { EmailSafetyNotice } from "@/components/EmailSafetyNotice";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  getTrustPreset,
  getLowTrustBoundary,
  lowTrustBoundaryHasScope,
} from "@/lib/trust-policy-ui";
import { queryKeys } from "@/lib/queryKeys";
import type {
  AgentPermissions,
  EmailEndpointSummary,
} from "@paperclipai/shared";
const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

interface EmailSetupDraft {
  connectionId: string; step: 0 | 1; agentId: string; requestId: string;
  addressMode: "new" | "existing"; inboxId: string; username: string; domain: string;
  mode: "websocket" | "webhook";
}
function readEmailSetupDraft(key: string): Partial<EmailSetupDraft> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const draft: Partial<EmailSetupDraft> = {};
    for (const field of ["connectionId", "agentId", "inboxId", "username", "domain"] as const) {
      if (typeof value[field] === "string") draft[field] = value[field];
    }
    if (value.step === 0 || value.step === 1) draft.step = value.step;
    if (typeof value.requestId === "string" && isUuidLike(value.requestId)) draft.requestId = value.requestId;
    if (value.addressMode === "new" || value.addressMode === "existing") draft.addressMode = value.addressMode;
    if (value.mode === "websocket" || value.mode === "webhook") draft.mode = value.mode;
    return draft;
  } catch { return {}; }
}

export function EmailEndpointSetup() {
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  if (!selectedCompanyId) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading email setup…</p>;
  return <EmailEndpointSetupForm key={`${selectedCompanyId}:${params.get("connectionId") ?? "new"}`} companyId={selectedCompanyId} />;
}

function EmailEndpointSetupForm({ companyId }: { companyId: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const draftKey = `paperclip.agentmail-setup:${companyId}:${params.get("connectionId") ?? "new"}`;
  const [draft] = useState(() => readEmailSetupDraft(draftKey));
  const [connectionId, setConnectionId] = useState(draft.connectionId ?? params.get("connectionId") ?? "");
  const [step, setStep] = useState<0 | 1 | 2>(draft.step ?? 0);
  const [agentId, setAgentId] = useState(draft.agentId ?? params.get("agentId") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [requestId] = useState(() => draft.requestId ?? crypto.randomUUID());
  const [addressMode, setAddressMode] = useState<"new" | "existing">(draft.addressMode ?? "new");
  const [inboxId, setInboxId] = useState(draft.inboxId ?? "");
  const [username, setUsername] = useState(draft.username ?? "");
  const [domain, setDomain] = useState(draft.domain ?? "agentmail.to");
  const [mode, setMode] = useState<"websocket" | "webhook">(draft.mode ?? "websocket");
  const [trustOpen, setTrustOpen] = useState(false);
  const [permissions, setPermissions] = useState<Partial<AgentPermissions>>({});
  const suggestedUsername = useRef(false);
  useEffect(() => {
    if (!companyId) return;
    // Save progress, never the API key. The same request ID resumes partial setup.
    try {
      if (step === 2) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ connectionId, step, agentId,
        requestId, addressMode, inboxId, username, domain, mode }));
    } catch { /* Setup remains usable when browser storage is unavailable. */ }
  }, [companyId, draftKey, connectionId, step, agentId, requestId, addressMode, inboxId, username, domain, mode]);
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId), enabled: !!companyId });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId), enabled: !!companyId && trustOpen });
  const boundaryIssues = useQuery({ queryKey: ["email-boundary-issues", companyId],
    queryFn: () => issuesApi.list(companyId), enabled: !!companyId && trustOpen });
  const chosen = agents.data?.find(a => a.id === agentId);
  const lowTrust = getTrustPreset(chosen?.permissions) === "low_trust_review";
  const scoped = lowTrustBoundaryHasScope(getLowTrustBoundary(chosen?.permissions));
  const inspected = useQuery({ queryKey: ["email-credential-inspect", companyId, connectionId],
    queryFn: () => emailApi.inspectSaved(companyId, connectionId),
    enabled: !!companyId && !!connectionId, retry: false });
  const inboxes = useQuery({ queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId), enabled: !!companyId });
  const scopedKey = inspected.data?.scope.scope_type === "inbox";
  useEffect(() => {
    if (scopedKey) {
      setAddressMode("existing");
      setInboxId(inspected.data?.inboxes[0]?.inbox_id ?? "");
    }
  }, [scopedKey, inspected.data]);
  useEffect(() => {
    if (chosen && !suggestedUsername.current) {
      suggestedUsername.current = true;
      if (!username) setUsername(chosen.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64));
    }
  }, [chosen, username]);
  const connect = useMutation({
    mutationFn: async () => {
      if (!connectionId) {
        const result = await emailApi.connect(companyId, {
          apiKey: apiKey.trim(), grantKind: "organization", allAgents: false,
          agentIds: [agentId], idempotencyKey: requestId,
        });
        setApiKey("");
        setConnectionId(result.id);
        void cache.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      }
    },
    onSuccess: () => setStep(1),
  });
  const agentDetail = useQuery({ queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId), enabled: !!agentId && trustOpen });
  const trust = useMutation({
    mutationFn: () => agentsApi.updatePermissions(agentId, {
      ...permissions,
      canCreateAgents: permissions.canCreateAgents ?? false,
      canCreateSkills: permissions.canCreateSkills ?? true,
      canAssignTasks: agentDetail.data?.access?.canAssignTasks ?? false,
    }, companyId),
    onSuccess: () => {
      setTrustOpen(false);
      void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });
  const setup = useMutation({
    mutationFn: () => emailApi.setup(companyId, {
      assignedAgentId: agentId, credentialConnectionId: connectionId,
      ...(addressMode === "existing" ? { inboxId } : { username, domain }),
      receiveMode: mode, idempotencyKey: requestId,
    }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connectionInstalls(connectionId) });
      setStep(2);
    },
  });
  const address = addressMode === "existing" ? inboxId : `${username}@${domain}`;
  const knownAddress = addressMode === "new" && inspected.data?.inboxes.some(i => i.inbox_id.toLowerCase() === address.toLowerCase());
  const addressTaken = knownAddress || (setup.error instanceof ApiError
    && (setup.error.body as { code?: string } | null)?.code === "agentmail_address_taken");
  const assignedInbox = addressMode === "existing" && inboxes.data?.some(i => i.address === inboxId && i.status !== "archived");
  const addressError = addressTaken ? "This email address is already in use. Choose a different address."
    : assignedInbox ? "This inbox is already assigned to an agent." : null;
  const error = connect.error ?? (!addressTaken ? setup.error : null) ?? inspected.error ?? agents.error ?? inboxes.error;
  const busy = connect.isPending || setup.isPending;
  const canContinue = !!chosen && !busy && !(lowTrust && !scoped) && (!!connectionId || !!apiKey.trim());
  const canCreate = !!chosen && !busy && !!inspected.data && !(lowTrust && !scoped) && !addressError
    && (addressMode === "existing" ? !!inboxId : /^[a-z0-9][a-z0-9._-]*$/.test(username));
  const openTrust = () => { if (chosen) { setPermissions(chosen.permissions); setTrustOpen(true); } };
  const leave = () => navigate(connectionId ? `/apps/${connectionId}/permissions` : "/apps");
  const cancel = () => { try { sessionStorage.removeItem(draftKey); } catch {} leave(); };
  return <div className="mx-auto max-w-xl space-y-6 p-6">
    <header className="space-y-2">
      <h1 className="text-xl font-bold">{step === 2 ? "Your agent’s email is ready" : "Give an agent an email address"}</h1>
    </header>
    {step < 2 && <ChatSetupNavigation labels={["Agent", "Email address"]} step={step}
      availableStep={step} disabled={busy} onSelect={index => { setup.reset(); setStep(index as 0 | 1); }} />}
    {step === 0 && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canContinue) connect.mutate(); }}>
      <div className="space-y-2">
        <Label>Agent</Label>
        <SearchableSelect value={agentId} disabled={busy} loading={agents.isPending} placeholder="Choose an agent" searchPlaceholder="Search all agents…" emptyMessage="No agents found."
          groups={[{ id: "agents", options: (agents.data ?? []).filter(a => !["terminated", "pending_approval"].includes(a.status))
            .map(a => ({ key: a.id, value: a.id, label: a.name, icon: a.icon })) }]}
          onValueChange={(id, option) => { setAgentId(id); setUsername(option.label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64)); }}
          renderValue={option => option ? <span className="flex items-center gap-2"><Avatar size="sm"><AvatarFallback><AgentIcon icon={String(option.icon ?? "bot")} /></AvatarFallback></Avatar>{option.label}</span> : "Choose an agent"} />
      </div>
      {!connectionId && <AgentMailApiKeyField value={apiKey} onChange={value => { setApiKey(value); connect.reset(); }} disabled={busy} />}
      {lowTrust && !scoped && <div role="alert" className="space-y-2 text-sm">
        <p>This agent needs a work boundary before it can receive email.</p>
        <Button type="button" variant="outline" size="sm" onClick={openTrust}>Configure work boundary</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Button>
        <Button disabled={!canContinue}>{connect.isPending ? "Connecting…" : "Continue"}<ArrowRight className="size-4" /></Button>
      </div>
    </form>}
    {step === 1 && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canCreate) setup.mutate(); }}>
      <div className="space-y-2">
        <Label htmlFor={addressMode === "new" ? "email-name" : "email-existing"}>{chosen?.name}’s email address</Label>
        {addressMode === "new" ? <>
          <div className="flex items-center gap-2">
            <Input id="email-name" className="min-w-0" value={username} maxLength={64} autoComplete="off" spellCheck={false} disabled={busy}
              aria-invalid={!!addressError} aria-describedby={addressError ? "email-address-error" : undefined}
              onChange={event => { setUsername(event.target.value.toLowerCase()); setup.reset(); }} />
            <span className="max-w-1/2 shrink-0 break-all text-sm text-muted-foreground">@{domain}</span>
          </div>
        </> : <select id="email-existing" className={selectClass} value={inboxId} disabled={busy || scopedKey}
          aria-invalid={!!addressError} aria-describedby={addressError ? "email-address-error" : undefined}
          onChange={event => { setInboxId(event.target.value); setup.reset(); }}>
          <option value="">Choose an inbox</option>
          {inspected.data?.inboxes.map(i => {
            const assigned = inboxes.data?.some(e => e.address === i.inbox_id && e.status !== "archived");
            return <option key={i.inbox_id} value={i.inbox_id} disabled={assigned}>{i.inbox_id}{assigned ? " — already assigned" : ""}</option>;
          })}
        </select>}
        {addressError && <p id="email-address-error" role="alert" className="text-sm text-destructive">{addressError}</p>}
        {!scopedKey && <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy}
          onClick={() => { setAddressMode(addressMode === "new" ? "existing" : "new"); setup.reset(); }}>
          {addressMode === "new" ? "Use an existing inbox" : "Create a new address"}
        </Button>}
        <p className="text-sm text-muted-foreground">Incoming email creates tasks for {chosen?.name}. Replies stay in the same task.</p>
      </div>
      <details className="space-y-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">Advanced options</summary>
        <div className="space-y-4">
          {addressMode === "new" && <div className="space-y-2">
            <Label htmlFor="email-domain">Domain</Label>
            <select id="email-domain" value={domain} disabled={busy} className={selectClass} onChange={event => { setDomain(event.target.value); setup.reset(); }}>
              <option>agentmail.to</option>
              {inspected.data?.domains.filter(d => d.status === "VERIFIED").map(d => <option key={d.domain_id}>{d.domain}</option>)}
            </select>
            <a className="text-sm underline" href="https://docs.agentmail.to/custom-domains" target="_blank" rel="noreferrer">Set up a custom domain ↗</a>
          </div>}
          <div className="space-y-2">
            <Label htmlFor="email-mode">Receiving</Label>
            <select id="email-mode" value={mode} disabled={busy} className={selectClass} onChange={event => setMode(event.target.value as typeof mode)}>
              <option value="websocket">Live connection</option><option value="webhook">Webhook</option>
            </select>
          </div>
          <EmailSafetyNotice />
          <div className="space-y-2 text-sm">
            <p>{lowTrust && scoped ? "Low-trust review configured" : "Manage which tasks and tools this agent can access."}</p>
            <Button type="button" variant="outline" size="sm" onClick={openTrust}>Review trust settings</Button>
          </div>
        </div>
      </details>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {inspected.isPending && <p role="status" className="text-sm text-muted-foreground">Loading email options…</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setup.reset(); setStep(0); }}><ArrowLeft className="size-4" />Back</Button>
        <Button disabled={!canCreate}>
          {setup.isPending ? "Connecting…" : addressMode === "new" ? "Create email address" : "Connect email address"}<ArrowRight className="size-4" />
        </Button>
      </div>
    </form>}
    {step === 2 && <div className="space-y-6">
      <div className="space-y-2"><p className="flex items-center gap-2 font-medium"><Check className="size-4" />{setup.data?.address}</p>
        <p className="text-sm text-muted-foreground">{chosen?.name} can now receive email at this address.</p></div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button variant="ghost" onClick={leave}>Email settings</Button><Button onClick={leave}>Done</Button>
      </div>
    </div>}
      <Dialog open={trustOpen} onOpenChange={setTrustOpen}>
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trust settings · {chosen?.name}</DialogTitle>
            <DialogDescription>
              Changes apply to all of this agent’s work. Use a dedicated email
              agent if its other tasks need broader access.
            </DialogDescription>
          </DialogHeader>
          <TrustPresetSection
            permissions={permissions}
            onChange={setPermissions}
            companyId={companyId}
            projectCandidates={(projects.data ?? []).map((p) => ({
              id: p.id,
              label: p.name,
            }))}
            issueCandidates={(boundaryIssues.data ?? []).map((issue) => ({
              id: issue.id,
              label: `${issue.identifier} · ${issue.title}`,
            }))}
            allowSingleIssue={false}
            candidatesLoading={projects.isPending || boundaryIssues.isPending}
          />
          <p className="text-xs text-muted-foreground">
            Low trust limits Paperclip access; it does not sandbox the runtime.
            Review filesystem, tool, and secret access separately.
          </p>
          {(trust.error || projects.error || boundaryIssues.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(trust.error ?? projects.error ?? boundaryIssues.error)?.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTrustOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                trust.isPending ||
                agentDetail.isPending ||
                !!agentDetail.error ||
                (getTrustPreset(permissions) === "low_trust_review" &&
                  !lowTrustBoundaryHasScope(getLowTrustBoundary(permissions)))
              }
              onClick={() => trust.mutate()}
            >
              Save trust settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  </div>;
}

export function EmailConnectionInboxes({
  companyId,
  connectionId,
  canConfigure,
}: {
  companyId: string;
  connectionId: string;
  canConfigure: boolean;
}) {
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const children = new Set(
    connections.data?.connections
      .filter((c) => c.config?.credentialConnectionId === connectionId)
      .map((c) => c.id),
  );
  const inboxes =
    query.data?.filter(
      (i) => i.connectionId === connectionId || children.has(i.connectionId),
    ) ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            Give an agent an email address
          </h2>
          <p className="text-sm text-muted-foreground">
            Each email conversation becomes a task.
          </p>
        </div>
        {canConfigure && (
          <Button asChild size="lg">
            <Link
              to={`/apps/chat/connect?provider=agentmail&connectionId=${connectionId}`}
            >
              Give an agent an email address
            </Link>
          </Button>
        )}
      </div>
      {inboxes.map((i) => (
        <div
          key={i.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
        >
          <Link
            className="text-sm underline"
            to={`/apps/chat/${i.id}/settings`}
          >
            {i.address}
          </Link>
          <span className="text-xs text-muted-foreground">
            {i.lastError ??
              (i.status === "active" ? "Receiving email" : i.status)}
          </span>
        </div>
      ))}
      {!!inboxes.length && <EmailSafetyNotice />}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
    </section>
  );
}
export function EmailEndpointSettings({
  endpointId,
  companyId,
}: {
  endpointId: string;
  companyId: string;
}) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const inbox = query.data?.find(
    (row: EmailEndpointSummary) => row.id === endpointId,
  );
  const [removed, setRemoved] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [receiveMode, setReceiveMode] = useState<"websocket" | "webhook" | "">(
    "",
  );
  const reconnect = useMutation({
    mutationFn: () =>
      emailApi.reconnect(
        endpointId,
        replacementKey,
        receiveMode || inbox!.receiveMode,
      ),
    onSuccess: () => {
      setReplacementKey("");
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      emailApi.control(endpointId, action),
    onSuccess: (result) => {
      setRemoved(result.status === "archived");
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  if (removed)
    return <p>Inbox disconnected. Email history remains in its tasks.</p>;
  if (!inbox)
    return (
      <p role={query.error ? "alert" : undefined}>
        {query.error?.message ?? "Loading email inbox…"}
      </p>
    );
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-bold">{inbox.address}</h1>
      <p className="text-sm text-muted-foreground">
        {inbox.status} ·{" "}
        {inbox.receiveMode === "websocket" ? "Live connection" : "Webhook"}
      </p>
      <p className="text-sm text-muted-foreground">
        Last mail check: {inbox.lastSyncAt ? new Date(inbox.lastSyncAt).toLocaleString() : "Not checked yet"}
      </p>
      <p className="text-sm">
        Each email conversation is a task. Task comments stay internal; use
        Email reply to send.
      </p>
      {inbox.lastError && (
        <p role="alert" className="text-sm text-destructive">
          {inbox.lastError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={control.isPending}
          onClick={() =>
            control.mutate(inbox.status === "active" ? "pause" : "resume")
          }
        >
          {inbox.status === "active" ? "Pause" : "Resume"}
        </Button>
        <Button
          variant="outline"
          disabled={control.isPending}
          onClick={() => control.mutate("remove")}
        >
          Disconnect inbox
        </Button>
      </div>
      <div className="space-y-2">
        <AgentMailApiKeyField label="Reconnect this inbox with a new API key" value={replacementKey} onChange={setReplacementKey} disabled={reconnect.isPending} />
        <Label htmlFor="email-reconnect-mode">Receiving mode</Label>
        <select
          id="email-reconnect-mode"
          className={selectClass}
          value={receiveMode || inbox.receiveMode}
          onChange={(e) =>
            setReceiveMode(e.target.value as "websocket" | "webhook")
          }
        >
          <option value="websocket">Live connection</option>
          <option value="webhook">Webhook</option>
        </select>
        <Button
          variant="outline"
          disabled={!replacementKey || reconnect.isPending}
          onClick={() => reconnect.mutate()}
        >
          Reconnect inbox
        </Button>
      </div>
      {reconnect.error && (
        <p role="alert" className="text-sm text-destructive">
          {reconnect.error.message}
        </p>
      )}
      {control.error && (
        <p role="alert" className="text-sm text-destructive">
          {control.error.message}
        </p>
      )}
    </div>
  );
}
