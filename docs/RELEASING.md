# Releasing flake-ledger

A release is a `v*` tag whose version matches `package.json`. The tag is the
only thing that publishes: `.github/workflows/publish.yml` runs on
`v*` tags, tests the package, packs the tarball, installs it into a clean
directory, and publishes that tarball to npm with provenance. Running the
workflow manually (`workflow_dispatch`) only runs the verification job; it does
not publish.

## Version rules

- Use [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.
- `package.json` holds the bare version (`0.1.0`); the tag adds the `v`
  (`v0.1.0`). The publish workflow fails if the two disagree.
- `flake-ledger --version` and the `version` field in `--json` output read the
  value from `package.json`, so a released tarball always reports its own
  version.
- Do not reuse or move a published tag. If a release fails before `npm publish`
  succeeds, delete the tag and re-tag the fixed commit with the same version;
  once the registry has that version the workflow skips publishing instead of
  overwriting it.

## One-time setup

The publish job authenticates to npm with OIDC (`id-token: write`) and
`npm publish --provenance`; it does not read an `NPM_TOKEN` secret. Before the
first release, the package owner needs a
[Trusted Publisher](https://docs.npmjs.com/trusted-publishers) entry on
npmjs.com for `flake-ledger` that names:

- repository: `WJDdidi-1/flake-ledger`
- workflow: `publish.yml`
- environment: `npm-publish`

The GitHub repository also needs an `npm-publish` environment (Settings →
Environments) and push access to `main` and tags.

## Release checklist

Run these from a clean checkout of `main`:

```sh
git switch main
git pull --ff-only
npm ci
npm test
npm run example
```

`npm test` and `npm run example` must pass before tagging. `npm test` runs the
CLI suite; `npm run example` drives `scan`, `explain`, `--quarantine`, and
`--fail-on` against the five checked-in runs.

Confirm the tarball contains what the README promises and nothing else:

```sh
npm pack --dry-run
```

Expected entries include `package.json`, `README.md`, `LICENSE`, `bin/`,
`lib/`, and `examples/`. The test suite, workflows, and `docs/` are not
published.

Then tag the exact commit that was tested and push the tag:

```sh
git tag -a v0.1.0 -m "flake-ledger v0.1.0"
git push origin v0.1.0
```

## What happens next

1. The `publish` workflow checks that `v0.1.0` matches `package.json`, runs the
   tests, packs the tarball, installs it in a clean directory, and publishes it
   with provenance.
2. It waits for the registry to serve the new version and checks that
   `npm view flake-ledger version` reports it.
3. A tag alone appears under the repository's **Tags**, not **Releases**. Create
   the GitHub Release from the tag so the version shows in the sidebar and has
   notes. Use [`docs/releases/v0.1.0.md`](releases/v0.1.0.md) as the body:

   ```sh
   gh release create v0.1.0 \
     --title "flake-ledger v0.1.0" \
     --notes-file docs/releases/v0.1.0.md \
     --verify-tag
   ```

   Without `gh`, use **Draft a new release** on the repository's Releases page,
   choose the existing tag, and paste the same notes.
4. Verify the public install path:

   ```sh
   npm install --global flake-ledger@0.1.0
   flake-ledger --version   # 0.1.0
   ```

5. If anything is wrong after publishing, ship a new patch version. Do not
   delete a version that npm already serves.

## Release notes

Keep one file per release in [`docs/releases/`](releases/). Each file is the
body of the matching GitHub Release, so it should describe only behavior that
is present at that tag and state how it was verified.
