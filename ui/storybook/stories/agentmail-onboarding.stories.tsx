import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { EmailEndpointSetup } from "@/pages/apps/chat/EmailEndpointSetup";
import { ChatSetupSidebar } from "@/components/chat/ChatSetupNavigation";
import { ChatSetupSidebarProvider } from "@/context/ChatSetupSidebarContext";
import { useCompany } from "@/context/CompanyContext";
import { useLocation, useNavigate } from "@/lib/router";
import { storybookAgents } from "../fixtures/paperclipData";

const COMPANY = "company-storybook";
const CONNECTION = "agentmail-storybook-account";
const ADDRESS_TAKEN = "This email address is already in use. Choose a different address.";
const agents = storybookAgents.map((agent, index) => ({
  ...agent, name: ["Ralph", "Support", "Research"][index] ?? agent.name,
  permissions: {},
}));

// Render the production setup. Only the API is simulated; no real keys or inboxes.
function AgentMailJourney({ savedConnection = true }: { savedConnection?: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { selectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    navigate(`/apps/chat/connect?provider=agentmail${savedConnection ? `&connectionId=${CONNECTION}` : ""}`, { replace: true });
    setReady(true);
  }, [navigate, savedConnection, ready]);
  if (!ready || !selectedCompanyId) return null;
  if (!pathname.endsWith("/apps/chat/connect")) return <div className="p-6 text-sm">Setup complete.</div>;
  return <ChatSetupSidebarProvider>
    <div className="min-h-screen bg-background text-foreground md:flex">
      <div className="hidden w-60 shrink-0 md:block"><ChatSetupSidebar /></div>
      <main className="min-w-0 flex-1 py-6"><EmailEndpointSetup /></main>
    </div>
  </ChatSetupSidebarProvider>;
}

type Scenario = { scopedKey?: boolean; missingBoundary?: boolean; denySetup?: boolean };
const meta = {
  title: "Connections/AgentMail setup",
  component: AgentMailJourney,
  parameters: { layout: "fullscreen" },
  args: { savedConnection: true },
  beforeEach(context) {
    const scenario = (context.parameters.agentmailScenario ?? {}) as Scenario;
    sessionStorage.removeItem(`paperclip.agentmail-setup:${COMPANY}:${CONNECTION}`);
    sessionStorage.removeItem(`paperclip.agentmail-setup:${COMPANY}:new`);
    const fixtureAgents = agents.map(agent => ({ ...agent, permissions: scenario.missingBoundary ? { trustPreset: "low_trust_review" } : {} }));
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname === `/api/companies/${COMPANY}/agents`) return Response.json(fixtureAgents);
      const agent = fixtureAgents.find(agent => url.pathname === `/api/agents/${agent.id}` || url.pathname === `/api/agents/${agent.id}/permissions`);
      if (agent) {
        if (method === "PATCH") agent.permissions = body;
        return Response.json({ ...agent, access: { canAssignTasks: false } });
      }
      if (url.pathname.endsWith("/email/connections") && method === "POST") {
        if (body.apiKey === "invalid-key") return Response.json({ error: "AgentMail rejected the API key. Check it and try again." }, { status: 422 });
        if (body.grantKind !== "organization" || body.allAgents !== false || body.agentIds.length !== 1) {
          return Response.json({ error: "Unexpected access defaults in preview." }, { status: 422 });
        }
        return Response.json({ id: CONNECTION }, { status: 201 });
      }
      if (url.pathname.endsWith("/email/connections/" + CONNECTION + "/inspect")) return Response.json({
        scope: { scope_type: scenario.scopedKey ? "inbox" : "organization" },
        inboxes: [{ inbox_id: "support@agentmail.to" }, { inbox_id: "help@paperclip.example" }],
        domains: [{ domain_id: "custom-domain", domain: "paperclip.example", status: "VERIFIED" }],
      });
      if (url.pathname.endsWith("/email/inboxes")) {
        if (method === "GET") return Response.json([]);
        if (body.username === "taken") return Response.json({ error: ADDRESS_TAKEN, code: "agentmail_address_taken",
          details: { field: "username", providerStatus: 403, operation: "create_inbox" } }, { status: 409 });
        if (scenario.denySetup) return Response.json({ error: "AgentMail did not allow Paperclip to create the email address. Check your API key permissions and AgentMail account limits, then try again." }, { status: 422 });
        return Response.json({ id: body.idempotencyKey, connectionId: "storybook-inbox-connection", companyId: COMPANY,
          assignedAgentId: body.assignedAgentId, address: body.inboxId ?? `${body.username}@${body.domain}`, status: "active", receiveMode: body.receiveMode }, { status: 201 });
      }
      return original(input, init);
    };
    return () => { window.fetch = original; };
  },
} satisfies Meta<typeof AgentMailJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

const chooseAgent: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("combobox"));
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.type(page.getByPlaceholderText("Search all agents…"), "Ralph");
  await userEvent.click(await page.findByRole("option", { name: "Ralph" }));
};
const chooseAddress: NonNullable<Story["play"]> = async context => {
  await chooseAgent(context);
  const canvas = within(context.canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
  await expect(await canvas.findByLabelText("Ralph’s email address")).toHaveValue("ralph");
};
const takenAddress: NonNullable<Story["play"]> = async context => {
  await chooseAddress(context);
  const canvas = within(context.canvasElement);
  await userEvent.clear(canvas.getByLabelText("Ralph’s email address"));
  await userEvent.type(canvas.getByLabelText("Ralph’s email address"), "taken");
  await userEvent.click(canvas.getByRole("button", { name: "Create email address" }));
  await expect(await canvas.findByRole("alert")).toHaveTextContent(ADDRESS_TAKEN);
  await expect(canvas.getByLabelText("Ralph’s email address")).toHaveAttribute("aria-invalid", "true");
};

export const Walkthrough: Story = { name: "Start here · Pick agent, pick email" };
export const ChooseAgent: Story = { name: "01 · Pick an agent" };
export const ChooseAddress: Story = { name: "02 · Pick their email", play: chooseAddress };
export const AddressTaken: Story = { name: "Error · Email address already in use", play: takenAddress };
export const ExistingInbox: Story = { name: "Use an existing inbox", play: async context => {
  await chooseAddress(context);
  await userEvent.click(within(context.canvasElement).getByRole("button", { name: "Use an existing inbox" }));
} };
export const AdvancedOptions: Story = { name: "Advanced · Domain and email settings", play: async context => {
  await chooseAddress(context);
  await userEvent.click(within(context.canvasElement).getByText("Advanced options"));
} };
export const MissingTrustBoundary: Story = { name: "Existing low-trust agent · Work boundary required",
  parameters: { agentmailScenario: { missingBoundary: true } }, play: chooseAgent };
export const NewConnection: Story = { name: "First time · API key alongside the agent", args: { savedConnection: false } };
export const InvalidKey: Story = { name: "Error · Invalid API key", args: { savedConnection: false }, play: async context => {
  await chooseAgent(context);
  const canvas = within(context.canvasElement);
  await userEvent.type(canvas.getByLabelText("API key"), "invalid-key");
  await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
  await expect(await canvas.findByRole("alert")).toHaveTextContent("AgentMail rejected the API key");
} };
export const ProviderDenied: Story = { name: "Error · Provider permission denied", parameters: { agentmailScenario: { denySetup: true } }, play: async context => {
  await chooseAddress(context);
  await userEvent.click(within(context.canvasElement).getByRole("button", { name: "Create email address" }));
  await expect(await within(context.canvasElement).findByRole("alert")).toHaveTextContent("AgentMail did not allow");
} };
export const Ready: Story = { name: "Done · Email ready", play: async context => {
  await chooseAddress(context);
  const canvas = within(context.canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Create email address" }));
  await expect(await canvas.findByRole("heading", { name: "Your agent’s email is ready" })).toBeVisible();
} };
export const Mobile: Story = { name: "Mobile · Pick their email", globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true }, play: chooseAddress };
export const TestedWalkthrough: Story = { name: "Verification · Correct a taken address and finish", play: async context => {
  await takenAddress(context);
  const canvas = within(context.canvasElement);
  await userEvent.clear(canvas.getByLabelText("Ralph’s email address"));
  await userEvent.type(canvas.getByLabelText("Ralph’s email address"), "ralph-team");
  await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole("button", { name: "Create email address" }));
  await expect(await canvas.findByRole("heading", { name: "Your agent’s email is ready" })).toBeVisible();
  await expect(canvas.getByText("ralph-team@agentmail.to", { exact: true })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Done" }));
  await expect(await canvas.findByText("Setup complete.")).toBeVisible();
} };
