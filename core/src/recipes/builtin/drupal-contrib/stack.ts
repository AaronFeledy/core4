export const contribMountTarget = (type: string, project: string): string =>
  `/app/web/${type}s/custom/${project}`;

/** The sync helper's arguments; the constraint stays one argument however many spaces it holds. */
export const contribSyncArgv = [
  "lando-drupal-contrib-sync",
  "{{ recipe.type }}",
  "{{ recipe.project }}",
  "{{ recipe.drupal }}",
] as const;
