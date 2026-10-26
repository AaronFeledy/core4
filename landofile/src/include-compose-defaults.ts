import { isLandofileOverride, isLandofileReset, isPlainRecord, override } from "@lando/sdk/landofile";

const mapValue = (value: unknown, transform: (plain: unknown) => unknown): unknown =>
  isLandofileReset(value)
    ? value
    : isLandofileOverride(value)
      ? override(mapValue(value.value, transform))
      : transform(value);

export const composeIncludeDefaults = (document: Record<string, unknown>): Record<string, unknown> => ({
  ...document,
  ...(document.services === undefined
    ? {}
    : {
        services: mapValue(document.services, (services) =>
          isPlainRecord(services)
            ? Object.fromEntries(
                Object.entries(services).map(([name, service]) => [
                  name,
                  mapValue(service, (config) =>
                    isPlainRecord(config)
                      ? { type: "compose", home: false, appMount: false, ...config }
                      : config,
                  ),
                ]),
              )
            : services,
        ),
      }),
});
