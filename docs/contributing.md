# Contributing and releases

The authoritative implementation is
[`nfl0/riadchain`](https://github.com/nfl0/riadchain). Open source changes there:

- `sdk/` owns the public client surface.
- `lib/` owns shared client encodings and helpers.
- `proto/riadchain.proto` owns the RPC schema.
- `sdk/release/` owns this distribution's documentation and examples.
- `sdk/scripts/` owns build and export tooling.

This standalone repository is a generated developer distribution. Do not
maintain a parallel implementation or patch generated files without applying
the same change to the canonical source. The export records its source revision
so a release can be traced to the reviewed monorepo change.

## Build independently

```sh
git clone https://github.com/nfl0/riadchain-sdk.git
cd riadchain-sdk
npm ci
npm run build
npm run verify
npm pack --dry-run
```

`src/` contains the exported SDK and its shared source dependencies; `proto/`
contains the RPC schema. `dist/` is generated JavaScript and declarations.
Consumers import the package's named entry points rather than these internal
paths. `npm run verify` checks the actual packed package in isolated consumers;
it does not start a Riadchain network or broadcast transactions.

## Maintainer publication

1. Review and merge the canonical source change, including API, protocol and
   documentation updates. Run the owning focused checks.
2. Export the standalone project from that exact revision and run its clean
   install, build, isolated-consumer verification and package inspection.
3. Review the exported dependency closure, lockfile, license, source revision and
   tarball. Exclude credentials, private deployment data, test journals and
   monorepo-only artifacts.
4. Publish the generated repository revision and an immutable stable version tag
   matching the package, such as `v2.0.1`. Configure npm's OIDC trusted publisher
   for the exact `nfl0/riadchain-sdk` repository and `publish.yml` workflow. In GitHub
   Actions, manually dispatch **Publish SDK**, selecting that tag under **Use
   workflow from**. From the CLI, the equivalent is
   `gh workflow run publish.yml --repo nfl0/riadchain-sdk --ref v2.0.1`.
   The workflow rejects branch dispatches, pins checkout to the event's commit,
   and checks that the tag matches the package version and the source record is
   clean. It then performs a clean install and isolated-consumer verification
   before publishing. npm's provenance therefore identifies the same tag/commit
   that produced the artifact. Its OIDC identity replaces a long-lived npm
   publishing token.
5. Verify the registry artifact and release metadata independently after
   publication. Keep release notes explicit about the node RPC and protocol
   behavior exercised by the release checks.

An initial publication may be performed separately by an authorized npm
maintainer before the trusted-publisher relationship is established. Complete
any required authentication privately, inspect the same verified package and
publish with public access. Do not commit or copy npm/GitHub credentials into
the generated repository or its workflows.

For a first publication that needs phone-based approval, maintainers can stage
the already verified tarball with
`npm stage publish /absolute/path/to/qualified.tgz --ignore-scripts --access public`.
Retain the returned stage ID, reconcile that original stage, and verify its
downloaded bytes before approving it in npm's **Staged Packages** page. A new
package has a public placeholder until its staged release is approved. Do not
submit another publication for the same reserved version.

A newly configured trusted publisher must complete its first successful publish
within two days or npm expires it. Save the relationship when a real qualified
release is ready, and verify the resulting registry provenance after publication.
See [npm's current requirements](https://docs.npmjs.com/trusted-publishers/).

When changing dependencies, update the lockfile in a fresh generated project
with `npm install --package-lock-only --ignore-scripts`, then copy its
`package-lock.json` back into the monorepo's `sdk/release/package-lock.json`
template. Review and commit that source change, and export again from the clean
revision before tagging a release. The SDK version comes from
`sdk/package.json` in the canonical repository; do not version the generated
package independently.

Building, exporting and packing do not authorize publication. A successful
isolated import check proves packaging behavior; it does not establish live
node compatibility, browser-wallet approval behavior or multi-node FILE
replication. Report those evidence boundaries in release notes.
