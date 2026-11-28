import type { AppPlan, ServiceDataVersion, ServiceDataVersionFinding, ServicePlan } from "@lando/sdk/schema";
import type { LogChunk } from "@lando/sdk/services";

// A server can log dozens of shutdown steps after its refusal. The displayed tail stays capped.
export const startupFailureLogLookback = (contract: ServiceDataVersion | undefined): number =>
  contract === undefined ? 50 : 200;

/** `since` is provider-enforced; discard any timestamped older chunks even if the provider rounded it. */
export const startupFailureLogLines = (chunks: readonly LogChunk[], startedAt: number, lookback: number) =>
  chunks
    .filter(({ timestamp }) => timestamp === undefined || timestamp.getTime() >= startedAt)
    .flatMap(({ line }) => line.split("\n"))
    .slice(-lookback);

export const startupLogsCommand = (plan: AppPlan, service: string): string =>
  plan.extensions["@lando/core/scratch"] !== undefined
    ? `lando scratch logs ${plan.id}`
    : plan.id === "global"
      ? `lando global:logs -s ${service}`
      : `lando logs -s ${service}`;

export const dataVersionRemediation = (
  plan: AppPlan,
  service: ServicePlan,
  diagnostic: { readonly finding: ServiceDataVersionFinding; readonly hint?: string },
): string => {
  const { finding, hint } = diagnostic;
  const label = service.dataVersion?.label ?? "database";
  const current =
    finding.dataVersion === undefined ? `the previous ${label} version` : `${label} ${finding.dataVersion}`;
  const family = service.serviceTypeId?.split(":")[0] ?? service.type;
  const catalogPin =
    finding.dataVersion !== undefined && (family === "mariadb" || family === "mysql" || family === "postgres")
      ? `set \`services.${service.name}.type\` back to \`${family}:${finding.dataVersion}\` if it is a catalog version, or `
      : "";
  const restore = `${catalogPin}restore the previous compatible \`image:\` under \`services.${service.name}\` with an unversioned type.`;
  const extra = hint === undefined ? "" : ` ${hint}`;
  if (plan.extensions["@lando/core/scratch"] !== undefined)
    return `Use ${current} in the scratch source configuration before creating another scratch.${extra}`;
  if (plan.id === "global")
    return `To keep using this data, ${restore} Run \`lando global:start\` only with a compatible image. To move data to another version, prefer a pre-upgrade export and verify it can be imported before replacing volumes. Importing across versions is not guaranteed. \`lando global:destroy --volumes\` deletes all global service data, not just this database.${extra}`;
  if (hint !== undefined) return `To keep using this data, ${restore}${extra}`;
  const commands = `If you need a new export, restore the compatible configuration, start the server if needed, and run \`lando db:export dump.sql.gz --service ${service.name}\`. Importing across versions is not guaranteed. Verify the dump and back up the other services: \`lando destroy -y --volumes\` deletes every service's data in the app. After destroying, select the desired version, run \`lando start\`, and import with \`lando db:import dump.sql.gz --service ${service.name} --yes\`.`;
  return finding.direction === "downgrade"
    ? `To keep using this data, ${restore} To move to the older version, prefer an export taken before the upgrade. ${commands}`
    : `To keep using this data, ${restore} The selected server cannot open these files in place. ${commands}`;
};
