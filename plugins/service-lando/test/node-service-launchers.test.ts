import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { ServiceLaunchers, type ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import { nodeLtsServiceType, nodeServiceType } from "../src/services/node.ts";
import { nodeServiceLaunchers } from "../src/services/node-service-launchers.ts";

const metadata = {
  resolvedAt: "2026-11-19T00:00:00Z",
  source: "/srv/apps/node-launchers/.lando.yml",
  runtime: 4 as const,
};

const present = (path: string, text: string): ServiceTypeProjectFileInput => ({
  path,
  present: true,
  text,
  sha256: sha256Hex(text),
});

const packageJson = (path: string, value: Record<string, unknown>): ServiceTypeProjectFileInput =>
  present(path, JSON.stringify(value));

const decodeLaunchers = (value: unknown) => Schema.decodeUnknownSync(ServiceLaunchers)(value);

describe("nodeServiceLaunchers table", () => {
  test.each([
    [undefined, ["npm", "exec", "--no", "--"]],
    ["npm", ["npm", "exec", "--no", "--"]],
    ["bun", ["npm", "exec", "--no", "--"]],
    ["pnpm", ["pnpm", "exec"]],
    ["yarn", ["yarn", "run"]],
  ] as const)(":node-local for manager %s", (manager, prefix) => {
    expect(nodeServiceLaunchers({ catalogOwned: false, manager })[":node-local"]).toEqual(prefix);
  });

  test.each([
    [true, undefined, [":node-install-run", ":node-local"]],
    [true, "pnpm", [":node-install-run", ":node-local"]],
    [true, "yarn", [":node-install-run", ":node-local"]],
    [true, "bun", [":node-local"]],
    [false, "pnpm", [":node-local"]],
  ] as const)("catalogOwned=%p manager=%p declares %p", (catalogOwned, manager, names) => {
    expect(Object.keys(nodeServiceLaunchers({ catalogOwned, manager })).sort()).toEqual([...names]);
  });
});

const STUB_MANAGER = `#!/bin/sh
if [ "$1" = install ]; then
  echo "installing with $(basename "$0")"
  sleep "\${STUB_INSTALL_SECONDS:-0}"
  echo "installed with $(basename "$0")"
  exit "\${STUB_INSTALL_STATUS:-0}"
fi
shift
script=$1
shift
[ "$1" = -- ] && shift
# Like the real managers: the script runs under sh -c, which forwards no signal.
exec sh -c 'sh "./$0.sh" "$@"' "$script" "$@"
`;

// A server that answers SIGTERM gracefully, and a script that ends on its own.
const START_SCRIPT = `sleep 1000 &
idle=$!
trap 'kill "$idle"; echo graceful; exit 0' TERM
echo "ready $*"
wait "$idle"
`;
const ONCE_SCRIPT = `echo "ran $*"
exit 3
`;

const runInstallRun = async (
  manager: "npm" | "pnpm" | "yarn",
  script: string,
  options: {
    readonly installStatus?: number;
    readonly installSeconds?: number;
    readonly stopWhen?: "installing" | "ready";
  } = {},
) => {
  const prefix = nodeServiceLaunchers({ catalogOwned: true, manager })[":node-install-run"];
  if (prefix === undefined) throw new Error(`${manager} declares no :node-install-run`);
  const root = await mkdtemp(join(tmpdir(), "lando-node-install-run-"));
  try {
    await Bun.write(join(root, manager), STUB_MANAGER);
    await chmod(join(root, manager), 0o700);
    await Bun.write(join(root, "start.sh"), START_SCRIPT);
    await Bun.write(join(root, "once.sh"), ONCE_SCRIPT);
    const child = Bun.spawn([...prefix, script, "--port", "8080"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        STUB_INSTALL_STATUS: String(options.installStatus ?? 0),
        STUB_INSTALL_SECONDS: String(options.installSeconds ?? 0),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    let stdout = "";
    let stopWhen = options.stopWhen;
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      if (stopWhen !== undefined && stdout.includes(stopWhen)) {
        child.kill("SIGTERM");
        stopWhen = undefined;
      }
    }
    return { exitCode: await child.exited, stdout };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// The prefix runs inside Linux images and relies on setsid and dash-like sh; macOS has neither.
describe.skipIf(process.platform !== "linux")(":node-install-run supervisor", () => {
  test.each(["npm", "pnpm", "yarn"] as const)(
    "%s: a stop reaches the server through the script shell and waits for its handler",
    async (manager) => {
      const result = await runInstallRun(manager, "start", { stopWhen: "ready" });
      expect(result.stdout).toContain(`installed with ${manager}`);
      expect(result.stdout).toContain("ready --port 8080");
      expect(result.stdout).toContain("graceful");
    },
  );

  test("a script that ends on its own keeps its exit status", async () => {
    const result = await runInstallRun("npm", "once");
    expect(result.stdout).toContain("ran --port 8080");
    expect(result.exitCode).toBe(3);
  });

  test("a stop during the install never starts the script", async () => {
    const result = await runInstallRun("npm", "start", { installSeconds: 1, stopWhen: "installing" });
    expect(result.exitCode).toBe(143);
    expect(result.stdout).not.toContain("ready");
  });

  test("a failed install never starts the script", async () => {
    const result = await runInstallRun("pnpm", "once", { installStatus: 7 });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).not.toContain("ran");
  });
});

describe("Node ServiceType resolution launchers", () => {
  test("catalog node with pnpm pin contributes both launchers", async () => {
    const resolution = await Effect.runPromise(
      nodeServiceType.resolve({
        name: "web",
        service: { type: "node" },
        appRoot: "/srv/apps/node-launchers",
        metadata,
        projectFiles: [
          present(".nvmrc", "26\n"),
          packageJson("package.json", { packageManager: "pnpm@9.15.0" }),
        ],
      }),
    );
    const launchers = decodeLaunchers(resolution.launchers);
    expect(launchers[":node-local"]).toEqual(["pnpm", "exec"]);
    expect(launchers[":node-install-run"]?.[0]).toBe("sh");
    expect(launchers[":node-install-run"]?.[2]).toContain("pnpm install");
  });

  test("catalog node with yarn pin uses yarn run / yarn install-run", async () => {
    const resolution = await Effect.runPromise(
      nodeLtsServiceType.resolve({
        name: "web",
        service: { type: "node:lts" },
        appRoot: "/srv/apps/node-launchers",
        metadata,
        projectFiles: [packageJson("package.json", { packageManager: "yarn@1.22.22" })],
      }),
    );
    const launchers = decodeLaunchers(resolution.launchers);
    expect(launchers[":node-local"]).toEqual(["yarn", "run"]);
    expect(launchers[":node-install-run"]?.[2]).toContain("yarn install");
  });

  test("catalog node with bun pin keeps only :node-local npm-exec fallback", async () => {
    const resolution = await Effect.runPromise(
      nodeServiceType.resolve({
        name: "web",
        service: { type: "node" },
        appRoot: "/srv/apps/node-launchers",
        metadata,
        projectFiles: [
          present(".nvmrc", "26\n"),
          packageJson("package.json", { packageManager: "bun@1.2.0" }),
        ],
      }),
    );
    const launchers = decodeLaunchers(resolution.launchers);
    expect(Object.keys(launchers)).toEqual([":node-local"]);
    expect(launchers[":node-local"]).toEqual(["npm", "exec", "--no", "--"]);
  });

  test("BYO (no project files) keeps only :node-local", async () => {
    const resolution = await Effect.runPromise(
      nodeLtsServiceType.resolve({
        name: "web",
        service: { type: "node:lts", image: "node:22-alpine" },
        appRoot: "/srv/apps/node-launchers",
        metadata,
      }),
    );
    const launchers = decodeLaunchers(resolution.launchers);
    expect(Object.keys(launchers)).toEqual([":node-local"]);
    expect(launchers[":node-local"]).toEqual(["npm", "exec", "--no", "--"]);
  });

  test("catalog node with no packageManager declaration uses npm install-run forms", async () => {
    const resolution = await Effect.runPromise(
      nodeLtsServiceType.resolve({
        name: "web",
        service: { type: "node:lts" },
        appRoot: "/srv/apps/node-launchers",
        metadata,
        projectFiles: [packageJson("package.json", { name: "app" })],
      }),
    );
    const launchers = decodeLaunchers(resolution.launchers);
    expect(launchers[":node-local"]).toEqual(["npm", "exec", "--no", "--"]);
    expect(launchers[":node-install-run"]?.[2]).toContain("npm install --no-audit --no-fund");
    expect(launchers[":node-install-run"]?.[2]).toContain('setsid npm run "$script" -- "$@"');
  });
});
