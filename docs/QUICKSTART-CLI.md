# Sphere CLI

The Sphere CLI is not part of this SDK package. It lives in its own repository,
[unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli), and is not published to npm yet:
`npm install -g @unicity-sphere/cli` fails with a 404.

- **Repository:** [unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli) (package name `@unicity-sphere/cli`)
- **Status:** no releases; its `package.json` is at version `0.0.0` and depends on
  `"@unicitylabs/sphere-sdk": "file:../../sphere-sdk"`, so it builds only next to a local checkout of this SDK.
  The install step in that repository's README (`npm install -g @unicity-sphere/cli`) fails the same way until the
  package is published.
- **Commands:** the command reference is in that repository, not here. Check there which SDK version it
  currently targets.

> The old `npm run cli` script in `sphere-sdk` no longer runs a CLI: it prints a pointer to the package and exits
> with an error.
