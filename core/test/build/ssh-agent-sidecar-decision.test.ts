import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

const sectionBetween = (source: string, startHeading: string, endHeading: string): string => {
  const start = source.indexOf(startHeading);
  expect(start, `expected to find heading: ${startHeading}`).toBeGreaterThanOrEqual(0);
  const afterStart = start + startHeading.length;
  const end = source.indexOf(endHeading, afterStart);
  return end === -1 ? source.slice(afterStart) : source.slice(afterStart, end);
};

describe("SSH-agent sidecar opt-out decision", () => {
  test("publishes a Beta 1 decision note rejecting direct host-agent socket mounts", async () => {
    const decisions = await readText("docs/beta-1-decisions.md");

    expect(decisions).toContain("## SSH-agent sidecar opt-out decision");
    expect(decisions).toContain("sshAgent.sidecar: true");
    expect(decisions).toContain("sshAgent.sidecar: false");
    expect(decisions).toMatch(/reject/i);
    expect(decisions).toContain("direct host SSH-agent socket");
  });

  test("moves the sshAgent.sidecar false row from §14.2 open decisions into resolved", async () => {
    const tenets = await readText("spec/01-mission-and-tenets.md");

    const openDecisions = sectionBetween(tenets, "### 14.2 Open decisions", "**Resolved since this draft:**");
    const resolved = sectionBetween(tenets, "**Resolved since this draft:**", "**Deferred to post-v4.0");

    expect(openDecisions).not.toContain("sshAgent.sidecar: false");
    expect(resolved).toContain("sshAgent.sidecar: false");
    expect(resolved).toMatch(/reject/i);
  });

  test("documents reserved false and the supported sidecar path", async () => {
    const subsystemSpec = await readText("spec/11-subsystems.md");
    const guide = await readText("docs/guides/subsystems/ssh-sidecar.mdx");

    expect(subsystemSpec).toContain("sshAgent.sidecar: true");
    expect(subsystemSpec).toContain("sshAgent.sidecar: false");
    expect(subsystemSpec).toContain("reserved");
    expect(subsystemSpec).toContain("rejected");
    expect(guide).toContain("sshAgent.sidecar: false");
    expect(guide).toContain("reserved");
  });
});
