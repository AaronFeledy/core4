import { makeZeroOptionDecomposer } from "../zero-option-decomposer.ts";
import { railsProducer } from "./snapshot.ts";

export const railsDecomposer = makeZeroOptionDecomposer({
  producer: railsProducer,
  displayName: "Rails",
  fragment: () => ({
    services: {
      web: {
        type: "ruby:3.3",
        framework: "rails",
        port: 3000,
        environment: {
          DATABASE_URL:
            "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ services.database.creds.database }}",
          REDIS_URL: "redis://cache:6379",
        },
        build: {
          artifact: [
            "apt-get update && apt-get install -y --no-install-recommends build-essential",
            "gem install rails --no-document",
          ],
        },
        dependsOn: ["database", "cache"],
        routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      },
      database: { type: "postgres" },
      cache: { type: "redis" },
    },
    tooling: {
      rails: { service: "web", description: "Run the Rails CLI inside the web service.", cmds: ["rails"] },
      bundle: { service: "web", description: "Run Bundler inside the web service.", cmds: ["bundle"] },
      rake: { service: "web", description: "Run Rake inside the web service.", cmds: ["rake"] },
    },
  }),
});
