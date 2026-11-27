import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";
import { OpenAppResultSchema } from "../../../src/cli/commands/open";
import { fixture, invoke, observedEntry } from "./call-process-fixture";

const routedApp = async () => {
  const fixtureData = await fixture();
  await writeFile(
    join(fixtureData.call.app.root, ".lando.yml"),
    `name: demo
services:
  appserver:
    type: nginx
    primary: true
    routes:
      - demo.lndo.site
      - "*.demo.lndo.site/docs"
  inspection-failure:
    type: nginx
    routes:
      - secondary.demo.lndo.site
`,
  );
  await writeFile(join(fixtureData.paths.userConfRoot, "config.yml"), "router:\n  httpPort: 19001\n");
  return fixtureData;
};

const decodeEnvelope = Schema.decodeUnknownSync(CommandResultEnvelope);
const decodeOpen = Schema.decodeUnknownSync(OpenAppResultSchema);

test.each([
  {
    argv: ["open", "docs.demo.lndo.site", "--print", "--format=json"],
    host: "docs.demo.lndo.site",
    path: "/docs",
  },
  { argv: ["app:open", "--service=appserver", "--print", "--format=yaml"], host: "demo.lndo.site", path: "" },
  { argv: ["open", "-s", "appserver", "--qr", "-j"], host: "demo.lndo.site", path: "" },
])("child resolves $argv without inspecting the unrelated service", async ({ argv, host, path }) => {
  const { call, paths } = await routedApp();
  const result = await invoke({ ...call, argv }, paths, observedEntry);
  expect(result.exitCode).toBe(0);
  const envelope = decodeEnvelope(Bun.YAML.parse(result.stdout));
  expect(envelope).toMatchObject({ apiVersion: "v4", command: "app:open", ok: true });
  expect(decodeOpen(envelope.result)).toEqual({
    app: "demo",
    launch: "printed",
    targets: [{ service: "appserver", hostname: host, scheme: "https", url: `https://${host}:19001${path}` }],
  });
});

test("child keeps the primary and peer errors while redacting the failure envelope", async () => {
  const { call, paths } = await routedApp();
  const result = await invoke(
    { ...call, argv: ["open", "--service=inspection-failure", "--print", "--format=json"] },
    paths,
    observedEntry,
  );
  expect(result.exitCode).toBe(1);
  expect(decodeEnvelope(JSON.parse(result.stdout))).toMatchObject({
    command: "app:open",
    ok: false,
    error: {
      _tag: "ProviderUnavailableError",
      providerId: "lando",
      operation: "inspect",
      additionalErrors: [{ _tag: "LandoInternalError", role: "peer", message: "inspection cleanup failed" }],
    },
  });
  expect(result.stdout + result.stderr).not.toContain("inspection-canary");
});

test.each(["missing", "https://user:selection-canary@missing.example"])(
  "child returns an unresolved selection instead of inspecting another service: %s",
  async (selector) => {
    const { call, paths } = await routedApp();
    const result = await invoke(
      { ...call, argv: ["open", "--service", selector, "--print", "--format=json"] },
      paths,
      observedEntry,
    );
    expect(result.exitCode).toBe(1);
    expect(decodeEnvelope(JSON.parse(result.stdout))).toMatchObject({
      command: "app:open",
      ok: false,
      error: { _tag: "OpenTargetUnresolvedError", app: "demo" },
    });
    expect(result.stdout + result.stderr).not.toContain("selection-canary");
  },
);

test("child rejects an unsupported result format without bootstrapping open", async () => {
  const { call, paths } = await fixture();
  const result = await invoke({ ...call, argv: ["open", "--format=xml"] }, paths, observedEntry);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("xml");
  expect(await Bun.file(join(paths.userDataRoot, "events.jsonl")).exists()).toBe(false);
});

test("child honors explicit text format ahead of the JSON shortcut", async () => {
  const { call, paths } = await routedApp();
  const result = await invoke(
    { ...call, argv: ["open", "--print", "--format=text", "-j"] },
    paths,
    observedEntry,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("appserver\thttps://demo.lndo.site:19001");
});
