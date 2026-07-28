import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NATIVE_GRADIENT_TEMPLATE_METADATA,
  getNativeGradientTemplateMetadata,
  type NativeGradientTemplateFamily,
  type NativeGradientTemplateKind,
} from "../src/native-gradient-templates.ts";

const PACKAGE_NAME = "@zimoby/ae-native-gradient";
const families: readonly NativeGradientTemplateFamily[] = ["ae22-6", "ae25-6", "ae26-3"];
const kinds: readonly NativeGradientTemplateKind[] = ["fill", "stroke"];

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

test("versioned template metadata is immutable and matches every public binary export", () => {
  assert.equal(Object.isFrozen(NATIVE_GRADIENT_TEMPLATE_METADATA), true);

  for (const family of families) {
    assert.equal(Object.isFrozen(NATIVE_GRADIENT_TEMPLATE_METADATA[family]), true);
    for (const kind of kinds) {
      const metadata = getNativeGradientTemplateMetadata(family, kind);
      assert.equal(Object.isFrozen(metadata), true);
      assert.equal(metadata.packageSubpath, `./templates/${family}/${kind}.ffx`);

      const packageSpecifier = `${PACKAGE_NAME}/${metadata.packageSubpath.slice(2)}`;
      const path = fileURLToPath(import.meta.resolve(packageSpecifier));
      const bytes = new Uint8Array(readFileSync(path));
      assert.equal(bytes.byteLength, metadata.byteLength);
      assert.equal(sha256(bytes), metadata.sha256);
    }
  }
});

test("unversioned template exports remain exact AE 26.3 aliases", () => {
  for (const kind of kinds) {
    const legacyPath = fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/templates/${kind}.ffx`));
    const versionedPath = fileURLToPath(
      import.meta.resolve(`${PACKAGE_NAME}/templates/ae26-3/${kind}.ffx`),
    );
    assert.equal(legacyPath, versionedPath);
  }
});
