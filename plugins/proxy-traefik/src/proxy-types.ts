import type { Context, Effect } from "effect";

import type {
  CertificateAuthorityShape,
  EventService,
  InteractionService,
  PrivilegeService,
  ProcessRunner,
} from "@lando/sdk/services";

import type { AcquisitionFingerprint, BindOutcome, ForwardOutcome, SchemeProbe } from "./port-acquisition.ts";
import type { SocketProxyServiceType } from "./socket-proxy-units.ts";

export interface ProxyFileSystem {
  readonly mkdir: (path: string) => Effect.Effect<void, unknown>;
  readonly exists: (path: string) => Effect.Effect<boolean, unknown>;
  readonly readDir: (path: string) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly readText: (path: string) => Effect.Effect<string, unknown>;
  readonly writeAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, unknown>;
  readonly writeSecretAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, unknown>;
  readonly remove: (path: string) => Effect.Effect<void, unknown>;
}

export interface ProxyPaths {
  readonly platform: "darwin" | "linux" | "win32" | "wsl";
  readonly globalAppRoot: string;
}

export interface ProxyGlobalApp {
  readonly ensureRunning: (services: ReadonlyArray<string>) => Effect.Effect<
    ReadonlyArray<{
      readonly name: string;
      readonly state: string;
      readonly endpoints: ReadonlyArray<string>;
    }>,
    unknown
  >;
}

export interface SocketProxyDependencies {
  readonly user: string;
  readonly hasHostSystemd: () => boolean;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly readText: (path: string) => Effect.Effect<string, unknown>;
  readonly processRunner: Context.Tag.Service<typeof ProcessRunner>;
  readonly privilege: Context.Tag.Service<typeof PrivilegeService>;
  readonly interaction?: Pick<Context.Tag.Service<typeof InteractionService>, "confirm" | "isInteractive">;
  readonly autoApprove?: boolean;
  readonly serviceType?: SocketProxyServiceType;
  readonly probeForward?: (host: string, port: number) => Effect.Effect<ForwardOutcome>;
  readonly classifyOverride?: {
    readonly http: SchemeProbe;
    readonly https: SchemeProbe;
    readonly httpBinds?: Readonly<Record<number, BindOutcome>>;
    readonly httpsBinds?: Readonly<Record<number, BindOutcome>>;
  };
}

export interface TraefikRouterPin {
  readonly httpPort?: number;
  readonly httpsPort?: number;
}

export interface TraefikRouterLists {
  readonly httpPort?: number;
  readonly httpsPort?: number;
  readonly httpFallbacks?: readonly number[];
  readonly httpsFallbacks?: readonly number[];
  readonly bindAddress?: string;
}

export interface TraefikProxyDependencies {
  readonly certificateAuthority: CertificateAuthorityShape;
  readonly fileSystem: ProxyFileSystem;
  readonly paths: ProxyPaths;
  readonly globalApp: ProxyGlobalApp;
  readonly socketProxy?: SocketProxyDependencies;
  readonly fingerprint?: AcquisitionFingerprint;
  readonly router?: TraefikRouterLists;
  readonly routerPin?: TraefikRouterPin;
  readonly probeBind?: (host: string, port: number) => Effect.Effect<BindOutcome>;
  readonly events?: Context.Tag.Service<typeof EventService>;
}
