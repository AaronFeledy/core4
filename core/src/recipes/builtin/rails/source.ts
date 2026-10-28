import type { RecipeSource } from "@lando/sdk/schema";
import { defaultRoutes, postgresUrl } from "../source-web.ts";

export const source = {
  id: "rails",
  title: "Ruby on Rails",
  description: "Ruby on Rails with PostgreSQL and Redis.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["rails", "ruby"],
  config: {
    runtime: 4,
    services: {
      web: {
        type: "ruby:3.3",
        framework: "rails",
        webroot: "public",
        port: 3000,
        environment: {
          RAILS_ENV: "development",
          RAILS_LOG_TO_STDOUT: "true",
          DATABASE_URL: postgresUrl,
          REDIS_URL: "redis://cache:6379",
        },
        build: {
          artifact: [
            "apt-get update && apt-get install -y --no-install-recommends build-essential",
            "gem install rails --no-document",
          ],
        },
        dependsOn: ["database", "cache"],
        routes: defaultRoutes,
      },
      database: { type: "postgres" },
      cache: { type: "redis" },
    },
    tooling: {
      rails: { service: "web", description: "Run the Rails CLI inside the web service.", cmds: ["rails"] },
      bundle: { service: "web", description: "Run Bundler inside the web service.", cmds: ["bundle"] },
      rake: { service: "web", description: "Run Rake inside the web service.", cmds: ["rake"] },
    },
  },
  files: [{ src: "assets/Gemfile", dest: "Gemfile", template: false }],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start' inside the new app directory to start the containers. Once Rails is installed, run 'lando rails server -b 0.0.0.0' to serve the app.",
    },
  ],
} as const satisfies RecipeSource;
