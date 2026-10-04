import { makeOptionBearingDecomposer } from "../option-bearing-decomposer.ts";
import { composerAndPhpTooling } from "../php-stack.ts";
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
      tooling: composerAndPhpTooling(composerEnabled, { service: "appserver" }),
    };
  },
});
