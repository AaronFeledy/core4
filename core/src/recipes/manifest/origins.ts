/** Private read coordinates, never portable recipe identity. */
export type RecipeDeclarationOrigin =
  | { readonly kind: "directory"; readonly root: string; readonly acquisitionRoot?: string }
  | { readonly kind: "bundled"; readonly id: string };

/** The association is data: copying a carrier cannot lose its declaration origin. */
export interface RecipeDeclaration<Value> {
  readonly value: Value;
  readonly origin: RecipeDeclarationOrigin;
}
