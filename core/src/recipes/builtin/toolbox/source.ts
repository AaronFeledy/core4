import type { RecipeSource } from "@lando/sdk/schema";
import { TOOLBOX_IMAGE } from "./image.ts";

export const source = {
  id: "toolbox",
  title: "Toolbox",
  description: "Disposable tool-runner default — one general-purpose CLI service on a pinned image.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["tools", "starter"],
  config: {
    runtime: 4,
    services: { toolbox: { type: "lando", primary: true, image: TOOLBOX_IMAGE, command: "sleep infinity" } },
  },
  postInit: [
    {
      type: "message",
      text: "Run `lando start` to boot the toolbox service, or run one-shot tools against it.",
    },
  ],
} as const satisfies RecipeSource;
