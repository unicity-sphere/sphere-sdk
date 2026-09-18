# Sphere CLI

The Sphere CLI is a **standalone package**: it is no longer part of this SDK repo, and its full
command reference lives with it (kept in sync there, not here).

The Sphere CLI lives in its own repository, [unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli),
and is not published to npm yet: `npm install -g @unicity-sphere/cli` fails with a 404.

- **Repository:** [unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli) (package name `@unicity-sphere/cli`)
- **Status:** no releases; its `package.json` is at version `0.0.0` and depends on
  `"@unicitylabs/sphere-sdk": "file:../../sphere-sdk"`, so it builds only next to a local checkout of this SDK.
  Check that repository for build instructions and for which SDK version it currently targets.

> The old `npm run cli` script in `sphere-sdk` no longer runs a CLI: it prints a pointer to the package and exits
> with an error. See the CLI repo above for the command reference (wallet, payments, messaging).
