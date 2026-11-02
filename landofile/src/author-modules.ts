/**
 * One Lando runtime owns author-code peers for the life of the process.
 * Registered specifiers win over file-local copies, including plugin peers.
 * Capture the complete host table before registration; concurrent first loads
 * share one promise and no caller clears the process-wide Bun plugin registry.
 */
let registration: Promise<void> | undefined;

export const ensureHostModules = (): Promise<void> => {
  registration ??= import("./host-module-table.ts").then(({ hostModules }) => {
    Bun.plugin({
      name: "lando-host-modules",
      target: "bun",
      setup(build) {
        for (const [id, namespace] of Object.entries(hostModules)) {
          build.module(id, () => ({ loader: "object", exports: { ...namespace } }));
        }
      },
    });
  });
  return registration;
};

export const importAuthorModule = async (specifier: string): Promise<unknown> => {
  await ensureHostModules();
  return import(specifier);
};

export const missingPackageRemediation = (message: string): string | undefined => {
  const packageName = /Cannot find package '([^']+)'/.exec(message)?.[1];
  return packageName === undefined
    ? undefined
    : `Cannot resolve '${packageName}': Lando supplies @lando/sdk and effect; other packages must be installed in a node_modules directory above the author file.`;
};
