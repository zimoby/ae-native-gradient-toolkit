export type NativeGradientTemplateFamily = "ae22-6" | "ae25-6" | "ae26-3";
export type NativeGradientTemplateKind = "fill" | "stroke";

export type NativeGradientTemplateMetadata = Readonly<{
  packageSubpath: string;
  byteLength: number;
  sha256: string;
}>;

export const NATIVE_GRADIENT_TEMPLATE_METADATA: Readonly<
  Record<
    NativeGradientTemplateFamily,
    Readonly<Record<NativeGradientTemplateKind, NativeGradientTemplateMetadata>>
  >
> = Object.freeze({
  "ae22-6": Object.freeze({
    fill: Object.freeze({
      packageSubpath: "./templates/ae22-6/fill.ffx",
      byteLength: 6376,
      sha256: "06120a98926bc03906a607481345e8e2d6d8938b32e090752f87847d21a426d2",
    }),
    stroke: Object.freeze({
      packageSubpath: "./templates/ae22-6/stroke.ffx",
      byteLength: 6376,
      sha256: "e934fed01b7c9e52c60210714ea916556b3cf159bb7dc09114045b516cb47b3b",
    }),
  }),
  "ae25-6": Object.freeze({
    fill: Object.freeze({
      packageSubpath: "./templates/ae25-6/fill.ffx",
      byteLength: 6326,
      sha256: "a0cddaf936cc337a427d3a81c4224764fd6fc1f13a9bbeb6ae863276fa28dc59",
    }),
    stroke: Object.freeze({
      packageSubpath: "./templates/ae25-6/stroke.ffx",
      byteLength: 6326,
      sha256: "cb1ffe6195604834203a950433a83dd7097e971f8477567fdc2c32e3c34ed9dd",
    }),
  }),
  "ae26-3": Object.freeze({
    fill: Object.freeze({
      packageSubpath: "./templates/ae26-3/fill.ffx",
      byteLength: 6332,
      sha256: "01dd99135c1ce428fabad2422d18e7742a87853d717e0f8342d64e9c84cdef28",
    }),
    stroke: Object.freeze({
      packageSubpath: "./templates/ae26-3/stroke.ffx",
      byteLength: 6332,
      sha256: "693fb4244b2cc7795401f63e24410854bd54ac928f9434289d2a7b6f229a0d3e",
    }),
  }),
});

export function getNativeGradientTemplateMetadata(
  family: NativeGradientTemplateFamily,
  kind: NativeGradientTemplateKind,
): NativeGradientTemplateMetadata {
  return NATIVE_GRADIENT_TEMPLATE_METADATA[family][kind];
}
