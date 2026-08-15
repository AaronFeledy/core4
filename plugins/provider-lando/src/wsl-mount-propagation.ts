import { Effect } from "effect";

import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";

export type RootMountPropagation = "shared" | "private" | "unknown";

export interface WslMountPropagationReaders {
  readonly readMountinfo: () => Promise<string | undefined>;
}

const readMountinfo = async (): Promise<string | undefined> => {
  try {
    return await Bun.file("/proc/self/mountinfo").text();
  } catch {
    return undefined;
  }
};

const systemReaders: WslMountPropagationReaders = {
  readMountinfo,
};

const optionalRead = (read: () => Promise<string | undefined>): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({ try: read, catch: () => undefined }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

export const parseRootMountPropagation = (mountinfo: string): RootMountPropagation => {
  for (const line of mountinfo.split(/\r?\n/u)) {
    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex < 0) continue;

    const mountFields = line.slice(0, separatorIndex).trim().split(/\s+/u);
    if (mountFields[4] !== "/") continue;

    const filesystemFields = line
      .slice(separatorIndex + 3)
      .trim()
      .split(/\s+/u);
    const mountId = mountFields[0];
    const parentId = mountFields[1];
    const device = mountFields[2];
    const root = mountFields[3];
    const mountOptions = mountFields[5];
    const filesystemType = filesystemFields[0];
    const mountSource = filesystemFields[1];
    const superOptions = filesystemFields[2];
    const isWellFormed =
      mountFields.length >= 6 &&
      filesystemFields.length >= 3 &&
      mountId !== undefined &&
      /^\d+$/u.test(mountId) &&
      parentId !== undefined &&
      /^\d+$/u.test(parentId) &&
      device !== undefined &&
      /^\d+:\d+$/u.test(device) &&
      root !== undefined &&
      root.startsWith("/") &&
      mountOptions !== undefined &&
      mountOptions.length > 0 &&
      filesystemType !== undefined &&
      filesystemType.length > 0 &&
      mountSource !== undefined &&
      mountSource.length > 0 &&
      superOptions !== undefined &&
      superOptions.length > 0;
    if (!isWellFormed) return "unknown";

    return mountFields.slice(6).some((field) => /^shared:\d+$/u.test(field)) ? "shared" : "private";
  }

  return "unknown";
};

export const makeWslMountPropagationCheck = (
  readers: WslMountPropagationReaders = systemReaders,
): PluginDoctorCheckContribution => ({
  id: "wsl-root-mount-propagation",
  run: (input) =>
    Effect.gen(function* () {
      if (input.platform !== "wsl") return [];

      const mountinfo = yield* optionalRead(readers.readMountinfo);
      if (mountinfo === undefined || parseRootMountPropagation(mountinfo) !== "private") return [];

      const report = {
        name: "wsl-root-mount-propagation",
        status: "warn",
        severity: "warn",
        runtimeStatus: "root mount propagation is private",
        context: {
          platform: "wsl",
          rootMountPropagation: "private",
        },
        solutions: [
          {
            kind: "manual",
            description: "Make the root mount recursively shared for the current WSL session.",
            command: "sudo mount --make-rshared /",
          },
          {
            kind: "manual",
            description:
              'Persist the setting in /etc/wsl.conf with a [boot] command such as command="mount --make-rshared /", then restart WSL.',
          },
        ],
      } satisfies PluginDoctorReport;

      return [report];
    }),
});
