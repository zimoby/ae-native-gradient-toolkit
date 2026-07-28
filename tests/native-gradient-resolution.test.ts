import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NativeGradientResolutionError,
  createImplicitDefaultNativeGradient,
  resolveAepNativeGradients,
} from "../src/native-gradient-resolution.ts";
import type { AepNativeGradientTargetDescriptor } from "../src/aep-gradient-identity.ts";
import type { NativeGradient } from "../src/native-gradient-types.ts";
import { parseRifx } from "../src/riff-rifx.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_PATH = join(REPO_ROOT, "tests/fixtures/native-gradient/exact-identity-ae25.aep");
const EXPECTED_PATH = join(
  REPO_ROOT,
  "tests/fixtures/native-gradient/exact-identity-ae25.expected.json",
);

type FrozenTarget = AepNativeGradientTargetDescriptor & {
  gradient: NativeGradient;
};

type FrozenExpected = {
  targets: FrozenTarget[];
};

const source = new Uint8Array(readFileSync(FIXTURE_PATH));
const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as FrozenExpected;

const descriptor = (target: FrozenTarget): AepNativeGradientTargetDescriptor => ({
  compId: target.compId,
  layerId: target.layerId,
  layerIndex: target.layerIndex,
  kind: target.kind,
  propertyIndexPath: target.propertyIndexPath,
  matchNamePath: target.matchNamePath,
});

test("canonical implicit native gradient is the fixture-authenticated AE default", () => {
  assert.deepEqual(createImplicitDefaultNativeGradient(), {
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
});

test("resolves an ordered descriptor batch from one AEP parse", () => {
  const selected = [expected.targets[2], expected.targets[0], expected.targets[3]];
  const gradients = resolveAepNativeGradients(source, selected.map(descriptor));
  assert.deepEqual(gradients, selected.map((target) => target.gradient));
});

test("empty descriptor batches return without parsing bytes", () => {
  assert.deepEqual(resolveAepNativeGradients(new Uint8Array(), []), []);
});

test("one unresolved descriptor rejects the complete batch with a stable code", () => {
  const missing = descriptor(expected.targets[0]);
  assert.throws(
    () => resolveAepNativeGradients(source, [{ ...missing, compId: missing.compId + 1 }]),
    (error: unknown) => {
      assert.equal(error instanceof NativeGradientResolutionError, true);
      assert.equal((error as NativeGradientResolutionError).code, "target-not-resolved");
      return true;
    },
  );
});

test("an exact target with a malformed payload reports gradient-invalid", () => {
  const document = parseRifx(source);
  const gradientList = document.root.children
    .flatMap(function descendants(node): typeof document.root[] {
      return [node, ...node.children.flatMap(descendants)];
    })
    .find((node) => node.id === "LIST" && node.formType === "GCky");
  assert.notEqual(gradientList, undefined);
  const utf8 = gradientList!.children.filter((node) => node.id === "Utf8");
  assert.equal(utf8.length, 1);

  const malformed = source.slice();
  malformed[utf8[0].span.dataStart] = "!".charCodeAt(0);
  assert.throws(
    () => resolveAepNativeGradients(malformed, [descriptor(expected.targets[0])]),
    (error: unknown) => {
      assert.equal(error instanceof NativeGradientResolutionError, true);
      assert.equal((error as NativeGradientResolutionError).code, "gradient-invalid");
      return true;
    },
  );
});
