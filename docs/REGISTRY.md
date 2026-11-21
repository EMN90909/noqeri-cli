# noqeri-cli

The Noqeri library package supplies portable argument helpers. The host integration in host/noqeri-cli.mjs provides registry operations without inventing a second package format.

## Commands

Set NOQERI_REGISTRY_API_URL to the public registry API.

- noqeri search json
- noqeri add noqeri/json
- noqeri install
- noqeri build
- noqeri publish

`build` and `pack` create a deterministic `.ndl` from `nodules.toml` and `package.noqeri`. `publish` builds the current package automatically when `--archive` is omitted, derives the package coordinate, version, and entry from the header, validates the archive and its SHA-256 locally, then sends it to the private Supabase Edge Function. An explicit `--archive package.ndl` is supported, but its header must match the current package. Tokens are bearer credentials and never stored by this CLI. Raw tar formats cannot be published.
