import { Predicate } from "effect";

export const primaryServiceName = (
  services: Readonly<Record<string, unknown>> | undefined,
): string | undefined => {
  if (services === undefined) return undefined;
  return Object.entries(services).find(
    ([, service]) => Predicate.isObject(service) && service.primary === true,
  )?.[0];
};
