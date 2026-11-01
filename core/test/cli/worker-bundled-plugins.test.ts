import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");

// A fresh process proves the worker factory registers bundled plugins itself: detached
// workers never pass through the CLI dispatch paths that register them.
const bundledCountAfter = async (factory: string): Promise<string> => {
  const script = `
    import { bundledPluginModules } from "@lando/engine/composition";
    // bundledPluginModules() throws until some module installs the engine composition.
    const count = () => { try { return bundledPluginModules().length; } catch { return 0; } };
    const before = count();
    ${factory}
    console.log(JSON.stringify({ before, after: count() }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  return stdout.trim().split("\n").at(-1) ?? "";
};

test("the host-proxy open child registers bundled plugins before building", async () => {
  const call = {
    operation: "openUrl",
    url: "https://example.com",
    app: { kind: "user", id: "demo", root: "/tmp" },
    mount: { containerRoot: "/app", hostRoot: "/tmp" },
    cwd: "/app",
    callId: "call-1",
    depth: 0,
    callerService: "web",
  };
  const result = JSON.parse(
    await bundledCountAfter(
      `const { hostProxyOpenLayer } = await import(${JSON.stringify(`${repo}/core/src/cli/host-proxy/call-open.ts`)}); await hostProxyOpenLayer(${JSON.stringify(call)});`,
    ),
  );
  expect(result.before).toBe(0);
  expect(result.after).toBeGreaterThan(0);
}, 60_000);

test("the agent-relay worker runtime registers bundled plugins before building", async () => {
  const result = JSON.parse(
    await bundledCountAfter(
      `const { defaultAgentRelayRuntime } = await import(${JSON.stringify(`${repo}/core/src/cli/agent-relay/worker-runtime.ts`)}); await defaultAgentRelayRuntime({ app: { root: "/tmp" }, paths: {} });`,
    ),
  );
  expect(result.before).toBe(0);
  expect(result.after).toBeGreaterThan(0);
}, 60_000);
