import test from 'node:test'
import assert from 'node:assert/strict'
import { search, publish, main } from '../noqeri-cli.mjs'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packNodule } from '../nodule-pack.mjs'
import { decodeArchive, sha256Archive } from '../registry-client.mjs'

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

test('publish sends an .ndl archive with bearer auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noqeri-cli-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.noqeri'), 'package { name: "noqeri/sample" version: "1.2.3" entry: "src/sample.noqeri" profile: "library" target: "portable" license: "Apache-2.0" }\n')
  await writeFile(join(root, 'nodules.toml'), '[nodule]\nformat = "ndl-1"\nname = "noqeri/sample"\nversion = "1.2.3"\nentry = "src/sample.noqeri"\nkind = "library"\ntarget = "portable"\nlicense = "Apache-2.0"\n')
  await writeFile(join(root, 'src/sample.noqeri'), 'export function sample(): i32 { return 7 }\n')
  await writeFile(join(root, '.env'), 'NOQERI_PUBLISH_TOKEN=must-not-be-packaged\n')
  const archive = (await packNodule({ directory: root })).output
  let request
  const result = await publish({ privateUrl: 'https://private.test', token: 'nq_test_token', archive, directory: root }, async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ state: 'submitted' }), { status: 201 })
  })
  assert.equal(result.state, 'submitted')
  assert.equal(request.url, 'https://private.test/v1/publish')
  assert.equal(request.options.headers.authorization, 'Bearer nq_test_token')
  const body = JSON.parse(request.options.body)
  assert.match(body.archive_base64, /^[A-Za-z0-9+/=]+$/)
  assert.equal(body.namespace, 'noqeri')
  assert.equal(body.name, 'sample')
  assert.equal(body.manifest.format, 'ndl-1')
  assert.match(body.archive_sha256, /^[0-9a-f]{64}$/)
})

test('pack and build emit a deterministic .ndl with its nodules.toml header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noqeri-nodule-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.noqeri'), 'package {\n    name: "noqeri/sample"\n    version: "1.2.3"\n    entry: "src/sample.noqeri"\n    profile: "library"\n    target: "portable"\n    license: "Apache-2.0"\n}\n')
  await writeFile(join(root, 'nodules.toml'), '[nodule]\nformat = "ndl-1"\nname = "noqeri/sample"\nversion = "1.2.3"\nentry = "src/sample.noqeri"\nkind = "library"\ntarget = "portable"\nlicense = "Apache-2.0"\n')
  await writeFile(join(root, 'src/sample.noqeri'), 'export function sample(): i32 { return 7 }\n')
  const a = await packNodule({ directory: root })
  const bytesA = await readFile(a.output)
  const b = await packNodule({ directory: root, output: join(root, 'second.ndl') })
  const bytesB = await readFile(b.output)
  assert.equal(a.format, 'ndl')
  assert.match(a.output, /noqeri-sample-1\.2\.3\.ndl$/)
  assert.equal(sha256Archive(bytesA), sha256Archive(bytesB))
  const decoded = decodeArchive(bytesA, sha256Archive(bytesA))
  assert.ok(decoded.files.some(file => file.name === 'nodules.toml'))
  assert.ok(!decoded.files.some(file => file.name === '.env'))
  assert.equal(decoded.entry, 'src/sample.noqeri')
})

test('pack rejects a header that disagrees with package.noqeri', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noqeri-nodule-invalid-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.noqeri'), 'package { name: "noqeri/sample" version: "1.2.3" entry: "src/sample.noqeri" }\n')
  await writeFile(join(root, 'nodules.toml'), '[nodule]\nformat = "ndl-1"\nname = "noqeri/sample"\nversion = "9.9.9"\nentry = "src/sample.noqeri"\nkind = "library"\ntarget = "portable"\nlicense = "Apache-2.0"\n')
  await writeFile(join(root, 'src/sample.noqeri'), 'export function sample(): i32 { return 7 }\n')
  await assert.rejects(packNodule({ directory: root }), /must match package\.noqeri/)
})

test('CLI build command writes the default .ndl path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noqeri-cli-build-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.noqeri'), 'package { name: "noqeri/sample" version: "1.2.3" entry: "src/sample.noqeri" profile: "library" target: "portable" license: "Apache-2.0" }\n')
  await writeFile(join(root, 'nodules.toml'), '[nodule]\nformat = "ndl-1"\nname = "noqeri/sample"\nversion = "1.2.3"\nentry = "src/sample.noqeri"\nkind = "library"\ntarget = "portable"\nlicense = "Apache-2.0"\n')
  await writeFile(join(root, 'src/sample.noqeri'), 'export function sample(): i32 { return 7 }\n')
  const output = []
  await main(['build', root], { log: message => output.push(message) })
  assert.ok(output[0].endsWith('.ndl)') || output[0].includes('.ndl '))
})

