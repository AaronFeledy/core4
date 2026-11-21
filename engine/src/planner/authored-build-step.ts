export const AUTHORED_BUILD_STEP_PREFIX = "authored-";
export const isAuthoredBuildStep = (step: { readonly id?: string }) =>
  step.id?.startsWith(AUTHORED_BUILD_STEP_PREFIX) === true;
