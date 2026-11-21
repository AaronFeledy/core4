import { eligibleBindingPath } from "@lando/landofile/secret-reference";
import { parseValidationIssuePath } from "@lando/sdk/schema";

export const parseSecretBindingField = (field: string) => {
  const path = parseValidationIssuePath(field);
  return path !== undefined &&
    eligibleBindingPath(path) &&
    !path.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")
    ? path
    : undefined;
};
