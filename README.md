# noqeri-cli

A Noqeri CLI library and host integration for the 2026 language edition. The host integration creates deterministic Nodules (`.ndl`) and connects the CLI to the public and private registries.

## Layout

- `package.noqeri`: canonical package manifest.
- `nodules.toml`: archive header and package inclusion rules.
- `src/cli.noqeri`: exported library source.
- `host/nodule-pack.mjs`: deterministic `.ndl`, `tar.gz`, and debugging `raw-tar` packer.
- `tests/release_smoke.noqeri`: deterministic source-level smoke fixture.
- `API_REFERENCE.md`: public API and host-boundary notes.

Run the smoke fixture with the Noqeri compiler available in the SDK:

```sh
noqeri check src/cli.noqeri
noqeri test tests
```

Run `noqeri pack` or `noqeri build` from a package directory to create `dist/<namespace>-<name>-<version>.ndl`. The archive includes `nodules.toml` and `package.noqeri`; the CLI checks that both manifests agree. `--format tar.gz` and `--raw-tar` are explicit debugging formats. Registry publishing accepts `.ndl` archives only.

