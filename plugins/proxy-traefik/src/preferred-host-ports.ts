import { readFile } from "node:fs/promises";
import { Socket } from "node:net";

import { makeLandoPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";
import { Effect } from "effect";

import { commLooksLikeRootlessport } from "./leftover-proxy-ports-linux.ts";
import { DESIRED_HTTPS_PORT, DESIRED_HTTP_PORT } from "./port-acquisition.ts";
import {
  type OccupancyHolderIdentity,
  type OccupancyHolderInput,
  classifyOccupancyHolder,
  solutionsForOccupancyHolder,
} from "./preferred-host-ports-holders.ts";
import { identifyAnyPortHolder } from "./preferred-host-ports-linux.ts";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";

export interface PreferredHostPortSnapshot {
  readonly port: number;
  readonly listening: boolean;
  readonly comm?: string;
  readonly pid?: number;
  readonly cmdline?: string;
  readonly kind?: "leftover-rootlessport";
}

export interface PreferredHostPortReaders {
  readonly readPort: (port: number, platform: HostPlatform) => Promise<PreferredHostPortSnapshot>;
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const TCP_PROBE_MS = 200;
const PREFERRED_PORTS = [DESIRED_HTTP_PORT, DESIRED_HTTPS_PORT] as const;

type TcpProbe = "refused" | "listening";

type AcquisitionClaim = {
  readonly mode?: string;
  readonly httpPort?: number;
  readonly httpsPort?: number;
};

const idleSnapshot = (port: number): PreferredHostPortSnapshot => ({
  port,
  listening: false,
});

const probeTcp = (port: number): Promise<TcpProbe> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const finish = (result: TcpProbe) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TCP_PROBE_MS);
    socket.once("connect", () => finish("listening"));
    socket.once("timeout", () => finish("listening"));
    socket.once("error", (error: Error) => {
      const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
      finish(code === "ECONNREFUSED" ? "refused" : "listening");
    });
    socket.connect(port, LOOPBACK_HOST);
  });

const readPort = async (port: number, platform: HostPlatform): Promise<PreferredHostPortSnapshot> => {
  const tcp = await probeTcp(port);
  if (tcp === "refused") return idleSnapshot(port);
  if (platform !== "linux" && platform !== "wsl") return { port, listening: true };

  const holder = await identifyAnyPortHolder(port);
  if (holder === undefined) return { port, listening: true };

  const leftover = commLooksLikeRootlessport(holder.comm);
  return {
    port,
    listening: true,
    comm: holder.comm,
    pid: holder.pid,
    ...(holder.cmdline === undefined ? {} : { cmdline: holder.cmdline }),
    ...(leftover ? { kind: "leftover-rootlessport" as const } : {}),
  };
};

const systemReaders: PreferredHostPortReaders = { readPort };

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const claimFromUnknown = (value: unknown): AcquisitionClaim | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const mode = "mode" in value && typeof value.mode === "string" ? value.mode : undefined;
  const httpPort = "httpPort" in value ? optionalNumber(value.httpPort) : undefined;
  const httpsPort = "httpsPort" in value ? optionalNumber(value.httpsPort) : undefined;
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(httpPort === undefined ? {} : { httpPort }),
    ...(httpsPort === undefined ? {} : { httpsPort }),
  };
};

const resolveClaim = (input: {
  readonly userDataRoot: string | undefined;
  readonly platform: HostPlatform;
}): Effect.Effect<AcquisitionClaim | undefined> => {
  if (input.userDataRoot === undefined) return Effect.succeed(undefined);
  const resolved = makeLandoPaths({ userDataRoot: input.userDataRoot, platform: input.platform });
  const paths: ProxyPaths = { platform: resolved.platform, globalAppRoot: resolved.globalAppRoot };
  return Effect.tryPromise(() => readFile(acquisitionStateFile(paths), "utf8")).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => claimFromUnknown(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
};

const claimsPort = (claim: AcquisitionClaim | undefined, port: number): boolean =>
  claim !== undefined &&
  (claim.mode === "socket-helper" || claim.httpPort === port || claim.httpsPort === port);

const isLeftoverRootlessport = (snapshot: PreferredHostPortSnapshot): boolean =>
  snapshot.kind === "leftover-rootlessport" ||
  (snapshot.comm !== undefined && commLooksLikeRootlessport(snapshot.comm));

const holderInputOf = (snapshot: PreferredHostPortSnapshot): OccupancyHolderInput => ({
  ...(snapshot.comm === undefined ? {} : { comm: snapshot.comm }),
  ...(snapshot.cmdline === undefined ? {} : { cmdline: snapshot.cmdline }),
});

const identityOf = (snapshot: PreferredHostPortSnapshot): OccupancyHolderIdentity => ({
  ...(snapshot.comm === undefined ? {} : { comm: snapshot.comm }),
  ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
});

const occupancyContext = (
  occupied: ReadonlyArray<PreferredHostPortSnapshot>,
  holder: string,
  identity: OccupancyHolderIdentity,
): Record<string, string> => ({
  host: LOOPBACK_HOST,
  ports: occupied.map((item) => String(item.port)).join(","),
  holder,
  ...(identity.comm === undefined ? {} : { comm: identity.comm }),
  ...(identity.pid === undefined ? {} : { pid: String(identity.pid) }),
});

export const makePreferredHostPortsCheck = (
  readers: PreferredHostPortReaders = systemReaders,
): PluginDoctorCheckContribution => ({
  id: "preferred-host-ports",
  run: (input) =>
    Effect.gen(function* () {
      const claim = yield* resolveClaim(input);
      const snapshots = yield* Effect.forEach(
        PREFERRED_PORTS,
        (port) =>
          Effect.promise(() => readers.readPort(port, input.platform).catch(() => idleSnapshot(port))),
        { concurrency: "unbounded" },
      );

      const occupied = snapshots.filter(
        (item) => item.listening && !claimsPort(claim, item.port) && !isLeftoverRootlessport(item),
      );
      const classified = occupied.find((item) => item.port === DESIRED_HTTP_PORT) ?? occupied[0];
      if (classified === undefined) return [];

      const kind = classifyOccupancyHolder(holderInputOf(classified));
      const identity = identityOf(classified);
      const report = {
        name: "preferred-host-ports",
        status: "warn",
        severity: "warn",
        runtimeStatus: "preferred-port-occupied",
        runtime: { running: false },
        context: occupancyContext(occupied, kind, identity),
        solutions: [...solutionsForOccupancyHolder(kind, identity)],
      } satisfies PluginDoctorReport;

      return [report];
    }),
});

export const preferredHostPortsCheck = makePreferredHostPortsCheck();
