import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPackageManager } from './package-manager-v1.mjs'

const base = () => {
  const value = process.env.NOQERI_REGISTRY_API_URL
  if (!value) throw new Error('NOQERI_REGISTRY_API_URL is required')
  return value.replace(/\/$/, '')
}
const usage = () => `noqeri <command> [arguments]

  search <query>       Search the public registry
  add <namespace/name> Resolve and install a package into the current project
  install               Install declared project dependencies and write noqeri.lock
  publish ...           Upload an .ndl archive to the private registry
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
  const payload = {
    namespace: options.namespace, name: options.name, version: options.version,
    entry: options.entry, description: options.description || '',
    repository_url: options.repositoryUrl || undefined,
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
  if (command === 'add') {
    if (!rest[0]) throw new Error('add requires namespace/name[@version]')
    const manager = createPackageManager()
    await manager.addPackage(rest[0])
    return 0
  }
  if (command === 'install') { await createPackageManager().installProject(); return 0 }
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
