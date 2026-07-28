import {
  indexAepNativeGradientTargets,
  resolveAepNativeGradientTarget,
  type AepNativeGradientTargetDescriptor,
} from "./aep-gradient-identity.ts";
import { validateGeneratedGradient } from "./gcky-gradient.ts";
import type { NativeGradient } from "./native-gradient-types.ts";
import { parseRifx } from "./riff-rifx.ts";

export type NativeGradientResolutionErrorCode =
  | "target-not-resolved"
  | "target-ambiguous"
  | "gradient-invalid";

export class NativeGradientResolutionError extends Error {
  readonly code: NativeGradientResolutionErrorCode;

  constructor(code: NativeGradientResolutionErrorCode, message: string) {
    super(message);
    this.name = "NativeGradientResolutionError";
    this.code = code;
  }
}

export function createImplicitDefaultNativeGradient(): NativeGradient {
  return validateGeneratedGradient({
    schemaVersion: 1,
    colorStops: [
      { offset: 0, midpoint: 0.5, rgb: [1, 1, 1], extra: 1 },
      { offset: 1, midpoint: 0.5, rgb: [0, 0, 0], extra: 1 },
    ],
    alphaStops: [
      { offset: 0, midpoint: 0.5, alpha: 1 },
      { offset: 1, midpoint: 0.5, alpha: 1 },
    ],
  });
}

export function resolveAepNativeGradients(
  bytes: Uint8Array,
  descriptors: readonly AepNativeGradientTargetDescriptor[],
): NativeGradient[] {
  if (descriptors.length === 0) return [];

  const targets = indexAepNativeGradientTargets(parseRifx(bytes));
  return descriptors.map((descriptor) => {
    const resolution = resolveAepNativeGradientTarget(targets, descriptor);
    if (resolution.status === "none") {
      throw new NativeGradientResolutionError(
        "target-not-resolved",
        "Native gradient target was not found exactly in the saved project",
      );
    }
    if (resolution.status === "ambiguous") {
      throw new NativeGradientResolutionError(
        "target-ambiguous",
        "Native gradient target is ambiguous in the saved project",
      );
    }

    const candidate = resolution.target.candidate;
    if (candidate.status !== "valid") {
      throw new NativeGradientResolutionError(
        "gradient-invalid",
        "Saved native gradient payload is invalid",
      );
    }
    try {
      return validateGeneratedGradient(candidate.gradient);
    } catch {
      throw new NativeGradientResolutionError(
        "gradient-invalid",
        "Saved native gradient payload is invalid",
      );
    }
  });
}
