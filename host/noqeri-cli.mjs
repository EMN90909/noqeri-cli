import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, resolve, dirname } from 'node:path'
import { createPackageManager } from './package-manager-v1.mjs'
import { apiBase, sha256Archive } from './registry-client.mjs'

const base = () => apiBase()
const usage = () => `noqeri <command> [arguments]

  search <query>       Search the public or Supabase private registry
  add <namespace/name> Resolve and install package + transitive deps
  install              Install declared project dependencies and write noqeri.lock
  resolve              Verify transitive DAG and print pinned noqeri.lock summary
  pack [dir] [--out f] Pack a verified deterministic gzip+ustar .ndl archive
  publish ...          Upload an .ndl archive to the private registry
  check|run|build|build-exe|test|pkg|doctor|manifest|lock|audit|format|new|lsp
                       Delegate directly to the system Noqeri compiler CLI
`

const SYSTEM_COMMANDS = new Set([
  'new', 'lex', 'check', 'nir', 'run', 'build', 'build-exe', 'emit-c',
  'nqri', 'bootstrap-seed', 'web', 'ai', 'shader', 'db', 'sql', 'stress',
  'assemble', 'link', 'targets', 'format', 'manifest', 'lock', 'audit',
  'test', 'doctor', 'release-check', 'lsp', 'pkg', '--version', 'version'
])

export function resolveNoqeriBinary() {
  return process.env.NOQERI_BIN || 'noqeri'
}

export function runSystemNoqeri(argv, runner = spawnSync) {
  const bin = resolveNoqeriBinary()
  const mapped = argv[0] === 'version' ? ['--version', ...argv.slice(1)] : argv
  const res = runner(bin, mapped, { stdio: 'inherit' })
  if (res.error) throw new Error(`failed to invoke ${bin}: ${res.error.message}`)
  return res.status ?? 1
}

function tarOctal(value, width) {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0')
}
function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  Buffer.from(name).copy(h, 0)
  tarOctal(0o644, 8).copy(h, 100)
  tarOctal(0, 8).copy(h, 108)
  tarOctal(0, 8).copy(h, 116)
  tarOctal(size, 12).copy(h, 124)
  tarOctal(0, 12).copy(h, 136)
  h.fill(32, 148, 156)
  h[156] = 48
  Buffer.from('ustar\0').copy(h, 257)
  Buffer.from('00').copy(h, 263)
  Buffer.from('noqeri').copy(h, 265)
  Buffer.from('noqeri').copy(h, 297)
  const sum = h.reduce((acc, b) => acc + b, 0)
  tarOctal(sum, 8).copy(h, 148)
  return h
}
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function gzipStored(bytes) {
  const out = [0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]
  for (let offset = 0; offset < bytes.length;) {
    const length = Math.min(65535, bytes.length - offset)
    const fin = offset + length === bytes.length
    out.push(fin ? 1 : 0, length & 0xff, length >>> 8, (~length) & 0xff, (~length >>> 8) & 0xff)
    out.push(...bytes.subarray(offset, offset + length))
    offset += length
  }
  const c = crc32(bytes), sz = bytes.length >>> 0
  for (let s = 0; s < 32; s += 8) out.push((c >>> s) & 0xff)
  for (let s = 0; s < 32; s += 8) out.push((sz >>> s) & 0xff)
  return Buffer.from(out)
}
async function collectPackFiles(dir, baseDir = dir, result = []) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'nodules' || entry.name === 'dist' || entry.name === 'node_modules') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) await collectPackFiles(abs, baseDir, result)
    else if ((await stat(abs)).isFile()) {
      const rel = relative(baseDir, abs).split('\\').join('/')
      if (Buffer.byteLength(rel) > 100) continue
      result.push({ name: rel, bytes: await readFile(abs) })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export async function packPackage(dir = process.cwd(), outPath = '') {
  const root = resolve(dir)
  const manifestRaw = await readFile(join(root, 'package.noqeri'), 'utf8')
  const name = manifestRaw.match(/\bname\s*:\s*"([^"]+)"/)?.[1] || ''
  const version = manifestRaw.match(/\bversion\s*:\s*"([^"]+)"/)?.[1] || ''
  const entry = manifestRaw.match(/\bentry\s*:\s*"([^"]+)"/)?.[1] || ''
  if (!name || !version || !entry) throw new Error('package.noqeri must declare name, version, and entry')
  const files = await collectPackFiles(root)
  const tarParts = []
  for (const f of files) {
    tarParts.push(tarHeader(f.name, f.bytes.length), f.bytes, Buffer.alloc((512 - (f.bytes.length % 512)) % 512))
  }
  tarParts.push(Buffer.alloc(1024))
  const ndl = gzipStored(Buffer.concat(tarParts))
  const shortName = name.split('/')[1] || name
  const dest = resolve(outPath || join(root, 'dist', `noqeri-${shortName}-${version}.ndl`))
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, ndl)
  const integrity = sha256Archive(ndl)
  return { name, version, entry, archive: dest, bytes: ndl.byteLength, integrity }
}

export async function search(query, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(base() + '/v1/search?q=' + encodeURIComponent(query || ''), { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`registry search failed: ${response.status}`)
  return response.json()
}

export async function publish(options, fetchImpl = globalThis.fetch) {
  const token = options.token || process.env.NOQERI_REGISTRY_TOKEN || process.env.NOQERI_PUBLISH_TOKEN
  const privateUrl = (options.privateUrl || process.env.NOQERI_PRIVATE_REGISTRY_URL || '').replace(/\/$/, '')
  if (!token || !privateUrl) throw new Error('NOQERI_PUBLISH_TOKEN and NOQERI_PRIVATE_REGISTRY_URL are required')
  const bytes = await readFile(resolve(options.archive))
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  const payload = {
    namespace: options.namespace, name: options.name, version: options.version,
    entry: options.entry, description: options.description || '',
    repository_url: options.repositoryUrl || undefined,
    archive_sha256: archiveSha256,
    archive_base64: bytes.toString('base64')
  }
  const response = await fetchImpl(privateUrl + '/v1/publish', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `publish failed: ${response.status}`)
  return body
}

export async function main(argv = process.argv.slice(2), io = console, systemRunner = spawnSync) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') { io.log(usage()); return 0 }
  if (SYSTEM_COMMANDS.has(command)) { return runSystemNoqeri(argv, systemRunner) }
  if (command === 'search') { io.log(JSON.stringify(await search(rest.join(' ')))); return 0 }
  if (command === 'pack') {
    let dir = process.cwd(), out = ''
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--out' && rest[i + 1]) out = rest[++i]
      else if (!rest[i].startsWith('--')) dir = rest[i]
    }
    io.log(JSON.stringify(await packPackage(dir, out)))
    return 0
  }
  if (command === 'add') {
    if (!rest[0]) throw new Error('add requires namespace/name[@version]')
    const manager = createPackageManager()
    await manager.addPackage(rest[0])
    return 0
  }
  if (command === 'install' || command === 'resolve') {
    const installed = await createPackageManager().installProject()
    if (command === 'resolve') io.log(JSON.stringify(installed.map(x => ({ coordinate: x.coordinate, version: x.version, integrity: x.integrity, path: x.path }))))
    return 0
  }
  if (command === 'publish') {
    const options = Object.create(null)
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (!key || !rest[i + 1]) throw new Error('publish options require values')
      options[key] = rest[++i]
    }
    if (!options.archive || !options.namespace || !options.name || !options.version || !options.entry) throw new Error('publish requires --archive --namespace --name --version --entry')
    io.log(JSON.stringify(await publish(options)))
    return 0
  }
  throw new Error('unknown command: ' + command)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => { if (typeof code === 'number' && code !== 0) process.exitCode = code })
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
