import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { lampProducer, lampSnapshot } from "./snapshot.ts";

export const lampDecomposer = makeOptionBearingDecomposer({
  producer: lampProducer,
  displayName: "LAMP",
  optionTypes: lampSnapshot.optionTypes,
  fragment: (input) => {
    const composerEnabled = input.options.composer !== "false";
    return {
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "none",
          webroot: "{{ recipe.webroot }}",
          composer: composerEnabled ? "{{ recipe.composer }}" : false,
          port: 80,
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
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
