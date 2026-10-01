// @vitest-environment jsdom
// Real lifecycle tests for the wizard's login barrier: NewAgentSetup, the real
// AgentProviderConnection and the real AdapterLoginPanel, with only the API
// modules mocked. Nothing here drives a synthetic panel callback.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterLoginPanel } from "../AgentConfigForm";
import { NewAgentSetup } from "./NewAgentSetup";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  adapterModels: vi.fn(),
  list: vi.fn(),
  hire: vi.fn(),
  testEnvironment: vi.fn(),
  getAdapterAuthSignal: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
}));
const envApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }));
const settings = vi.hoisted(() => ({ get: vi.fn(), getExperimental: vi.fn(), getGeneral: vi.fn() }));
const secrets = vi.hoisted(() => ({ list: vi.fn(), listMyUserSecrets: vi.fn() }));
const state = vi.hoisted(() => ({ params: new URLSearchParams(), navigate: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("@/api/environments", () => ({ environmentsApi: envApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: settings }));
vi.mock("@/api/secrets", () => ({ secretsApi: secrets }));
const aiConnections = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: aiConnections }));
vi.mock("@/api/adapters", () => ({
  adaptersApi: {
    list: async () =>
      ["claude_local", "codex_local"].map((type) => ({ type, loaded: true, disabled: false })),
  },
}));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => state.navigate,
  useSearchParams: () => [state.params],
}));
vi.mock("@/components/onboarding/PillGuy", () => ({ PillGuy: () => null }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: any) => children,
  MotionConfig: ({ children }: any) => children,
  motion: {
    span: ({ children }: any) => <span>{children}</span>,
    div: ({ children, initial, animate, exit, transition, layout, ...rest }: any) => <div {...rest}>{children}</div>,
    button: ({ children, initial, animate, exit, transition, layout, ...rest }: any) => <button {...rest}>{children}</button>,
  },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const notFound = () => new ApiError("Not found", 404, null);
const serverError = () => new ApiError("Server error", 500, null);
const session = (sessionId: string, environmentId: string, status = "waiting_for_user") => ({
  sessionId,
  environmentId,
  status,
  expiresAt: null,
  failure: null,
  prompt: { url: "https://auth.example.test/device", code: "WXYZ-1234" },
  aiConnection: { provider: "openai", method: "subscription", name: "My OpenAI subscription", ownership: "personal", agentIds: [], allAgents: true },
});

let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
async function click(text: string) {
  const target = button(text);
  expect(target, `Missing button ${text}`).toBeTruthy();
  await act(async () => target!.click());
  await settle();
}
const select = () => container.querySelector('[aria-label="Environment"]') as HTMLSelectElement;
async function pickEnvironment(id: string) {
  // Dispatched even at a disabled control, so the handler guard is exercised too.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select(), id);
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function render(adapterType = "codex_local") {
  state.params = new URLSearchParams({ name: "Atlas", adapterType });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <TooltipProvider>
          <NewAgentSetup />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}
async function openSubscription(provider = "OpenAI") {
  await click(`${provider}Subscription`);
}
const barrierUp = () =>
  select().disabled &&
  container.textContent!.includes("Finish or cancel the sign-in in progress") &&
  button("Back")!.disabled &&
  [...container.querySelectorAll('nav[aria-label="Agent setup steps"] button')].every(
    (step) => (step as HTMLButtonElement).disabled,
  );
const authSignalFor = (environmentId: string) =>
  api.getAdapterAuthSignal.mock.calls.some((call) => call[2] === environmentId);

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  aiConnections.list.mockResolvedValue({ currentUserId: "user-1", connections: [] });
  api.adapterModels.mockResolvedValue([]);
  api.list.mockResolvedValue([{ id: "ceo", role: "ceo", status: "idle" }]);
  api.getAdapterAuthSignal.mockResolvedValue({ status: "absent" });
  api.getClaudeOAuthTokenStatus.mockRejectedValue(notFound());
  api.getActiveAdapterAuthLoginSession.mockRejectedValue(notFound());
  api.startAdapterAuthLogin.mockResolvedValue(session("session-1", "sandbox-a", "starting"));
  api.getAdapterAuthLoginStatus.mockResolvedValue(session("session-1", "sandbox-a"));
  api.cancelAdapterAuthLogin.mockResolvedValue({});
  api.testEnvironment.mockResolvedValue({ status: "pass", checks: [{ code: "hello_probe_passed", level: "info", message: "ok" }] });
  envApi.list.mockResolvedValue([
    { id: "sandbox-a", name: "Sandbox A", driver: "sandbox", status: "active", config: { provider: "daytona" } },
    { id: "sandbox-b", name: "Sandbox B", driver: "sandbox", status: "active", config: { provider: "daytona" } },
  ]);
  envApi.capabilities.mockResolvedValue({ sandboxProviders: { daytona: { supportsLoginPty: true } } });
  settings.get.mockResolvedValue({ defaultEnvironmentId: "sandbox-a" });
  settings.getExperimental.mockResolvedValue({});
  settings.getGeneral.mockResolvedValue({ executionMode: "any" });
  secrets.list.mockResolvedValue([]);
  secrets.listMyUserSecrets.mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});

describe("NewAgentSetup login barrier", () => {
  it("raises the barrier before discovery and holds every transition through a pending start", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    api.startAdapterAuthLogin.mockReturnValue(new Promise((resolve) => (resolveStart = resolve)));
    await render();
    expect(select().disabled).toBe(false);
    await openSubscription();

    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(1);
    expect(api.startAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", expect.objectContaining({ environmentId: "sandbox-a" }));
    expect(barrierUp()).toBe(true);
    // No session id yet, so nothing to cancel.
    expect(button("Cancel sign-in")).toBeUndefined();

    // Handlers refuse too, not only the disabled controls.
    await pickEnvironment("sandbox-b");
    await act(async () => button("Back")!.click());
    await settle();
    expect(select().value).toBe("");
    expect(authSignalFor("sandbox-b")).toBe(false);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connect Atlas to OpenAI");

    await act(async () => resolveStart(session("session-1", "sandbox-a", "starting")));
    await settle();
    expect(barrierUp()).toBe(true);
    expect(button("Cancel sign-in")).toBeTruthy();
  });

  it("releases the barrier only after an explicit cancel succeeds", async () => {
    await render();
    await openSubscription();
    expect(barrierUp()).toBe(true);
    await click("Cancel sign-in");

    expect(api.cancelAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", "session-1");
    expect(container.textContent).toContain("The sign-in was cancelled.");
    expect(select().disabled).toBe(false);
    expect(button("Back")!.disabled).toBe(false);

    await pickEnvironment("sandbox-b");
    expect(authSignalFor("sandbox-b")).toBe(true);
  });

  it("treats a cancel 404 as released", async () => {
    api.cancelAdapterAuthLogin.mockRejectedValue(notFound());
    await render();
    await openSubscription();
    await click("Cancel sign-in");
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(1);
    expect(select().disabled).toBe(false);
  });

  it("reconciles a cancel 500 and keeps the barrier while the session is still held, then retries", async () => {
    api.cancelAdapterAuthLogin.mockRejectedValueOnce(serverError());
    await render();
    await openSubscription();
    let resolveActive: (value: unknown) => void = () => {};
    api.getActiveAdapterAuthLoginSession.mockReturnValueOnce(new Promise((resolve) => (resolveActive = resolve)));
    await click("Cancel sign-in");
    // While the reconciliation runs, the failure shows once, beside Cancel,
    // and the code stays visible.
    expect(container.textContent!.split("Server error").length - 1).toBe(1);
    expect(container.textContent).toContain("WXYZ-1234");
    await act(async () => resolveActive(session("session-1", "sandbox-a")));
    await settle();

    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Server error");
    // The live session's code is back, not hidden behind the cancel error.
    expect(container.textContent).toContain("WXYZ-1234");
    expect(barrierUp()).toBe(true);

    await click("Cancel sign-in");
    expect(api.cancelAdapterAuthLogin).toHaveBeenCalledTimes(2);
    expect(select().disabled).toBe(false);
  });

  it("releases after a cancel 500 when reconciliation finds no session", async () => {
    api.cancelAdapterAuthLogin.mockRejectedValueOnce(serverError());
    await render();
    await openSubscription();
    await click("Cancel sign-in");
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("The sign-in was cancelled.");
    expect(select().disabled).toBe(false);
  });

  it("stays closed when reconciliation itself fails, until Check again confirms", async () => {
    api.cancelAdapterAuthLogin.mockRejectedValueOnce(serverError());
    await render();
    await openSubscription();
    api.getActiveAdapterAuthLoginSession.mockRejectedValueOnce(serverError());
    await click("Cancel sign-in");

    expect(container.textContent).toContain("Could not confirm whether a sign-in is still running");
    expect(barrierUp()).toBe(true);
    // The session may well be live, so its code stays usable.
    expect(container.textContent).toContain("WXYZ-1234");

    api.getActiveAdapterAuthLoginSession.mockRejectedValueOnce(serverError());
    await click("Check again");
    expect(barrierUp()).toBe(true);

    const polls = api.getAdapterAuthLoginStatus.mock.calls.length;
    await click("Check again");
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(4);
    expect(select().disabled).toBe(false);
    // The unlocked step keeps nothing of the ended sign-in: no code, no
    // Cancel or its error, no stale check failure, no poll.
    expect(container.textContent).not.toContain("WXYZ-1234");
    expect(container.textContent).not.toContain("Server error");
    expect(container.textContent).not.toContain("Could not confirm");
    expect(button("Cancel sign-in")).toBeUndefined();
    expect(button("Check again")).toBeUndefined();
    expect(container.textContent).toContain("No sign-in is running.");
    await act(async () => cache.invalidateQueries({ queryKey: ["adapter-login-status"] }));
    await settle();
    expect(api.getAdapterAuthLoginStatus).toHaveBeenCalledTimes(polls);
  });

  it("clears a Claude sign-in whose cancel and check failed once Check again finds none", async () => {
    api.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(notFound());
    api.startClaudeSetupTokenLogin.mockResolvedValue({ ...session("claude-1", "sandbox-a", "starting"), prompt: null });
    api.getClaudeSetupTokenLoginStatus.mockResolvedValue({ ...session("claude-1", "sandbox-a"), prompt: null });
    api.getClaudeSetupTokenLoginPrompt.mockResolvedValue({ authorizationUrl: "https://claude.example.test/authorize" });
    api.cancelClaudeSetupTokenLogin.mockRejectedValueOnce(serverError());
    await render("claude_local");
    await openSubscription("Claude");
    api.getActiveClaudeSetupTokenLoginSession.mockRejectedValueOnce(serverError());
    await click("Cancel sign-in");
    expect(barrierUp()).toBe(true);
    expect(container.textContent).toContain("Could not confirm whether a sign-in is still running");
    expect(container.querySelector("input")).toBeTruthy();

    await click("Check again");
    expect(select().disabled).toBe(false);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("Server error");
    expect(button("Cancel sign-in")).toBeUndefined();
    expect(container.textContent).toContain("No sign-in is running.");
  });

  it("restarts a cancelled sign-in in place, raising the barrier first", async () => {
    await render();
    await openSubscription();
    await click("Cancel sign-in");
    expect(button("Start sign-in again")!.disabled).toBe(false);

    let resolveStart: (value: unknown) => void = () => {};
    api.startAdapterAuthLogin.mockReturnValueOnce(new Promise((resolve) => (resolveStart = resolve)));
    await click("Start sign-in again");
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(2);
    expect(barrierUp()).toBe(true);
    expect(container.textContent).not.toContain("The sign-in was cancelled.");

    await act(async () => resolveStart(session("session-2", "sandbox-a", "starting")));
    await settle();
    expect(button("Cancel sign-in")).toBeTruthy();
  });

  it("starts fresh after a resumed sign-in is cancelled, never adopting the cached session", async () => {
    api.getActiveAdapterAuthLoginSession.mockResolvedValueOnce(session("session-1", "sandbox-a"));
    await render();
    await openSubscription();
    expect(api.startAdapterAuthLogin).not.toHaveBeenCalled();
    await click("Cancel sign-in");
    expect(container.textContent).toContain("The sign-in was cancelled.");

    // The server released session-1; the remounted panel's cache still holds it.
    api.startAdapterAuthLogin.mockResolvedValueOnce(session("session-2", "sandbox-a", "starting"));
    api.getAdapterAuthLoginStatus.mockResolvedValue(session("session-2", "sandbox-a"));
    await click("Start sign-in again");
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    expect(barrierUp()).toBe(true);

    await click("Cancel sign-in");
    expect(api.cancelAdapterAuthLogin).toHaveBeenLastCalledWith("company-1", "codex_local", "session-2");
  });

  it("clears the code and session when its own status poll returns 404", async () => {
    await render();
    await openSubscription();
    expect(container.textContent).toContain("WXYZ-1234");

    api.getAdapterAuthLoginStatus.mockRejectedValue(notFound());
    await act(async () => cache.invalidateQueries({ queryKey: ["adapter-login-status"] }));
    await settle();
    expect(container.textContent).not.toContain("WXYZ-1234");
    expect(container.textContent).toContain("No sign-in is running.");
    expect(button("Cancel sign-in")).toBeUndefined();
    expect(select().disabled).toBe(false);
    expect(button("Start sign-in again")!.disabled).toBe(false);
  });

  it("clears the Claude URL and pasted code when its own status poll returns 404", async () => {
    api.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(notFound());
    api.startClaudeSetupTokenLogin.mockResolvedValue({ ...session("claude-1", "sandbox-a", "starting"), prompt: null });
    api.getClaudeSetupTokenLoginStatus.mockResolvedValue({ ...session("claude-1", "sandbox-a"), prompt: null });
    api.getClaudeSetupTokenLoginPrompt.mockResolvedValue({ authorizationUrl: "https://claude.example.test/authorize" });
    await render("claude_local");
    await openSubscription("Claude");
    expect(container.querySelector("input")).toBeTruthy();

    api.getClaudeSetupTokenLoginStatus.mockRejectedValue(notFound());
    await act(async () => cache.invalidateQueries({ queryKey: ["claude-setup-token-status"] }));
    await settle();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("The login did not finish");
    expect(button("Cancel sign-in")).toBeUndefined();
    expect(select().disabled).toBe(false);
  });

  it("adopts the session a failed start actually created", async () => {
    api.startAdapterAuthLogin.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    api.getActiveAdapterAuthLoginSession.mockRejectedValueOnce(notFound()).mockResolvedValue(session("session-9", "sandbox-a"));
    await openSubscription();

    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);
    expect(barrierUp()).toBe(true);
    await click("Cancel sign-in");
    expect(api.cancelAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", "session-9");
    expect(select().disabled).toBe(false);
  });

  it("releases after a failed start once the server confirms no session", async () => {
    api.startAdapterAuthLogin.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    await openSubscription();
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Failed to fetch");
    expect(select().disabled).toBe(false);
    expect(button("Back")!.disabled).toBe(false);
  });

  it("stays closed when discovery fails, starting nothing until Check again succeeds", async () => {
    api.getActiveAdapterAuthLoginSession.mockRejectedValueOnce(serverError());
    await render();
    await openSubscription();
    expect(api.startAdapterAuthLogin).not.toHaveBeenCalled();
    expect(barrierUp()).toBe(true);

    await click("Check again");
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    expect(barrierUp()).toBe(true);
    expect(button("Cancel sign-in")).toBeTruthy();
  });

  it("never cancels on unmount, and resumes the same session on remount", async () => {
    await render();
    await openSubscription();
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(api.cancelAdapterAuthLogin).not.toHaveBeenCalled();

    root = createRoot(container);
    api.getActiveAdapterAuthLoginSession.mockResolvedValue(session("session-1", "sandbox-a"));
    await render();
    await openSubscription();
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    expect(barrierUp()).toBe(true);
    await click("Cancel sign-in");
    expect(api.cancelAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", "session-1");
  });

  it("holds, never resumes, a remounted session from another environment until it is cancelled", async () => {
    api.getActiveAdapterAuthLoginSession.mockResolvedValue(session("session-b", "sandbox-b"));
    await render();
    await openSubscription();
    expect(api.startAdapterAuthLogin).not.toHaveBeenCalled();
    expect(api.getAdapterAuthLoginStatus).not.toHaveBeenCalled();
    expect(container.textContent).toContain("still running in another environment");
    expect(barrierUp()).toBe(true);
    await click("Cancel sign-in");
    expect(api.cancelAdapterAuthLogin).toHaveBeenCalledWith("company-1", "codex_local", "session-b");
    expect(select().disabled).toBe(false);
  });

  it("defers a policy environment change until the barrier clears", async () => {
    await render();
    await openSubscription();
    await act(async () => cache.setQueryData(queryKeys.instance.settings, { defaultEnvironmentId: "sandbox-b" }));
    await settle();

    // Still on the captured environment: no remount, no second start.
    expect(authSignalFor("sandbox-b")).toBe(false);
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    expect(barrierUp()).toBe(true);

    await click("Cancel sign-in");
    expect(authSignalFor("sandbox-b")).toBe(true);
    expect(container.textContent).toContain("The environment changed while you were signing in");
    expect(container.textContent).toContain("Sign in again for Sandbox B");

    // A new sign-in on the current environment retires the notice.
    await openSubscription();
    expect(api.startAdapterAuthLogin).toHaveBeenLastCalledWith("company-1", "codex_local", expect.objectContaining({ environmentId: "sandbox-b" }));
    expect(container.textContent).not.toContain("The environment changed while you were signing in");
  });

  it("drops a sign-in that completes on an environment the setup has left", async () => {
    await render();
    await openSubscription();
    await act(async () => cache.setQueryData(queryKeys.instance.settings, { defaultEnvironmentId: "sandbox-b" }));
    await settle();

    api.getAdapterAuthLoginStatus.mockResolvedValue(session("session-1", "sandbox-a", "authenticated"));
    await act(async () => cache.invalidateQueries({ queryKey: ["adapter-login-status"] }));
    await settle();

    expect(container.textContent).not.toContain("Configure your agent");
    expect(container.textContent).toContain("The environment changed while you were signing in");
    expect(container.textContent).toContain("Sign in again for Sandbox B");
    expect(button("Finish setup")).toBeUndefined();
    expect(authSignalFor("sandbox-b")).toBe(true);
    expect(select().disabled).toBe(false);
    expect(api.hire).not.toHaveBeenCalled();
  });

  it("moves to Configure and finishes when the sign-in completes on the current environment", async () => {
    await render();
    await openSubscription();
    api.getAdapterAuthLoginStatus.mockResolvedValue(session("session-1", "sandbox-a", "authenticated"));
    await act(async () => cache.invalidateQueries({ queryKey: ["adapter-login-status"] }));
    await settle();

    expect(container.textContent).toContain("Configure your agent");
    await click("Finish setup");
    expect(api.hire.mock.calls[0]?.[1]).toMatchObject({ defaultEnvironmentId: null });
  });

  it("runs the same barrier through the Claude submitted-code panel", async () => {
    const claude = (status?: string) => ({
      ...session("claude-1", "sandbox-a", status),
      prompt: null,
      aiConnection: { ...session("", "").aiConnection, provider: "anthropic", name: "My Claude subscription" },
    });
    api.getActiveClaudeSetupTokenLoginSession.mockRejectedValue(notFound());
    api.startClaudeSetupTokenLogin.mockResolvedValue(claude("starting"));
    api.getClaudeSetupTokenLoginStatus.mockResolvedValue(claude());
    api.getClaudeSetupTokenLoginPrompt.mockResolvedValue({ authorizationUrl: "https://claude.example.test/authorize" });
    api.cancelClaudeSetupTokenLogin.mockRejectedValueOnce(serverError()).mockResolvedValue(undefined);
    await render("claude_local");
    await openSubscription("Claude");
    expect(barrierUp()).toBe(true);

    expect(container.querySelector("input")).toBeTruthy();
    api.getActiveClaudeSetupTokenLoginSession.mockResolvedValue(claude());
    await click("Cancel sign-in");
    expect(barrierUp()).toBe(true);
    // The paste field is back, with the failure beside Cancel.
    expect(container.querySelector("input")).toBeTruthy();
    expect(container.textContent).toContain("Server error");

    await click("Cancel sign-in");
    expect(api.cancelClaudeSetupTokenLogin).toHaveBeenCalledTimes(2);
    expect(select().disabled).toBe(false);
  });

  it("starts no sign-in while the auth signal is pending, nor once it answers present", async () => {
    let resolveAuth: (value: unknown) => void = () => {};
    api.getAdapterAuthSignal.mockReturnValue(new Promise((resolve) => (resolveAuth = resolve)));
    await render();
    await openSubscription();
    expect(container.textContent).toContain("Checking for an existing sign-in");
    expect(api.getActiveAdapterAuthLoginSession).not.toHaveBeenCalled();
    expect(api.startAdapterAuthLogin).not.toHaveBeenCalled();
    expect(select().disabled).toBe(false);

    await act(async () => resolveAuth({ status: "present" }));
    await settle();
    expect(container.textContent).toContain("Use the existing provider connection");
    expect(api.getActiveAdapterAuthLoginSession).not.toHaveBeenCalled();
    expect(api.startAdapterAuthLogin).not.toHaveBeenCalled();
    expect(select().disabled).toBe(false);
    expect(button("Back")!.disabled).toBe(false);
  });

  it("closes a cancelled new sign-in when a saved subscription is picked", async () => {
    aiConnections.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [{ id: "conn-1", companyId: "company-1", provider: "openai", method: "subscription", status: "connected", ownership: "shared", grantId: "grant-1", name: "Team" }],
    });
    await render();
    const saved = () => container.querySelector('[aria-label="Saved subscription"]') as HTMLSelectElement;
    const pickSaved = async (id: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(saved(), id);
        saved().dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    };
    await pickSaved("");
    await openSubscription();
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    await click("Cancel sign-in");
    expect(container.textContent).toContain("The sign-in was cancelled.");

    await pickSaved("ai:grant-1");
    expect(container.textContent).not.toContain("The sign-in was cancelled.");
    expect(button("Use saved subscription")).toBeTruthy();
    expect(api.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
  });

  it("keeps an ended sign-in open when a saved subscription list appears without a pick", async () => {
    await render();
    await openSubscription();
    await click("Cancel sign-in");
    aiConnections.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [{ id: "conn-1", companyId: "company-1", provider: "openai", method: "subscription", status: "connected", ownership: "shared", grantId: "grant-1", name: "Team" }],
    });
    await act(async () => cache.invalidateQueries({ queryKey: ["ai-connections"] }));
    await settle();

    const saved = container.querySelector('[aria-label="Saved subscription"]') as HTMLSelectElement;
    expect(saved.value).toBe("");
    expect(container.textContent).toContain("The sign-in was cancelled.");
    expect(button("Start sign-in again")).toBeTruthy();
    expect(button("Use saved subscription")).toBeUndefined();
  });

  it("ignores a reconciliation that answers after its panel unmounted", async () => {
    api.startAdapterAuthLogin.mockRejectedValue(new TypeError("Failed to fetch"));
    let resolveActive: (value: unknown) => void = () => {};
    api.getActiveAdapterAuthLoginSession
      .mockRejectedValueOnce(notFound())
      .mockReturnValueOnce(new Promise((resolve) => (resolveActive = resolve)));
    const onSessionChange = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <AdapterLoginPanel
            companyId="company-1"
            adapterType="codex_local"
            environmentId="sandbox-a"
            chrome="onboarding"
            aiConnection={session("", "").aiConnection as never}
            autoStart
            onStored={() => {}}
            onSessionChange={onSessionChange}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(api.getActiveAdapterAuthLoginSession).toHaveBeenCalledTimes(2);

    await act(async () => root.render(null));
    await act(async () => resolveActive(session("session-9", "sandbox-a")));
    await settle();
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});
