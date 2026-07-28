# AE Native Gradient Toolkit

[![CI](https://github.com/zimoby/ae-native-gradient-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/zimoby/ae-native-gradient-toolkit/actions/workflows/ci.yml)

Reusable TypeScript and Node tooling for native Adobe After Effects Shape Gradient Fill and Stroke data.

The toolkit provides one reusable implementation for parsing, inspecting, and generating native AE Shape Gradient Fill and Stroke data. It is available under the MIT license.

## Current capabilities

- Parse bounded big-endian `RIFX` files.
- Preserve nested chunk spans, even-byte padding, and trailers outside the declared RIFX boundary.
- Replace one leaf payload and update only affected size words.
- Parse and serialize native `LIST(formType="GCky") -> Utf8` gradient XML.
- Normalize complete color and alpha stops, including AE's sixth color-stop `extra` value.
- Inventory native gradients in `.aep` and `.ffx` files and require a unique valid candidate.
- Generate deterministic native Gradient Fill or Stroke `.ffx` bytes from package-owned templates.
- Verify kind identity, target-header identity, size-field-only prefix changes, output gradient values, suffix bytes, and AE trailer bytes.
- Inspect bounded regular files through the packaged CLI.
- Explain generation with structural and SHA-256 evidence before any write.
- Write through a verified sibling temporary file only with explicit `--write`; refuse replacement unless `--force` is present.
- Verify owned AE 26.3 Fill/Stroke fixtures against frozen independent-oracle output.
- Resolve ordered exact AEP target descriptors to complete gradients in one bounded parse.
- Materialize the fixture-authenticated implicit AE white-to-black gradient default.
- Ship provenance-approved AE 22.6, AE 25.6, and AE 26.3 template families with immutable integrity metadata.

The external mechanism proof passed in AE `26.3x87` for Gradient Fill and Stroke with 2, 3, and 8 stops. Each case proved apply, saved-AEP readback, separate Undo, sibling/selection preservation, and owned cleanup. Product integration and exact-version compatibility gates remain intentionally pending and are not release claims.

## Installation and release status

Package identity: `@zimoby/ae-native-gradient@0.2.0`.

The package is not yet published to npm and no public release tag exists. After this repository becomes public, Git consumers should resolve `main` once and install the resulting immutable full commit:

```bash
TOOLKIT_SHA="$(git ls-remote https://github.com/zimoby/ae-native-gradient-toolkit.git refs/heads/main | cut -f1)"
npm install "git+https://github.com/zimoby/ae-native-gradient-toolkit.git#$TOOLKIT_SHA"
```

Do not use `npm install @zimoby/ae-native-gradient` until an npm release is announced. Each npm `X.Y.Z` release must have a matching immutable `vX.Y.Z` Git tag pointing to the same source commit.

The package is licensed under MIT. Repository visibility, Git tags, and npm publication are separate release actions.

Third-party validation tooling is intentionally external to this repository. `py-aep` was used as a pinned MIT-licensed read-only oracle, but its source, adapter, dependency requirements, environment, and regeneration command are not part of this project or package. The repository retains only owned fixtures plus frozen provenance and agreement hashes.

## Compatibility

| Surface | Contract |
|---|---|
| Node.js | `22.x`; package engine is `>=22 <23`, CI pins `.node-version` (`22.22.3`) |
| Modules | ESM only |
| Automated CI | Ubuntu with the pinned Node version |
| AEP identity indexing | Explicit project-format schemas `93..97`; unknown formats fail closed |
| Package templates | Versioned AE 22.6, AE 25.6, and AE 26.3 Fill/Stroke families; product support policy remains consumer-owned |
| Live AE mechanism proof | After Effects `26.3x87` on macOS `15.7.1` |

The AE 26.3 result validates the native Fill/Stroke mechanism for the tested proof matrix. It is not a broad claim that every AE version, operating system, or product integration is supported.

## Development

```bash
npm ci
npm test
npm run build
npm run pack:check
```

## Library use

```js
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateGradientFfx } from "@zimoby/ae-native-gradient";

const gradient = {
  schemaVersion: 1,
  colorStops: [
    { offset: 0, midpoint: 0.5, rgb: [1, 0, 0], extra: 0 },
    { offset: 1, midpoint: 0.5, rgb: [0, 0, 1], extra: 0 },
  ],
  alphaStops: [
    { offset: 0, midpoint: 0.5, alpha: 1 },
    { offset: 1, midpoint: 0.5, alpha: 1 },
  ],
};

const templatePath = fileURLToPath(
  import.meta.resolve("@zimoby/ae-native-gradient/templates/fill.ffx"),
);
const templateBytes = new Uint8Array(await readFile(templatePath));
const { bytes, report } = generateGradientFfx(templateBytes, "fill", gradient);
await writeFile("generated-fill.ffx", bytes);
console.log(report.verification);
```

`generateGradientFfx()` is pure: it accepts and returns bytes, performs no filesystem access, and emits no hashes. Filesystem policy and hashes belong to the CLI/host adapter.

## CLI use

Create `gradient.json`:

```json
{
  "schemaVersion": 1,
  "colorStops": [
    { "offset": 0, "midpoint": 0.5, "rgb": [1, 0, 0], "extra": 0 },
    { "offset": 1, "midpoint": 0.5, "rgb": [0, 0, 1], "extra": 0 }
  ],
  "alphaStops": [
    { "offset": 0, "midpoint": 0.5, "alpha": 1 },
    { "offset": 1, "midpoint": 0.5, "alpha": 1 }
  ]
}
```

Each stop list must contain 2–8 entries with nondecreasing offsets. Offsets, midpoints, and alpha values are in `[0, 1]`; RGB and AE's sixth color-stop `extra` value must be finite numbers.

Then run:

```bash
ae-native-gradient --help
ae-native-gradient inspect --unique /absolute/path/to/file.aep

# Explain only; prints structural and SHA-256 evidence and writes nothing.
ae-native-gradient generate \
  --kind fill \
  --config /absolute/path/to/gradient.json

# Explicit verified write using the package-owned Fill template.
ae-native-gradient generate \
  --kind fill \
  --config /absolute/path/to/gradient.json \
  --write /absolute/path/to/generated.ffx
```

Use `--template /absolute/path/to/template.ffx` only when intentionally testing another owned template. Existing outputs are refused unless `--force` is supplied. The CLI reads only bounded regular files, rejects unsafe output aliases/symlinks, verifies temporary output by readback hash, and leaves no partial destination on handled failure.

## Canonical assets

Package subpaths:

- `@zimoby/ae-native-gradient/templates/fill.ffx`
- `@zimoby/ae-native-gradient/templates/stroke.ffx`
- `@zimoby/ae-native-gradient/templates/ae22-6/fill.ffx`
- `@zimoby/ae-native-gradient/templates/ae22-6/stroke.ffx`
- `@zimoby/ae-native-gradient/templates/ae25-6/fill.ffx`
- `@zimoby/ae-native-gradient/templates/ae25-6/stroke.ffx`
- `@zimoby/ae-native-gradient/templates/ae26-3/fill.ffx`
- `@zimoby/ae-native-gradient/templates/ae26-3/stroke.ffx`

The unversioned paths remain backward-compatible aliases for the AE 26.3 family. All listed files are package-owned templates, not product-owned copies.

## Consumer policy

Verify integration using a packed tarball in a clean temporary consumer, then depend on a reviewed npm version or exact Git commit. Immutable versions are recommended for reproducibility. The MIT license permits copying, modification, and redistribution.

## Support and contributing

Use [GitHub Issues](https://github.com/zimoby/ae-native-gradient-toolkit/issues) for reproducible bugs and feature requests. Include Node/npm versions, AE version when relevant, the command or API call, expected versus actual behavior, and a minimal redistributable fixture when possible. Do not attach sensitive production AEP files publicly.

Focused pull requests are welcome. Run `npm ci` and `npm run check` before submitting. New binary fixtures must have explicit ownership, acquisition, hash, and distribution metadata.

Report security issues through [GitHub private vulnerability reporting](https://github.com/zimoby/ae-native-gradient-toolkit/security/advisories/new), not a public issue.

## License

MIT. See `LICENSE`.
