import { ToolingExecError } from "@lando/sdk/errors";

export const availableServiceList = (services: Readonly<Record<string, { readonly name: string }>>): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

export const unknownPlanServiceError = ({
  prefix,
  tool,
  requested,
  services,
  planLabel = "app plan",
  remediation,
}: {
  readonly prefix: string;
  readonly tool: string;
  readonly requested: string;
  readonly services: Readonly<Record<string, { readonly name: string }>>;
  readonly planLabel?: string;
  readonly remediation: (first: string) => string | undefined;
}): ToolingExecError => {
  const list = availableServiceList(services);
  const first = list.split(", ")[0];
  const fix = first === undefined || first.length === 0 ? undefined : remediation(first);
  return new ToolingExecError({
    message:
      list.length === 0
        ? `${prefix}: service ${requested} is not in the ${planLabel}.`
        : `${prefix}: service ${requested} is not in the ${planLabel} (available: ${list}).`,
    tool,
    ...(fix === undefined ? {} : { remediation: fix }),
  });
};
