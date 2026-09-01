# Chat conformance fixture

This directory holds the broader chat fixture used by package and runtime tests. It is not a second tutorial.

The fixture covers organization ownership, direct and live reads, mutation replay, restart recovery, migration, and cross-organization denial. Its source stays outside the tutorial's TypeScript and Vite inputs.

Run it from `example/chat`:

```bash
npm run test:conformance
```

The release workflow also installs the packed `@chardb/core` and `@chardb/react` tarballs into a clean consumer before it runs the fixture. That package-bound run is the proof that matters for a release.
