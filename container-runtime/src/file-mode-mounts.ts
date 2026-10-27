import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { ServiceStartError } from "@lando/sdk/errors";
import type { AppPlan, BindMountPlan, ServicePlan } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { ContainerPlanError } from "./container-plan-error.ts";
import type { ProviderErrorContext } from "./engine-api.ts";

type FileIdentity = { readonly source: string; readonly digest: string };

// Prepared mounts are transient create inputs, never persisted in an applied plan.
const preparedIdentities = new WeakMap<BindMountPlan, FileIdentity>();

export const preparedBindSource = (mount: BindMountPlan): string => {
  if (mount.fileMode !== undefined && !preparedIdentities.has(mount)) {
    throw new ContainerPlanError("File-mode binds require provider preparation before rendering.", {
      source: mount.source,
      target: mount.target,
    });
  }
  return mount.source;
};

export const fileModeMountIdentity = (mount: BindMountPlan): FileIdentity | undefined => {
  if (mount.fileMode === undefined) return undefined;
  const prepared = preparedIdentities.get(mount);
  if (prepared !== undefined) return prepared;
  try {
    return { source: mount.source, digest: sha256Hex(readFileSync(mount.source)) };
  } catch (cause) {
    throw new ContainerPlanError("Cannot read file-mode bind source.", {
      source: mount.source,
      target: mount.target,
      cause,
    });
  }
};

/** Publish new content-addressed files, never mutate a file a container might bind. */
export const prepareFileModeMounts = Effect.fn("RuntimeProvider.prepareFileModeMounts")(function* (
  plan: AppPlan,
  ctx: ProviderErrorContext,
  userDataRoot?: string,
) {
  if (
    !Object.values(plan.services).some((service) =>
      service.mounts.some((mount) => mount.type === "bind" && mount.fileMode !== undefined),
    )
  )
    return plan;
  const paths = yield* Effect.serviceOption(PathsService);
  const root =
    userDataRoot ?? (Option.isSome(paths) ? paths.value.roots.userDataRoot : ctx.env.LANDO_USER_DATA_ROOT);
  const services: Record<string, ServicePlan> = {};
  for (const [name, service] of Object.entries(plan.services)) {
    const mounts = [];
    for (const mount of service.mounts) {
      if (mount.type !== "bind" || mount.fileMode === undefined) {
        mounts.push(mount);
        continue;
      }
      const mode = mount.fileMode;
      const prepared = yield* Effect.tryPromise({
        try: async () => {
          if (root === undefined)
            throw new ContainerPlanError("File-mode binds require PathsService or a Lando user-data root.");
          const contents = await Bun.file(mount.source).bytes();
          const digest = sha256Hex(contents);
          const directory = join(root, "file-mode-mounts");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await chmod(directory, 0o700);
          const key = `${digest}-${mode.toString(8)}`;
          const published = join(directory, key);
          const source = join(published, key);
          if (!(await Bun.file(source).exists())) {
            const staging = join(directory, `.${key}.${crypto.randomUUID()}`);
            await mkdir(staging, { mode: 0o700 });
            try {
              const temporary = join(staging, key);
              await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
              await chmod(temporary, mode);
              try {
                await rename(staging, published);
              } catch (cause) {
                if (
                  !(
                    cause instanceof Error &&
                    "code" in cause &&
                    (cause.code === "EEXIST" || cause.code === "ENOTEMPTY")
                  )
                )
                  throw cause;
              }
            } finally {
              await rm(staging, { recursive: true, force: true });
            }
          }
          const realized = { ...mount, source };
          preparedIdentities.set(realized, { source: mount.source, digest });
          return realized;
        },
        catch: (cause) =>
          new ServiceStartError({
            providerId: ctx.providerId,
            operation: "bringUp.mounts",
            service: service.name,
            message: `Cannot prepare file-mode bind for service ${service.name}, target ${mount.target}, source ${mount.source}.`,
            details: { service: service.name, target: mount.target, source: mount.source },
            remediation:
              "Ensure the source is a readable file and the Lando user-data directory is writable, then retry.",
            cause,
          }),
      });
      mounts.push(prepared);
    }
    services[name] = { ...service, mounts };
  }
  return { ...plan, services };
});
