import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { joomlaProducer, joomlaSnapshot } from "./snapshot.ts";

export const joomlaDecomposer = makeOptionBearingDecomposer({
  producer: joomlaProducer,
  displayName: "Joomla",
  optionTypes: joomlaSnapshot.optionTypes,
  fragment: (input) => {
    const composerEnabled = input.options.composer !== "false";
    return {
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "joomla",
          webroot: "{{ recipe.webroot }}",
          composer: composerEnabled ? "{{ recipe.composer }}" : false,
          allowOverride: true,
          port: 80,
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        joomla: {
          service: "appserver",
          description: "Run the Joomla CLI inside the appserver service.",
          cmds: ["php cli/joomla.php"],
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
