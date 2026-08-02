import type { Effect } from "effect";

import type { CertificateAuthorityShape } from "@lando/sdk/services";

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

export interface TraefikProxyDependencies {
  readonly certificateAuthority: CertificateAuthorityShape;
  readonly fileSystem: ProxyFileSystem;
  readonly paths: ProxyPaths;
  readonly globalApp: ProxyGlobalApp;
}
