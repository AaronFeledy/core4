import { describe, expect, test } from "bun:test";
import { type HostChange, HostChangeId, type HostChangePlanEntry } from "@lando/sdk/schema";
import { renderHostChangePlan } from "../../src/cli/host-changes/render";

const trust: HostChange = {
  id: HostChangeId.make("ca-mkcert:trust-system-store"),
  owner: "@lando/ca-mkcert",
  stage: "ca",
  summary: "Trust Lando's local CA in the system store",
  reason: "Browsers and tools trust Lando's certificates.",
  consent: "standard",
  persistent: true,
  requirement: "required",
  manual: "sudo install -m 0644 rootCA.pem /etc/x",
  steps: [
    {
      id: "write",
      summary: "write",
      argv: ["/usr/bin/tee", "/etc/x"],
      privileged: true,
      stdin: {
        summary: "The local CA certificate",
        boundAt: "apply",
        verifiedBy: "one X.509 CA certificate",
      },
      when: "always",
    },
  ],
  undo: { _tag: "none", detail: "Nothing to undo." },
};

const linger: HostChange = {
  ...trust,
  id: HostChangeId.make("ca-mkcert:linger"),
  summary: "Enable lingering",
  consent: "separate",
  optInFlag: "enable-linger",
  requirement: "recommended",
  steps: [
    {
      id: "on",
      summary: "on",
      argv: ["/usr/bin/loginctl", "enable-linger"],
      privileged: true,
      when: "always",
    },
  ],
};

describe("renderHostChangePlan", () => {
  test("says what this run does with each change and which flags approve it", () => {
    const entries: ReadonlyArray<HostChangePlanEntry> = [
      { change: trust, approval: "blocked", approvedBy: ["--yes"] },
      { change: linger, approval: "will-skip", approvedBy: ["--enable-linger"] },
    ];

    const text = renderHostChangePlan(entries, { state: "will-prompt" }).join("\n");

    expect(text).toContain(
      "- Trust Lando's local CA in the system store (required, this run stops before changing anything; --yes approves it)",
    );
    expect(text).toContain(
      "- Enable lingering (recommended, this run skips it; --enable-linger approves it)",
    );
  });

  test("shows how input bound at apply is checked", () => {
    const text = renderHostChangePlan([{ change: trust, approval: "will-ask", approvedBy: ["--yes"] }], {
      state: "will-prompt",
    }).join("\n");

    expect(text).toContain(
      "$ sudo /usr/bin/tee /etc/x  (input: The local CA certificate; checked when applied: one X.509 CA certificate)",
    );
  });
});
