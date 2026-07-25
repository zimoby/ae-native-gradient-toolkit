export type GradientColorStop = {
  offset: number;
  midpoint: number;
  rgb: [number, number, number];
  extra: number;
};

export type GradientAlphaStop = {
  offset: number;
  midpoint: number;
  alpha: number;
};

export type NativeGradient = {
  schemaVersion: 1;
  colorStops: GradientColorStop[];
  alphaStops: GradientAlphaStop[];
};
