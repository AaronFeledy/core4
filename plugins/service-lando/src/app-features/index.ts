import type { AppFeatureDefinition } from "@lando/sdk/services";

import { nginxPhpFpmWireFeature } from "../services/nginx.ts";
import { phpDbClientFeature } from "../services/php-db-client.ts";
import { phpMyAdminWireFeature } from "../services/phpmyadmin.ts";
import { mailpitWireFeature } from "./mailpit.ts";

export const appFeatures: ReadonlyMap<string, AppFeatureDefinition> = new Map([
  [mailpitWireFeature.id, mailpitWireFeature],
  [phpDbClientFeature.id, phpDbClientFeature],
  [phpMyAdminWireFeature.id, phpMyAdminWireFeature],
  [nginxPhpFpmWireFeature.id, nginxPhpFpmWireFeature],
]);
