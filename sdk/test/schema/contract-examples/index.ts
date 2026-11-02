import { table as appMountInput } from "./app-mount-input.ts";
import { table as caInput } from "./ca-input.ts";
import { table as certsInput } from "./certs-input.ts";
import { table as commandSpec } from "./command-spec.ts";
import { table as containerUser } from "./container-user.ts";
import { table as endpointInput } from "./endpoint-input.ts";
import { table as healthcheckInput } from "./healthcheck-input.ts";
import { table as logSourceInput } from "./log-source-input.ts";
import { table as mountInput } from "./mount-input.ts";
import { table as portablePath } from "./portable-path.ts";
import { table as providerId } from "./provider-id.ts";
import { table as routeInput } from "./route-input.ts";
import { table as storageInput } from "./storage-input.ts";
import type { NamedContractTable } from "./types.ts";

export const namedContractTables: ReadonlyArray<NamedContractTable> = [
  portablePath,
  providerId,
  endpointInput,
  routeInput,
  healthcheckInput,
  logSourceInput,
  appMountInput,
  mountInput,
  storageInput,
  certsInput,
  caInput,
  commandSpec,
  containerUser,
];
