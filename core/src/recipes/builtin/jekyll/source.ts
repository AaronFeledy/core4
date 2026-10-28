import type { RecipeSource } from "@lando/sdk/schema";
import { staticWebService } from "../source-web.ts";

export const source = {
  id: "jekyll",
  title: "Jekyll",
  description: "Jekyll static site with a Ruby build service and an nginx static frontend.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["jekyll", "ruby", "static"],
  config: {
    runtime: 4,
    services: {
      builder: {
        type: "ruby:3.3",
        primary: true,
        framework: "none",
        build: {
          artifact: [
            "apt-get update && apt-get install -y --no-install-recommends build-essential libssl-dev zlib1g-dev",
          ],
        },
        command: "bundle exec jekyll serve --host 0.0.0.0 --port 4000",
        port: 4000,
      },
      web: staticWebService("_site"),
    },
    tooling: {
      jekyll: {
        service: "builder",
        description: "Run the Jekyll CLI inside the builder service.",
        cmds: ["bundle exec jekyll"],
      },
      bundle: {
        service: "builder",
        description: "Run Bundler inside the builder service.",
        cmds: ["bundle"],
      },
    },
  },
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to serve the Jekyll site." },
  ],
} as const satisfies RecipeSource;
