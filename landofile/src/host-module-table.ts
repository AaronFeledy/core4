import * as sdk from "@lando/sdk";
import * as app from "@lando/sdk/app";
import * as commandResult from "@lando/sdk/command-result";
import * as databaseCreds from "@lando/sdk/database-creds";
import * as digest from "@lando/sdk/digest";
import * as errors from "@lando/sdk/errors";
import * as events from "@lando/sdk/events";
import * as expressions from "@lando/sdk/expressions";
import * as fuzzy from "@lando/sdk/fuzzy";
import * as landofile from "@lando/sdk/landofile";
import * as flowMappingRemediation from "@lando/sdk/landofile/flow-mapping-remediation";
import * as logFollow from "@lando/sdk/log-follow";
import * as networkTrust from "@lando/sdk/network-trust";
import * as plugins from "@lando/sdk/plugins";
import * as probe from "@lando/sdk/probe";
import * as recipes from "@lando/sdk/recipes";
import * as renderer from "@lando/sdk/renderer";
import * as schema from "@lando/sdk/schema";
import * as servicesSchema from "@lando/sdk/schema/services";
import * as dotnet from "@lando/sdk/schema/services/dotnet";
import * as localstack from "@lando/sdk/schema/services/localstack";
import * as mailhog from "@lando/sdk/schema/services/mailhog";
import * as mailpit from "@lando/sdk/schema/services/mailpit";
import * as minio from "@lando/sdk/schema/services/minio";
import * as mssql from "@lando/sdk/schema/services/mssql";
import * as mysql from "@lando/sdk/schema/services/mysql";
import * as php from "@lando/sdk/schema/services/php";
import * as phpmyadmin from "@lando/sdk/schema/services/phpmyadmin";
import * as rabbitmq from "@lando/sdk/schema/services/rabbitmq";
import * as tomcat from "@lando/sdk/schema/services/tomcat";
import * as varnish from "@lando/sdk/schema/services/varnish";
import * as standard from "@lando/sdk/schema/standard";
import * as secrets from "@lando/sdk/secrets";
import * as services from "@lando/sdk/services";
import * as taskProgress from "@lando/sdk/task-progress";
import * as template from "@lando/sdk/template";
import * as toolProvisioning from "@lando/sdk/tool-provisioning";
import * as verifiedStream from "@lando/sdk/verified-stream";
import * as yaml from "@lando/sdk/yaml";
import * as effect from "effect";
import * as http from "effect/http";

const namespaceModules = (
  prefix: string,
  namespace: Readonly<Record<string, unknown>>,
): Readonly<Record<string, object>> => {
  const modules: Record<string, object> = {};
  for (const [name, value] of Object.entries(namespace)) {
    if (/^[A-Z]/.test(name) && typeof value === "object" && value !== null) {
      modules[`${prefix}/${name}`] = value;
    }
  }
  return modules;
};

export const hostModules: Readonly<Record<string, object>> = {
  "@lando/sdk": sdk,
  "@lando/sdk/app": app,
  "@lando/sdk/command-result": commandResult,
  "@lando/sdk/database-creds": databaseCreds,
  "@lando/sdk/digest": digest,
  "@lando/sdk/errors": errors,
  "@lando/sdk/events": events,
  "@lando/sdk/expressions": expressions,
  "@lando/sdk/fuzzy": fuzzy,
  "@lando/sdk/landofile": landofile,
  "@lando/sdk/landofile/flow-mapping-remediation": flowMappingRemediation,
  "@lando/sdk/log-follow": logFollow,
  "@lando/sdk/network-trust": networkTrust,
  "@lando/sdk/plugins": plugins,
  "@lando/sdk/probe": probe,
  "@lando/sdk/recipes": recipes,
  "@lando/sdk/renderer": renderer,
  "@lando/sdk/schema": schema,
  "@lando/sdk/schema/services": servicesSchema,
  "@lando/sdk/schema/services/dotnet": dotnet,
  "@lando/sdk/schema/services/localstack": localstack,
  "@lando/sdk/schema/services/mailhog": mailhog,
  "@lando/sdk/schema/services/mailpit": mailpit,
  "@lando/sdk/schema/services/minio": minio,
  "@lando/sdk/schema/services/mssql": mssql,
  "@lando/sdk/schema/services/mysql": mysql,
  "@lando/sdk/schema/services/php": php,
  "@lando/sdk/schema/services/phpmyadmin": phpmyadmin,
  "@lando/sdk/schema/services/rabbitmq": rabbitmq,
  "@lando/sdk/schema/services/tomcat": tomcat,
  "@lando/sdk/schema/services/varnish": varnish,
  "@lando/sdk/schema/standard": standard,
  "@lando/sdk/secrets": secrets,
  "@lando/sdk/services": services,
  "@lando/sdk/task-progress": taskProgress,
  "@lando/sdk/template": template,
  "@lando/sdk/tool-provisioning": toolProvisioning,
  "@lando/sdk/verified-stream": verifiedStream,
  "@lando/sdk/yaml": yaml,
  effect,
  ...namespaceModules("effect", effect),
  "effect/http": http,
  ...namespaceModules("effect/http", http),
};
