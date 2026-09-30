import { useId } from "react";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const AGENTMAIL_API_KEYS_URL = getAppStoreDefinition("agentmail")!.methods[0]!.consoleLinks!.keys!;

export function AgentMailApiKeyField({ value, onChange, disabled = false, label = "API key" }: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  return <div className="space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="password" autoComplete="off" value={value}
      disabled={disabled} onChange={event => onChange(event.target.value)}
      placeholder="Paste your AgentMail API key" />
    <a href={AGENTMAIL_API_KEYS_URL} target="_blank" rel="noreferrer" className="text-sm underline">
      Get an AgentMail API key ↗
    </a>
  </div>;
}
