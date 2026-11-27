import { describe, expect, test } from "bun:test";
import type { ProcessResult } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect, Exit, Stream } from "effect";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import type { SocketProxyDependencies } from "../src/proxy-types.ts";
import { socketProxyPolkitHeader, socketProxyUnitHeader } from "../src/socket-proxy-helper.ts";
import { POLKIT_RULE_PATH, PROXYD_CANDIDATES, SOCKET_UNIT_PATHS } from "../src/socket-proxy-install.ts";
import { SOCKET_HELPER_CHANGE } from "../src/socket-proxy-plan.ts";
import { makeAckStore } from "./observe-routes-fixture.ts";
import { approvedRouterHelper } from "./socket-helper-approval.ts";

const ROOT = "/lando";
const GONE = "/lando/gone";
const ok = (): ProcessResult => ({ exitCode: 0, stdout: "", stderr: "" });
const config = { defaultDomain: "lndo.site" };

const foreignUnits = (owner: string | undefined): Record<string, string> => ({
  ...Object.fromEntries(
    SOCKET_UNIT_PATHS.map((path) => [
      path,
      owner === undefined ? "# lando-proxy-socket-helper\n" : `${socketProxyUnitHeader(owner)}\n`,
    ]),
  ),
  ...(owner === undefined ? {} : { [POLKIT_RULE_PATH]: socketProxyPolkitHeader(owner) }),
});

/** A Linux router whose ports 80 and 443 need privilege, with host files the helper may own. */
const harness = (
  hostFiles: Readonly<Record<string, string>> = {},
  unprivilegedStart: ProcessResult = ok(),
) => {
  const elevations: string[] = [];
  const starts: string[] = [];
  const host = new Map(Object.entries(hostFiles));
  const files = new Map<string, string>();
  const elevate = (command: ReadonlyArray<string>) =>
    Effect.sync(() => {
      elevations.push(command.join(" "));
      return ok();
    });
  const socketProxy: SocketProxyDependencies = {
    user: "lando-dev",
    userDataRoot: ROOT,
    hasHostSystemd: () => true,
    exists: (path) =>
      Effect.succeed(host.has(path) || PROXYD_CANDIDATES.some((candidate) => candidate === path)),
    readText: (path) =>
      host.has(path) ? Effect.succeed(host.get(path) ?? "") : Effect.fail(new Error(path)),
    processRunner: {
      run: (input) =>
        Effect.sync(() => {
          const script = input.args?.join(" ") ?? "";
          if (!script.includes("systemctl start")) return ok();
          starts.push(script);
          return unprivilegedStart;
        }),
      stream: () => Stream.empty,
      streamWithExit: () => Stream.empty,
    },
    classifyOverride: {
      http: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
      https: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
    },
    probeForward: () => Effect.succeed({ kind: "success" }),
  };
  const router = makeTraefikRouterService({
    stateStore: makeAckStore([]),
    probeForward: () => Effect.succeed({ kind: "success" }),
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      exists: (path) => Effect.succeed(files.has(path)),
      readText: (path) => Effect.succeed(files.get(path) ?? ""),
      readDir: () => Effect.succeed([]),
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: { ensureRunning: () => Effect.succeed([]) },
    socketProxy,
  });
  const plan = () => Effect.runPromise(router.planHostChanges?.(config) ?? Effect.succeed([]));
  const setup = (options: Parameters<typeof router.setup>[1]) =>
    Effect.runPromiseExit(Effect.scoped(router.setup(config, options)));
  return { router, elevations, starts, files, host, elevate, plan, setup };
};

/** Host files as the planned install script would leave them: this data root's helper. */
const installedHelper = async (): Promise<Record<string, string>> => {
  const [planned] = await harness().plan();
  const script = planned?.change.steps[0]?.argv[2] ?? "";
  return Object.fromEntries(
    [...script.matchAll(/cat > (\S+) <<'LANDO_PROXY_EOF'\n([\s\S]*?)LANDO_PROXY_EOF/gu)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
};

describe("planning the router's port helper", () => {
  test("proposes one recommended change with the exact install script, and changes nothing", async () => {
    const { plan, elevations, files } = harness();

    const proposals = await plan();

    expect(
      proposals.map(({ change }) => [change.id, change.stage, change.consent, change.requirement]),
    ).toEqual([[SOCKET_HELPER_CHANGE, "proxy", "standard", "recommended"]]);
    const [step] = proposals[0]?.change.steps ?? [];
    expect(step?.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(step?.argv[2]).toContain("127.0.0.1:38080");
    expect(elevations).toEqual([]);
    expect([...files.keys()]).toEqual([]);
  });

  test.each([
    ["a helper left by a removed data root", foreignUnits(GONE), "standard"],
    ["a helper an older build left without an owner", foreignUnits(undefined), "interactive-only"],
  ] as const)("plans taking over %s", async (_name, hostFiles, consent) => {
    const proposals = await harness(hostFiles).plan();

    expect(proposals.map(({ change }) => change.consent)).toEqual([consent]);
    expect(proposals[0]?.change.summary).toContain("Take over");
  });

  test("never plans replacing another data root's helper", async () => {
    expect(await harness({ ...foreignUnits("/lando/other"), "/lando/other": "dir" }).plan()).toEqual([]);
  });
});

describe("its own helper whose sockets are down", () => {
  const refused: ProcessResult = { exitCode: 4, stdout: "", stderr: "Access denied" };

  test("is planned as a repair whose root step runs only if needed", async () => {
    const [proposal] = await harness(await installedHelper()).plan();

    expect(proposal?.change.summary).toBe(
      "Repair the helper that serves ports 80 and 443 if it cannot start",
    );
    expect(proposal?.change.consent).toBe("standard");
    expect(proposal?.change.steps.map(({ when, privileged }) => [when, privileged])).toEqual([
      ["if-needed", true],
    ]);
  });

  test("an approved repair starts it through its grant and runs nothing as root when that works", async () => {
    const { router, setup, elevations, starts, elevate } = harness(await installedHelper());
    const hostChanges = await Effect.runPromise(approvedRouterHelper(router, config, elevate));

    expect(Exit.isSuccess(await setup({ intent: "configure", hostChanges }))).toBe(true);
    expect(starts.length).toBeGreaterThan(0);
    expect(elevations).toEqual([]);
  });

  test("an approved repair runs the planned script as root only when the grant refuses", async () => {
    const { router, plan, setup, elevations, elevate } = harness(await installedHelper(), refused);
    const [planned] = await plan();
    const hostChanges = await Effect.runPromise(approvedRouterHelper(router, config, elevate));

    expect(Exit.isSuccess(await setup({ intent: "configure", hostChanges }))).toBe(true);
    expect(elevations).toEqual([planned?.change.steps[0].argv.join(" ") ?? "the planned script"]);
  });

  test("app start tries only the grant, keeps the fallback ports, and names doctor --fix", async () => {
    const { router, elevations, starts, files } = harness(await installedHelper(), refused);

    const exit = await Effect.runPromiseExit(Effect.scoped(router.setup(config, { intent: "ensure" })));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(starts).toHaveLength(1);
    expect(elevations).toEqual([]);
    const acquisition = files.get(
      acquisitionStateFile({ platform: "linux", globalAppRoot: "/lando/global" }),
    );
    expect(acquisition).toContain("Run `lando doctor --fix` to repair it, after asking.");
    expect(acquisition).not.toContain('"mode":"socket-helper"');
  });
});

describe("applying the router's port helper", () => {
  test("setup installs exactly the planned script once it is approved", async () => {
    const { router, plan, setup, elevations, elevate } = harness();
    const [planned] = await plan();
    const hostChanges = await Effect.runPromise(approvedRouterHelper(router, config, elevate));

    const exit = await setup({ intent: "configure", hostChanges });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(elevations).toEqual([planned?.change.steps[0].argv.join(" ") ?? "a planned install"]);
  });

  test("setup without approval installs nothing", async () => {
    const { setup, elevations } = harness();

    expect(Exit.isSuccess(await setup({ intent: "configure" }))).toBe(true);
    expect(elevations).toEqual([]);
  });

  test("app start never installs the helper and names lando setup instead", async () => {
    const { router, elevations, elevate, files } = harness();
    const hostChanges = await Effect.runPromise(approvedRouterHelper(router, config, elevate));

    const exit = await Effect.runPromiseExit(
      Effect.scoped(router.setup(config, { intent: "ensure", hostChanges })),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(elevations).toEqual([]);
    expect(files.get(acquisitionStateFile({ platform: "linux", globalAppRoot: "/lando/global" }))).toContain(
      "only `lando setup` or `lando doctor --fix` installs",
    );
  });

  test("a helper that changed after planning is stale and nothing runs", async () => {
    const { router, host, setup, elevations, elevate } = harness();
    const hostChanges = await Effect.runPromise(approvedRouterHelper(router, config, elevate));
    for (const [path, text] of Object.entries(foreignUnits("/lando/other"))) host.set(path, text);
    host.set("/lando/other", "dir");

    expect(Exit.isSuccess(await setup({ intent: "configure", hostChanges }))).toBe(true);
    expect(elevations).toEqual([]);
  });
});
