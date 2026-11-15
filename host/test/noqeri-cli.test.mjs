import test from 'node:test'
import assert from 'node:assert/strict'
import { search, publish } from '../noqeri-cli.mjs'
import { mkdtemp, writeFile } from 'node:fs/promises'
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

test('publish sends an .ndl archive with bearer auth', async () => {
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
  assert.match(JSON.parse(request.options.body).archive_base64, /^[A-Za-z0-9+/=]+$/)
})

