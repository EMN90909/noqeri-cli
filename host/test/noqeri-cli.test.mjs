import test from 'node:test'
import assert from 'node:assert/strict'
import { main, search, publish, packPackage } from '../noqeri-cli.mjs'
import { decodeArchive } from '../registry-client.mjs'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('search uses the public read-only API', async () => {
  process.env.NOQERI_REGISTRY_API_URL = 'https://registry.test'
  const calls = []
  const result = await search('json', async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ packages: [{ name: 'json' }] }), { status: 200 })
  })
  assert.equal(result.packages[0].name, 'json')
  assert.equal(calls[0].url, 'https://registry.test/v1/search?q=json')
  assert.equal(calls[0].options.method, undefined)
})

test('publish sends an .ndl archive with bearer auth and SHA-256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noqeri-cli-'))
  const archive = join(root, 'sample.ndl')
  await writeFile(archive, Buffer.from([31, 139, 8, 0]))
  let request
  const result = await publish({ privateUrl: 'https://private.test', token: 'nq_test_token', namespace: 'noqeri', name: 'json', version: '1.0.0', entry: 'src/json.noqeri', archive }, async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ state: 'submitted' }), { status: 201 })
  })
  assert.equal(result.state, 'submitted')
  assert.equal(request.url, 'https://private.test/v1/publish')
  assert.equal(request.options.headers.authorization, 'Bearer nq_test_token')
  const parsed = JSON.parse(request.options.body)
  assert.match(parsed.archive_base64, /^[A-Za-z0-9+/=]+$/)
  assert.match(parsed.archive_sha256, /^[0-9a-f]{64}$/)
})

test('packPackage builds a verifiable gzip+ustar .ndl decoded by registry-client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noqeri-pack-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.noqeri'), 'package {\n  name: "noqeri/demo"\n  version: "1.0.0"\n  entry: "src/demo.noqeri"\n}\n')
  await writeFile(join(root, 'src', 'demo.noqeri'), 'export function demoOk(): int { return 7 }\n')
  const packed = await packPackage(root)
  const raw = await readFile(packed.archive)
  const unpacked = decodeArchive(raw, packed.integrity)
  assert.equal(unpacked.entry, 'src/demo.noqeri')
  assert.ok(unpacked.files.some(f => f.name === 'package.noqeri'))
})

test('main delegates SDK commands to system noqeri binary', async () => {
  const invoked = []
  const code = await main(['check', 'src/cli.noqeri'], console, (bin, args) => {
    invoked.push({ bin, args })
    return { status: 0 }
  })
  assert.equal(code, 0)
  assert.equal(invoked[0].args[0], 'check')
  assert.equal(invoked[0].args[1], 'src/cli.noqeri')
})
