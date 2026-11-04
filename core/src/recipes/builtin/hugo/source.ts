import type { RecipeSource } from "@lando/sdk/schema";
import { staticWebService } from "../source-web.ts";
import { HUGO_BUILD_ARTIFACT } from "./install.ts";

export const source = {
  id: "hugo",
  title: "Hugo",
  description: "Hugo static site with a Node-based build helper and an nginx static frontend.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["hugo", "static"],
  config: {
    runtime: 4,
    services: {
      builder: {
        type: "node:lts",
        primary: true,
        build: { artifact: HUGO_BUILD_ARTIFACT },
        command: "hugo server --bind 0.0.0.0 --port 1313",
        port: 1313,
      },
      web: staticWebService("public"),
    },
    tooling: {
      hugo: {
        service: "builder",
        description: "Run the Hugo CLI inside the builder service.",
        cmds: ["hugo"],
      },
      npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
    },
  },
  files: [
    { src: "assets/hugo.toml", dest: "hugo.toml", template: true },
    { src: "assets/archetypes/default.md", dest: "archetypes/default.md", template: false },
    { src: "assets/content/_index.md", dest: "content/_index.md", template: false },
    { src: "assets/layouts/baseof.html", dest: "layouts/baseof.html", template: false },
    { src: "assets/layouts/home.html", dest: "layouts/home.html", template: false },
    { src: "assets/layouts/single.html", dest: "layouts/single.html", template: false },
    { src: "assets/layouts/list.html", dest: "layouts/list.html", template: false },
  ],
  postInit: [
    { type: "message", text: "Run 'lando start' inside the new app directory to serve the Hugo site." },
  ],
} as const satisfies RecipeSource;
