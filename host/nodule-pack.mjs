// Deterministic Noqeri Nodule (.ndl) packer. An .ndl is a gzip-compressed
// ustar archive; nodules.toml is its package header and package.noqeri remains
// the compiler's source manifest.
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { VERSION } from './registry-client.mjs'

const OMIT = new Set(['.git', 'node_modules', 'dist', 'target', '.noqeri', '.next', 'coverage'])
const MAX_FILES = 256
const MAX_BYTES = 8 *  1024 * 1024
const NAME = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.DS_Store|credentials(?:\..*)?|service-account(?:\..*)?)$/i
const SENSITIVE_SUFFIX = /\.(?:pem|key|p12|pfx|keystore|sqlite|db)$/i

function parseToml(source) {
  const result = Object.create(null)
  let section = result
  for (const [offset, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[([a-zA-Z0-9_-]+)\]$/.exec(line)
    if (header) { section = result[header[1]] ||= Object.create(null); continue }
    const item = /^([a-zA-Z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line)
    if (!item) throw new Error(`nodules.toml:${offset + 1}: expected key = value`)
    const [, key, rawValue] = item
    let value
    if (/^"(?:[^"\\]|\\.)*"$/.test(rawValue)) value = JSON.parse(rawValue)
    else if (/^(true|false)$/.test(rawValue)) value = rawValue === 'true'
    else if (/^\[[\s\S]*\]$/.test(rawValue)) {
      const inner = rawValue.slice(1, -1).trim()
      value = inner ? inner.split(',').map(part => {
        const v = part.trim()
        if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) throw new Error(`nodules.toml:${offset + 1}: arrays must contain strings`)
        return JSON.parse(v)
      }) : []
    } else throw new Error(`nodules.toml:${offset + 1}: unsupported value`)
    if (Object.hasOwn(section, key)) throw new Error(`nodules.toml:${offset + 1}: duplicate key ${key}`)
    section[key] = value
  }
  return result
}

function validateHeader(header) {
  const pkg = header.nodule || header.package
  if (!pkg || typeof pkg !== 'object') throw new Error('nodules.toml must define [nodule]')
  if (pkg.format !== 'ndl-1') throw new Error('nodules.toml format must be ndl-1')
  if (typeof pkg.name !== 'string' || !NAME.test(pkg.name)) throw new Error('nodule name must be namespace/name using lowercase letters, digits, and hyphens')
  if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) throw new Error('nodule version must be semantic versioning')
  if (typeof pkg.entry !== 'string' || !pkg.entry.endsWith('.noqeri') || pkg.entry.startsWith('/') || pkg.entry.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('nodule entry must be a safe relative .noqeri path')
  for (const field of ['kind', 'target', 'license']) if (typeof pkg[field] !== 'string' || !pkg[field].trim()) throw new Error(`nodules.toml is missing ${field}`)
  return pkg
}

function globMatch(path, pattern) {
  let expression = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?' } else expression += '.*'
    } else if (c === '*') expression += '[^/]*'
    else if (c === '?') expression += '[^/]'
    else expression += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(expression + '$').test(path)
}

async function listFiles(root, dir = root, out = [], total = { bytes: 0 }, includes = undefined) {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (OMIT.has(item.name)) continue
    if (SENSITIVE_FILE.test(item.name) || SENSITIVE_SUFFIX.test(item.name)) continue
    const absolute = join(dir, item.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed in nodules: ${relative(root, absolute)}`)
    if (info.isDirectory()) { await listFiles(root, absolute, out, total, includes); continue }
    if (!info.isFile()) continue
    const name = relative(root, absolute).split(sep).join('/')
    if (name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || Buffer.byteLength(name) > 100) throw new Error(`unsafe or too-long package path: ${name}`)
    if (includes && !includes.some(pattern => globMatch(name, pattern)) && !['nodules.toml', 'package.noqeri'].includes(name)) continue
    const bytes = new Uint8Array(await readFile(absolute))
    if (out.length >= MAX_FILES || total.bytes + bytes.length > MAX_BYTES) throw new Error('nodule exceeds package file or size limit')
    total.bytes += bytes.length
    out.push({ name, bytes, mode: info.mode & 0o111 ? 0o755 : 0o644 })
  }
  return out
}

function octal(buffer, offset, length, value) {
  const text = Math.trunc(value).toString(8).padStart(length - 1, '0') + '\0'
  buffer.write(text, offset, length, 'ascii')
}

function tar(files) {
  const chunks = []
  for (const file of [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const h = Buffer.alloc(512)
    h.write(file.name, 0, 100, 'utf8')
    octal(h, 100, 8, file.mode || 0o644); octal(h, 108, 8, 0); octal(h, 116, 8, 0)
    octal(h, 124, 12, file.bytes.length); octal(h, 136, 12, 0)
    h.fill(32, 148, 156); h[156] = 48
    h.write('ustar\0', 257, 6, 'ascii'); h.write('00', 263, 2, 'ascii')
    const checksum = h.reduce((sum, byte) => sum + byte, 0)
    h.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    chunks.push(h, Buffer.from(file.bytes))
    const padding = (512 - file.bytes.length % 512) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function packageManifestMatches(source, pkg) {
  const name = source.match(/\bname\s*:\s*"([^"]+)"/)?.[1]
  const version = source.match(/\bversion\s*:\s*"([^"]+)"/)?.[1]
  const entry = source.match(/\bentry\s*:\s*"([^"]+)"/)?.[1]
  if (name !== pkg.name || version !== pkg.version || entry !== pkg.entry) throw new Error('nodules.toml name, version, and entry must match package.noqeri')
}

export async function packNodule(options = {}) {
  const root = resolve(options.directory || process.cwd())
  const headerPath = join(root, 'nodules.toml')
  const compilerManifestPath = join(root, 'package.noqeri')
  const headerBytes = await readFile(headerPath)
  const compilerBytes = await readFile(compilerManifestPath)
  const pkg = validateHeader(parseToml(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)))
  const header = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes))
  packageManifestMatches(new TextDecoder('utf-8', { fatal: true }).decode(compilerBytes), pkg)
  const includes = header.files?.include
  if (includes !== undefined && (!Array.isArray(includes) || includes.some(pattern => typeof pattern !== 'string'))) throw new Error('[files].include must be an array of glob strings')
  const selection = includes ? [...includes, pkg.entry] : undefined
  const files = await listFiles(root, root, [], { bytes: 0 }, selection)
  if (!files.some(f => f.name === 'nodules.toml') || !files.some(f => f.name === 'package.noqeri') || !files.some(f => f.name === pkg.entry)) throw new Error('nodule requires nodules.toml, package.noqeri, and its declared entry source')
  const format = options.format || 'ndl'
  if (!['ndl', 'tar.gz', 'raw-tar'].includes(format)) throw new Error('format must be ndl, tar.gz, or raw-tar')
  if (format === 'raw-tar' && !options.allowRawTar) throw new Error('raw tar is for debugging; pass --raw-tar explicitly')
  const tarBytes = tar(files)
  const bytes = format === 'raw-tar' ? tarBytes : gzipSync(tarBytes, { level: 9, mtime: 0 })
  const extension = format === 'ndl' ? '.ndl' : format === 'tar.gz' ? '.tar.gz' : '.tar'
  const output = resolve(options.output || join(root, 'dist', `${pkg.name.split('/').join('-')}-${pkg.version}${extension}`))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, bytes, { mode: 0o644 })
  const digest = createHash('sha256').update(bytes).digest('hex')
  return { output, bytes: bytes.length, files: files.length, digest: `sha256:${digest}`, name: pkg.name, version: pkg.version, format }
}

export async function readNoduleHeader(directory = process.cwd()) {
  const root = resolve(directory)
  const header = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, 'nodules.toml'))))
  const pkg = validateHeader(header)
  const compiler = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, 'package.noqeri')))
  packageManifestMatches(compiler, pkg)
  return { ...pkg, description: typeof pkg.description === 'string' ? pkg.description : '', repository: typeof pkg.repository === 'string' ? pkg.repository : '' }
}

export function noduleHeaderFromPackageManifest(source, description = '') {
  const get = key => source.match(new RegExp(`\\b${key}\\s*:\\s*"([^"]+)"`))?.[1]
  const name = get('name'), version = get('version'), entry = get('entry'), target = get('target') || 'portable', license = get('license') || 'UNLICENSED', kind = get('profile') || 'library'
  if (!name || !version || !entry) throw new Error('package.noqeri must declare name, version, and entry')
  const q = value => JSON.stringify(value)
  return `[nodule]\nformat = "ndl-1"\nname = ${q(name)}\nversion = ${q(version)}\nentry = ${q(entry)}\nkind = ${q(kind)}\ntarget = ${q(target)}\nlicense = ${q(license)}\ndescription = ${q(description)}\n`
}
