import type { InfoAppResult, InfoAppService } from "@lando/sdk/app";
import { AbsolutePath, PortablePath, type ServiceInfoMount } from "@lando/sdk/schema";

import { stripAnsi } from "@lando/renderer/console-layout";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { connections } from "./connection-fixtures";

/** Synthetic `ServiceInfo` builders for storage-presentation tests; every value is fake. */

export const service = (
  name: string,
  mounts: ReadonlyArray<ServiceInfoMount> | undefined,
  extra: Partial<InfoAppService> = {},
): InfoAppService => ({
  app: "demo-app",
  service: name,
  api: 4,
  type: "compose",
  provider: "lando",
  primary: false,
  status: "running",
  connections: connections([`http://localhost:${7700 + name.length}`]),
  ...(mounts === undefined ? {} : { mounts }),
  ...extra,
});

/** A mount the resolved plan declares; `observation` defaults to the confirmed case. */
export const planned = (
  mount: Omit<ServiceInfoMount, "origin" | "observation"> & {
    readonly observation?: ServiceInfoMount["observation"];
  },
): ServiceInfoMount => ({ ...mount, origin: "planned", observation: mount.observation ?? "present" });

export const runtimeVolume = (target: string, source: string): ServiceInfoMount => ({
  type: "volume",
  target,
  source,
  origin: "runtime",
  observation: "present",
  lifetime: "unknown",
});

export const appMount: NonNullable<InfoAppService["appMount"]> = {
  source: AbsolutePath.make("/home/user/projects/demo-app"),
  target: PortablePath.make("/app"),
  readOnly: false,
  includes: [],
  excludes: ["node_modules"],
  realization: "passthrough",
};

export const HEX_VOLUME = "3f9c".repeat(16);

export const result = (...services: ReadonlyArray<InfoAppService>): InfoAppResult => ({
  app: "demo-app",
  services,
});

export const decorated = (columns: number): RenderContext => ({
  mode: "lando",
  format: "text",
  columns,
  isTTY: true,
});

/** Rendered lines carrying the summary's hanging remediation arrow. */
export const remedyLines = (text: string): ReadonlyArray<string> =>
  stripAnsi(text)
    .split("\n")
    .filter((line) => line.includes("↳"));
