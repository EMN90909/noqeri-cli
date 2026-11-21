# noqeri-cli

The Noqeri library package supplies portable argument helpers. The SDK's native
`noqeri pkg` commands are the canonical registry client; the host integration
in `host/` remains a compatibility adapter and uses the same Nodule (`.ndl`)
format.

## Commands

Set NOQERI_REGISTRY_API_URL to the public registry API.

- noqeri search json
- noqeri add noqeri/json
- noqeri install
- noqeri publish --private-url URL --token TOKEN --archive package.ndl --namespace noqeri --name json --version 1.0.0 --entry src/json.noqeri

Publishing sends the canonical .ndl bytes to the private Supabase Edge Function. Tokens are bearer credentials and never stored by this CLI.

For package authors using the native SDK:

```sh
noqeri pkg pack ./my-library target/my-library-0.1.0.ndl
NOQERI_PRIVATE_REGISTRY_URL=https://registry-private.example \
NOQERI_REGISTRY_TOKEN=nq_... \
noqeri pkg publish ./my-library target/my-library-0.1.0.ndl
```
