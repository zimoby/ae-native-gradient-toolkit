# Contributing

Contributions that improve deterministic After Effects gradient parsing, inspection, fixture coverage, or FFX generation are welcome.

## Development

Use Node.js 22 and install the locked dependencies:

```bash
npm ci
npm run check
```

`npm run check` is the canonical gate. It builds the TypeScript sources, runs the full test suite, and verifies the exact npm package contents.

## Pull requests

Keep changes focused and include tests for observable behavior. Before opening a pull request:

- run `npm run check`;
- explain compatibility or format assumptions;
- preserve deterministic output and fail-closed validation;
- update fixture manifests and frozen hashes when fixture bytes intentionally change;
- avoid committing generated `dist/` output or local runtime evidence.

Binary FFX and AEP fixtures are reviewed artifacts. Do not replace them without documenting their origin, intended After Effects version, and corresponding manifest updates.
