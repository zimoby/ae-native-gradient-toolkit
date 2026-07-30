# AGENTS.md

This repository contains reusable native After Effects Shape Gradient Fill/Stroke binary tooling.

## Boundaries

- Keep product UI, CEP bridge code, palette semantics, and product persistence outside this repository.
- Keep the core library dependency-free and based on `Uint8Array`; Node filesystem and hashing belong in the CLI boundary.
- Preserve big-endian `RIFX`, nested `LIST(formType="GCky") -> Utf8`, ancestor sizes, even-byte padding, and bytes beyond the declared RIFX end.
- Reject missing, malformed, wrong-kind, oversized, or ambiguous structures; do not add offset heuristics.
- Never mutate a user's active `.aep`. Live AE proof may use only a clean token-owned scratch project under the documented harness.
- Treat repository fixtures and templates as canonical test/package assets; validate integrations against versioned package artifacts.
- Keep third-party parser/oracle source, adapters, dependency requirements, virtual environments, and regeneration commands outside this repository. The repository may retain frozen oracle result hashes and provenance only.
- Repository visibility changes, package publication, commits, pushes, AE restarts, and live host mutation require their normal explicit gates.

## Toolchain

- Local development pin: Node `22.22.3`
- Public runtime/CI support: Node `22.x` and `24.x`
- npm `10.9.8`
- TypeScript `5.8.3`

## Verification

```bash
npm ci
npm test
npm run build
npm run pack:check
```

After a package-boundary change, install the generated tarball into a clean temporary consumer and execute a real public import. Do not use a repository symlink or absolute source import as proof.

## Change discipline

- Inspect definitions and every consumer before editing.
- Use RED -> GREEN -> REFACTOR for behavior changes.
- Run focused tests, then the canonical package check.
- Review spec compliance and quality/security separately.
- Do not commit, push, publish, or change repository visibility without explicit maintainer approval.
