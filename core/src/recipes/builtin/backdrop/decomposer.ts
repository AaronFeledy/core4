import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { BACKDROP_SETTINGS_VALUE, backdropProducer, backdropSnapshot } from "./snapshot.ts";

export const backdropDecomposer = makeOptionBearingDecomposer({
  producer: backdropProducer,
  displayName: "Backdrop",
  optionTypes: backdropSnapshot.optionTypes,
  fragment: (input) => {
    const composerEnabled = input.options.composer !== "false";
    return {
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "backdrop",
          webroot: "{{ recipe.webroot }}",
          composer: composerEnabled ? "{{ recipe.composer }}" : false,
          allowOverride: true,
          port: 80,
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          environment: { BACKDROP_SETTINGS: BACKDROP_SETTINGS_VALUE },
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        bee: {
          service: "appserver",
          description: "Run Bee inside the appserver service.",
          cmds: ["bee"],
        },
        ...(composerEnabled
          ? {
              composer: {
                service: "appserver",
                description: "Run Composer inside the appserver service.",
                cmds: ["composer"],
              },
            }
          : {}),
        php: {
          service: "appserver",
          description: "Run the PHP CLI inside the appserver service.",
          cmds: ["php"],
        },
      },
    };
  },
});
