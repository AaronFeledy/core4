import { defineLandofile, override, reset } from "@lando/sdk";

export default defineLandofile({
  services: {
    web: {
      environment: { DEBUG: reset() },
      routes: override(["web.local.test"]),
    },
  },
});
