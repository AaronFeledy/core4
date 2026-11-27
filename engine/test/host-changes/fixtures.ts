import { type HostChange, HostChangeId } from "@lando/sdk/schema";
import type { HostChangeProposal } from "@lando/sdk/services";
import { Effect } from "effect";

export const change = (overrides: Partial<HostChange> = {}): HostChange => ({
  id: HostChangeId.make("provider-test:enable-thing"),
  owner: "@lando/provider-test",
  stage: "provider",
  summary: "Enable the thing",
  reason: "The runtime needs the thing.",
  consent: "standard",
  persistent: false,
  requirement: "required",
  steps: [
    {
      id: "enable",
      summary: "Enable it",
      argv: ["/usr/bin/thing", "enable"],
      privileged: true,
      when: "always",
    },
  ],
  undo: { _tag: "none", detail: "Nothing to undo." },
  ...overrides,
});

export const proposal = (
  overrides: Partial<HostChange> = {},
  apply: HostChangeProposal["apply"] = () => Effect.succeed({ changed: true }),
): HostChangeProposal => ({ change: change(overrides), apply });
