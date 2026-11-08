import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { Effect } from "effect";

import type { HostMaintenanceContribution, HostUninstallInput } from "@lando/sdk/plugins";
import type { HostUninstallStep } from "@lando/sdk/schema";

import {
  SOCKET_PROXY_EXIT_NEEDS_FLOCK,
  SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS,
  SOCKET_PROXY_POLKIT_PATH,
  SOCKET_PROXY_UNIT_PATHS,
  classifySocketProxyArtifacts,
  foreignSocketProxyNotice,
  socketProxyContentDigest,
  socketProxyOwnerRoot,
} from "./socket-proxy-helper.ts";
import type { SocketProxyPriorDigests } from "./socket-proxy-script.ts";
import { buildUninstallScript } from "./socket-proxy-units.ts";

export const makeSocketProxyHostMaintainer = (
  deps: {
    readonly unitPaths?: ReadonlyArray<string>;
    readonly polkitPath?: string;
    readonly exists?: (path: string) => boolean;
    readonly readText?: (path: string) => string;
    readonly realpath?: (path: string) => string;
  } = {},
) => {
  const unitPaths = deps.unitPaths ?? SOCKET_PROXY_UNIT_PATHS;
  const polkitPath = deps.polkitPath ?? SOCKET_PROXY_POLKIT_PATH;
  const paths = [...unitPaths, polkitPath];
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const inspect = (userDataRoot: string) => {
    let root: string;
    try {
      root = (deps.realpath ?? realpathSync)(userDataRoot);
    } catch {
      root = resolve(userDataRoot);
    }
    const digests: Record<string, string | null> = {};
    const contents = paths.map((path) => {
      if (!exists(path)) {
        digests[path] = null;
        return null;
      }
      try {
        const text = readText(path);
        digests[path] = socketProxyContentDigest(text);
        return text;
      } catch {
        digests[path] = "unknown";
        return undefined;
      }
    });
    const units = contents.slice(0, unitPaths.length);
    const polkit = contents[unitPaths.length];
    const classified =
      polkit === undefined && units.some((text) => typeof text === "string") ? units : contents;
    const owners = classified.flatMap((text) => {
      if (typeof text !== "string") return [];
      const owner = socketProxyOwnerRoot(text);
      return owner === undefined || !exists(owner) ? [] : [owner];
    });
    return {
      root,
      digests: digests satisfies SocketProxyPriorDigests,
      ownership: classifySocketProxyArtifacts(classified, root, owners),
    };
  };
  const plan = Effect.fn("SocketProxyHostMaintainer.plan")(function* (input: HostUninstallInput) {
    if (input.platform !== "linux" && input.platform !== "wsl") return [];
    const { ownership } = yield* Effect.sync(() => inspect(input.userDataRoot));
    let status: HostUninstallStep["status"];
    let detail: string;
    switch (ownership.kind) {
      case "owned":
        status = "owned";
        detail = "Stop owned proxy sockets and remove their systemd units and polkit rule.";
        break;
      case "absent":
        status = "skipped";
        detail = "No socket proxy helper artifacts are present.";
        break;
      case "unmarked":
        status = "user-owned";
        detail = foreignSocketProxyNotice(ownership, "commands");
        break;
      case "foreign":
        status = ownership.reason === "other-root" ? "user-owned" : "manual";
        detail = foreignSocketProxyNotice(ownership, "commands");
        break;
    }
    return [
      {
        id: "socket-proxy-helper",
        label: "socket proxy helper",
        target: paths.join(", "),
        destructive: true,
        status,
        detail,
        preserveOnKeepData: true,
      },
    ];
  });
  const execute: NonNullable<HostMaintenanceContribution["uninstall"]>["execute"] = Effect.fn(
    "SocketProxyHostMaintainer.execute",
  )(function* (input) {
    if (input.platform !== "linux" && input.platform !== "wsl") return { outcome: "skipped" };
    const snapshot = yield* Effect.sync(() => inspect(input.userDataRoot));
    if (snapshot.ownership.kind === "absent") return { outcome: "skipped" };
    if (snapshot.ownership.kind !== "owned") {
      return { outcome: "manual", detail: foreignSocketProxyNotice(snapshot.ownership, "commands") };
    }
    if (input.elevate === undefined) {
      return {
        outcome: "manual",
        detail: `Privileged removal is required.\n${SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS}`,
      };
    }
    const result = yield* input.elevate([
      "/bin/sh",
      "-c",
      buildUninstallScript({
        unitPaths,
        polkitPath,
        canonicalUserDataRoot: snapshot.root,
        priorDigests: snapshot.digests,
      }),
    ]);
    if (result.exitCode === 0) return { outcome: "completed" };
    if (result.exitCode === SOCKET_PROXY_EXIT_NEEDS_FLOCK) {
      return {
        outcome: "manual",
        detail: "Install flock (util-linux), then rerun lando uninstall. No helper artifacts were changed.",
      };
    }
    return {
      outcome: "failed",
      error: result.stderr || `socket proxy helper uninstall exited ${result.exitCode}`,
    };
  });
  return { id: "socket-proxy-helper", uninstall: { plan, execute } } satisfies HostMaintenanceContribution;
};
