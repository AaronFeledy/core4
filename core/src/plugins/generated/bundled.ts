/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bundled-plugins.ts`.
 *
 * Source of truth: `core/build.config.ts` (the "ship list").
 *
 * The default Lando v4 binary is built with `bun build --compile`.
 * Compiled binaries cannot dynamically `import()` arbitrary files at
 * runtime, so bundled plugins are statically imported here. Library consumers
 * do not receive bundled plugins by default — they must opt into bundled
 * discovery or contribute their own Layers.
 */

import type { LandoPluginModule } from "@lando/sdk/plugins";

import { plugin as plugin8 } from "@lando/ca-mkcert";
import { plugin as plugin7 } from "@lando/file-sync-mutagen";
import { plugin as plugin4 } from "@lando/logger-pretty";
import { plugin as plugin6 } from "@lando/notify-lando";
import { plugin as plugin1 } from "@lando/provider-docker";
import { plugin as plugin0 } from "@lando/provider-lando";
import { plugin as plugin2 } from "@lando/provider-podman";
import { plugin as plugin9 } from "@lando/proxy-traefik";
import { plugin as plugin5 } from "@lando/renderer-lando";
import { plugin as plugin3 } from "@lando/service-lando";
import { plugin as plugin10 } from "@lando/template-handlebars";
import { plugin as plugin11 } from "@lando/template-mustache";

export const BUNDLED_PLUGIN_MODULES: ReadonlyArray<LandoPluginModule> = [
  plugin0,
  plugin1,
  plugin2,
  plugin3,
  plugin4,
  plugin5,
  plugin6,
  plugin7,
  plugin8,
  plugin9,
  plugin10,
  plugin11,
];
