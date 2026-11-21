import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPackageManager } from './package-manager-v1.mjs'
import { packNodule, readNoduleHeader } from './nodule-pack.mjs'
import { decodeArchive, sha256Archive } from './registry-client.mjs'

const base = () => {
  const value = process.env.NOQERI_REGISTRY_API_URL
  if (!value) throw new Error('NOQERI_REGISTRY_API_URL is required')
  return value.replace(/\/$/, '')
}
const usage = () => `noqeri <pack|build|search|add|install|publish> [arguments]

  pack [directory]       Build a deterministic .ndl package from nodules.toml
  build [directory]      Alias for pack; writes .ndl unless a format is requested
    --output PATH         Output path (defaults to dist/<name>-<version>.ndl)
    --format tar.gz       Write a gzip tar archive for debugging
    --raw-tar             Write an uncompressed tar archive for debugging
  search <query>       Search the public registry
  add <namespace/name> Resolve and install a package into the current project
  install               Install declared project dependencies and write noqeri.lock
  publish ...           Upload an .ndl archive to the private registry
`

export async function search(query, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(base() + '/v1/search?q=' + encodeURIComponent(query || ''), { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`registry search failed: ${response.status}`)
  return response.json()
}
export async function publish(options, fetchImpl = globalThis.fetch) {
  const token = options.token || process.env.NOQERI_REGISTRY_TOKEN || process.env.NOQERI_PUBLISH_TOKEN
  const privateUrl = (options.privateUrl || process.env.NOQERI_PRIVATE_REGISTRY_URL || '').replace(/\/$/, '')
  if (!token || !privateUrl) throw new Error('NOQERI_PUBLISH_TOKEN and NOQERI_PRIVATE_REGISTRY_URL are required')
  const endpoint = new URL(privateUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('private Registry requires HTTPS or localhost development')
  const directory = resolve(options.directory || process.cwd())
  const header = await readNoduleHeader(directory)
  let archive = options.archive
  if (!archive) archive = (await packNodule({ directory })).output
  archive = resolve(archive)
  if (!archive.endsWith('.ndl')) throw new Error('publish accepts .ndl files; raw archives are for debugging only')
  const bytes = await readFile(archive)
  const archiveSha256 = sha256Archive(bytes).slice('sha256:'.length)
  const unpacked = decodeArchive(bytes, 'sha256:' + archiveSha256)
  const [headerNamespace, headerName] = header.name.split('/')
  const namespace = options.namespace || headerNamespace
  const name = options.name || headerName
  const version = options.version || header.version
  const entry = options.entry || header.entry
  if (namespace !== headerNamespace || name !== headerName || version !== header.version || entry !== header.entry || unpacked.entry !== header.entry) throw new Error('publish metadata must match nodules.toml and the packaged archive')
  const payload = {
    namespace, name, version, entry,
    description: options.description || header.description,
    repository_url: options.repositoryUrl || header.repository || undefined,
    archive_sha256: archiveSha256,
    manifest: { format: 'ndl-1', ...header },
    archive_base64: bytes.toString('base64')
  }
  const response = await fetchImpl(privateUrl + '/v1/publish', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `publish failed: ${response.status}`)
  return body
}
export async function main(argv = process.argv.slice(2), io = console) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') { io.log(usage()); return 0 }
  if (command === 'pack' || command === 'build') {
    const options = { directory: process.cwd() }
    let directorySet = false
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]
      if (arg === '--raw-tar') { options.format = 'raw-tar'; options.allowRawTar = true; continue }
      if (arg.startsWith('--')) {
        const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        const value = rest[++i]
        if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
        if (!['output', 'format', 'directory'].includes(key)) throw new Error(`unknown pack option: ${arg}`)
        options[key] = value
        if (key === 'directory') directorySet = true
        if (key === 'format' && value === 'raw-tar') options.allowRawTar = true
        continue
      }
      if (directorySet) throw new Error('pack accepts only one package directory')
      options.directory = arg
      directorySet = true
    }
    const result = await packNodule(options)
    io.log(`packed ${result.name}@${result.version} -> ${result.output} (${result.files} files, ${result.bytes} bytes, ${result.digest})`)
    return result
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}

