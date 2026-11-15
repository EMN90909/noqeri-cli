# noqeri-cli

The Noqeri library package supplies portable argument helpers. The host integration in host/noqeri-cli.mjs provides registry operations without inventing a second package format.

## Commands

Set NOQERI_REGISTRY_API_URL to the public registry API.

- noqeri search json
- noqeri add noqeri/json
- noqeri install
- noqeri publish --private-url URL --token TOKEN --archive package.ndl --namespace noqeri --name json --version 1.0.0 --entry src/json.noqeri

Publishing sends the canonical .ndl bytes to the private Supabase Edge Function. Tokens are bearer credentials and never stored by this CLI.
