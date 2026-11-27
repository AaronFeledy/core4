import type { AppPlan, ServiceDataVersion, ServiceDataVersionFinding, ServicePlan } from "@lando/sdk/schema";

// A server can log dozens of shutdown steps after its refusal. The displayed tail stays capped.
export const startupFailureLogLookback = (contract: ServiceDataVersion | undefined): number =>
  contract !== undefined && contract.refusals.length > 0 ? 200 : 50;

export const dataVersionRemediation = (
  plan: AppPlan,
  service: ServicePlan,
  diagnostic: { readonly finding: ServiceDataVersionFinding; readonly hint?: string },
): string => {
  const { finding, hint } = diagnostic;
  const label = service.dataVersion?.label ?? "database";
  const current =
    finding.dataVersion === undefined ? `the previous ${label} version` : `${label} ${finding.dataVersion}`;
  const restore = `set \`services.${service.name}\` back to ${current}. Change its \`type:\` pin, or set \`image:\` with an unversioned type.`;
  const extra = hint === undefined ? "" : ` ${hint}`;
  if (plan.extensions["@lando/core/scratch"] !== undefined)
    return `Use ${current} in the scratch source configuration before creating another scratch. If the failed scratch was retained, inspect it with \`lando scratch:logs ${plan.id}\`.${extra}`;
  if (plan.id === "global")
    return `To keep the data, ${restore} Run \`lando global:start\` only with a compatible image. To change versions without reusing the data files, export using the old server's tools and import onto fresh storage. \`lando global:destroy --volumes\` deletes all global service data, not just this database.${extra}`;
  if (hint !== undefined) return `To keep the data, ${restore}${extra}`;
  const commands = `With that configuration restored, start the old server if needed and run \`lando db:export dump.sql.gz --service ${service.name}\`. Verify the dump and back up the other services: \`lando destroy -y --volumes\` deletes every service's data in the app. After destroying, select the desired version, run \`lando start\`, and import with \`lando db:import dump.sql.gz --service ${service.name} --yes\`.`;
  return finding.direction === "downgrade"
    ? `To keep the data, ${restore} To move the data to the older version, export and import it instead. ${commands}`
    : `The selected server cannot open these data files in place. First ${restore} ${commands}`;
};
