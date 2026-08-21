import type { AppFeatureDefinition } from "@lando/sdk/services";

import { nginxPhpFpmWireFeature } from "../services/nginx.ts";
import { phpMyAdminWireFeature } from "../services/phpmyadmin.ts";

export const appFeatures: ReadonlyMap<string, AppFeatureDefinition> = new Map([
  [phpMyAdminWireFeature.id, phpMyAdminWireFeature],
  [nginxPhpFpmWireFeature.id, nginxPhpFpmWireFeature],
]);
