import { readFile, realpath, stat } from "node:fs/promises";

import { globalAppRootPath } from "@lando/paths";
import { isErrnoCode } from "@lando/sdk/errors";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect, Schema } from "effect";

import { AcquisitionState } from "./port-acquisition-state.ts";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";
import {
  SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS,
  SOCKET_PROXY_UNIT_PATHS,
  type SocketProxyArtifactClassification,
  foreignSocketProxyNotice,
} from "./socket-proxy-helper.ts";
import { classifySocketProxy } from "./socket-proxy-install.ts";
import type { HostPathAccess } from "./socket-proxy-ownership.ts";

const SOCKET_UNITS = ["lando-proxy-http.socket", "lando-proxy-https.socket"] as const;

const hostExists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise({ try: () => stat(path), catch: (error) => error }).pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(!isErrnoCode(error, "ENOENT") && !isErrnoCode(error, "ENOTDIR"))),
  );

const hostReadText = (path: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise({ try: () => Bun.file(path).text(), catch: (error) => error });

const makeAccess = (userDataRoot: string): HostPathAccess => ({
  userDataRoot,
  exists: hostExists,
  readText: hostReadText,
  realpath: (path) => Effect.tryPromise({ try: () => realpath(path), catch: (error) => error }),
});

const readAcquisition = (input: {
  readonly userDataRoot: string | undefined;
  readonly platform: "linux" | "wsl" | "darwin" | "win32";
}): Effect.Effect<AcquisitionState | undefined> => {
  if (input.userDataRoot === undefined) return Effect.succeed(undefined);
  const paths: ProxyPaths = {
    platform: input.platform,
    globalAppRoot: globalAppRootPath(input.userDataRoot, input.platform),
  };
  return Effect.tryPromise(async () =>
    Schema.decodeUnknownSync(AcquisitionState)(
      JSON.parse(await readFile(acquisitionStateFile(paths), "utf8")),
    ),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)));
};

const socketsActive = Effect.fnUntraced(function* () {
  const results = yield* Effect.forEach(SOCKET_UNITS, (unit) =>
    Effect.tryPromise(async () => {
      const child = Bun.spawnSync(["systemctl", "is-active", unit], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return child.exitCode === 0 && child.stdout.toString().trim() === "active";
    }).pipe(Effect.catch(() => Effect.succeed(false))),
  );
  return results.every(Boolean);
});

export const doctorReportsForHelper = (input: {
  readonly ownership: SocketProxyArtifactClassification;
  readonly installed: boolean;
  readonly socketsActive: boolean;
  readonly acquisitionMode?: string;
}): ReadonlyArray<PluginDoctorReport> => {
  const { ownership } = input;
  if (ownership.kind === "absent" || ownership.kind === "unmarked") return [];
  if (ownership.kind === "owned") {
    if (input.installed && input.socketsActive) {
      return [
        {
          name: "socket-proxy-helper",
          status: "pass",
          severity: "info",
          runtimeStatus: "owned and active",
          context: { ownership: "owned" },
          solutions: [],
        },
      ];
    }
    // Warn owned+inactive only when this root's acquisition claims socket-helper mode.
    if (input.acquisitionMode !== "socket-helper") {
      return [];
    }
    return [
      {
        name: "socket-proxy-helper",
        status: "warn",
        severity: "warn",
        runtimeStatus: "owned helper is inactive",
        context: { ownership: "owned", acquisition: "socket-helper" },
        solutions: [
          {
            kind: "manual",
            description: "Run `lando setup` to start this install's socket proxy.",
            command: "lando setup",
          },
        ],
      },
    ];
  }
  if (ownership.reason === "other-root") {
    return [
      {
        name: "socket-proxy-helper",
        status: "pass",
        severity: "info",
        runtimeStatus: "served by another Lando install",
        context: {
          ownership: "other-root",
          ...(ownership.ownerRoot === undefined ? {} : { ownerRoot: ownership.ownerRoot }),
        },
        solutions: [],
      },
    ];
  }
  if (ownership.reason === "missing-root" || ownership.reason === "unattributed") {
    return [
      {
        name: "socket-proxy-helper",
        status: "warn",
        severity: "warn",
        runtimeStatus: foreignSocketProxyNotice(ownership, "brief"),
        context: {
          ownership: ownership.reason,
          ...(ownership.ownerRoot === undefined ? {} : { ownerRoot: ownership.ownerRoot }),
        },
        solutions: [
          {
            kind: "manual",
            description:
              ownership.reason === "unattributed"
                ? "Run `lando setup` in a terminal and confirm the takeover (older-build helpers are never replaced without confirmation)."
                : "Run `lando setup` to take over the socket proxy for this install.",
            command: "lando setup",
          },
          {
            kind: "manual",
            description: "Or remove the socket proxy yourself, then run `lando setup`.",
            command: SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS.split("\n")[0] ?? "sudo systemctl daemon-reload",
          },
        ],
      },
    ];
  }
  return [
    {
      name: "socket-proxy-helper",
      status: "warn",
      severity: "warn",
      runtimeStatus: "helper artifacts need manual review",
      context: { ownership: "mixed" },
      solutions: [
        {
          kind: "manual",
          description:
            "Check the socket proxy units and polkit rule; remove them yourself if no Lando install uses them.",
          command: SOCKET_PROXY_MANUAL_REMOVAL_COMMANDS.split("\n")[0] ?? "sudo systemctl daemon-reload",
        },
      ],
    },
  ];
};

export const socketProxyHelperDoctorCheck: PluginDoctorCheckContribution = {
  id: "socket-proxy-helper",
  run: (input) =>
    Effect.gen(function* () {
      if (input.platform !== "linux" && input.platform !== "wsl") return [];
      if (input.userDataRoot === undefined) return [];
      const access = makeAccess(input.userDataRoot);
      // Single ownership inspection; do not re-classify via isSocketProxyInstalled.
      const ownership = yield* classifySocketProxy(access);
      if (ownership.kind === "absent" || ownership.kind === "unmarked") return [];
      let installed = false;
      if (ownership.kind === "owned") {
        installed = true;
        for (const path of SOCKET_PROXY_UNIT_PATHS) {
          if (!(yield* access.exists(path))) {
            installed = false;
            break;
          }
        }
      }
      // Doctor must observe socket activity without starting the helper.
      const active = installed ? yield* socketsActive() : false;
      const needsClaim = ownership.kind === "owned" && installed && !active;
      const claim = needsClaim
        ? yield* readAcquisition({
            userDataRoot: input.userDataRoot,
            platform: input.platform,
          })
        : undefined;
      return [
        ...doctorReportsForHelper({
          ownership,
          installed,
          socketsActive: active,
          ...(claim?.mode === undefined ? {} : { acquisitionMode: claim.mode }),
        }),
      ];
    }).pipe(Effect.catch(() => Effect.succeed([]))),
};
