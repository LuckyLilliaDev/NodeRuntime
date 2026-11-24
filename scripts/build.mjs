#!/usr/bin/env node
/**
 * 把 nodejs.org 的官方 Node.js 重新打成 npm 包: <scope>/node-<平台>, 给 LuckyLillia 桌面端下载用.
 *
 * 每个平台: 下载官方压缩包 -> 校验 (SHASUMS256.txt 的 GPG 签名 + 压缩包 sha256)
 *   -> 只取 node 可执行文件和 LICENSE -> 写 package.json -> tar 成 dist/*.tgz.
 * 包内容: package/{package.json, node 或 node.exe, LICENSE-node.txt}. 桌面端把 package/ 下除 package.json
 * 以外的文件解压到 bin/llbot (和 LLBot 同目录), 所以 LICENSE 改名, 免得和 LLBot 自己的 LICENSE 冲突.
 *
 * 版本 (runtime.json):
 *   nodeVersion     官方 Node.js 版本
 *   packageVersion  npm 包版本, 一般等于 nodeVersion; 同一个 Node 版本要重新打包时用 "<nodeVersion>-1" 这类后缀
 *                   (npm 上发布过的版本不能覆盖). git tag 必须是 "v<packageVersion>".
 *
 * 用法:
 *   node scripts/build.mjs                  全部平台, 需要 NODE_RELEASE_KEYRING
 *   node scripts/build.mjs --only win-x64   只打部分平台, 逗号分隔
 *   node scripts/build.mjs --skip-gpg       本地调试: 不验 GPG 签名, 只验 sha256 (CI 里不允许)
 *
 * 环境变量:
 *   NODE_RELEASE_KEYRING  https://github.com/nodejs/release-keys 里的 gpg/pubring.kbx, 用 gpgv 验 SHASUMS256.txt.sig
 *   NODE_DIST_MIRROR      下载源, 默认 https://nodejs.org/dist (有签名校验, 换镜像不影响可信度)
 *   GITHUB_REPOSITORY     写进 package.json 的 repository; npm provenance 要求它和发布所在的仓库一致
 *
 * Unix 平台的可执行位靠 tar 保留, 正式发布的包要在 Linux / macOS 上打 (CI 用 ubuntu).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { TARGETS, packageName } from './targets.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { nodeVersion, packageVersion, scope } = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'))

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const skipGpg = args.includes('--skip-gpg')
const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean)

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) fail(`runtime.json nodeVersion 格式不对: ${nodeVersion}`)
if (packageVersion !== nodeVersion && !packageVersion.startsWith(`${nodeVersion}-`)) {
  fail(`runtime.json packageVersion (${packageVersion}) 必须是 ${nodeVersion} 或 ${nodeVersion}-<n>`)
}
if (!/^@[a-z0-9-]+$/.test(scope)) fail(`runtime.json scope 格式不对: ${scope}`)
if (skipGpg && process.env.CI) fail('CI 里不允许 --skip-gpg')
const keyring = process.env.NODE_RELEASE_KEYRING
if (!skipGpg && !keyring) fail('需要 NODE_RELEASE_KEYRING (nodejs/release-keys 的 gpg/pubring.kbx); 本地调试可加 --skip-gpg')
const unknown = only?.filter((id) => !TARGETS.some((t) => t.id === id)) ?? []
if (unknown.length) fail(`未知平台: ${unknown.join(', ')}; 可选: ${TARGETS.map((t) => t.id).join(', ')}`)

const targets = only ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS
const mirror = (process.env.NODE_DIST_MIRROR ?? 'https://nodejs.org/dist').replace(/\/+$/, '')
const base = `${mirror}/v${nodeVersion}`
const repo = process.env.GITHUB_REPOSITORY ?? 'LuckyLilliaDev/NodeRuntime'
const cacheDir = path.join(root, '.cache', `v${nodeVersion}`)
const distDir = path.join(root, 'dist')

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// 已缓存就不重新下载; 内容是否可信每次都靠后面的校验, 不靠缓存
async function download(url, file) {
  if (fs.existsSync(file)) return
  console.log(`下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) fail(`下载失败 ${res.status}: ${url}`)
  const part = `${file}.part`
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part))
  fs.renameSync(part, file)
}

function extract(archive, ext, dest, members) {
  // GNU tar 不认 zip, Linux 上 zip 用 unzip; Windows / macOS 的 tar 是 bsdtar, zip 和 tar.gz 都能解
  if (ext === 'zip' && process.platform === 'linux') {
    execFileSync('unzip', ['-q', '-o', archive, ...members, '-d', dest], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xf', archive, '-C', dest, ...members], { stdio: 'inherit' })
  }
}

fs.mkdirSync(cacheDir, { recursive: true })
fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })

// SHASUMS256.txt 先验签名, 之后所有压缩包都按它验 sha256
const sumsFile = path.join(cacheDir, 'SHASUMS256.txt')
await download(`${base}/SHASUMS256.txt`, sumsFile)
if (skipGpg) {
  console.warn('warning: --skip-gpg, 没有验证 SHASUMS256.txt 的签名')
} else {
  const sigFile = path.join(cacheDir, 'SHASUMS256.txt.sig')
  await download(`${base}/SHASUMS256.txt.sig`, sigFile)
  // 需要 GnuPG 2.x: 现在的发布者有用 Ed25519 key 签名的, GnuPG 1.x (如老版 Git for Windows 自带的) 会报 unknown pubkey algorithm
  try {
    execFileSync('gpgv', ['--keyring', path.resolve(keyring), sigFile, sumsFile], { stdio: 'inherit' })
  } catch {
    fail('SHASUMS256.txt 的 GPG 签名校验失败 (见上面 gpgv 输出); 需要 GnuPG 2.x 和最新的 nodejs/release-keys')
  }
}
const sums = new Map(
  fs.readFileSync(sumsFile, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2)
    .map(([hash, name]) => [name, hash]),
)

const results = []
for (const t of targets) {
  const dirName = `node-v${nodeVersion}-${t.dist}`
  const archiveName = `${dirName}.${t.ext}`
  const expected = sums.get(archiveName)
  if (!expected) fail(`SHASUMS256.txt 里没有 ${archiveName}`)

  const archive = path.join(cacheDir, archiveName)
  await download(`${base}/${archiveName}`, archive)
  const actual = sha256(archive)
  if (actual !== expected) {
    fs.rmSync(archive, { force: true })
    fail(`${archiveName} sha256 不匹配: 期望 ${expected}, 实际 ${actual} (已删除缓存)`)
  }

  const work = path.join(distDir, t.id)
  const extractDir = path.join(work, 'extract')
  const pkgDir = path.join(work, 'package')
  fs.mkdirSync(extractDir, { recursive: true })
  fs.mkdirSync(pkgDir, { recursive: true })

  const binMember = t.os === 'win32' ? `${dirName}/${t.bin}` : `${dirName}/bin/${t.bin}`
  const licenseMember = `${dirName}/LICENSE`
  extract(archive, t.ext, extractDir, [binMember, licenseMember])

  const binFile = path.join(pkgDir, t.bin)
  fs.copyFileSync(path.join(extractDir, binMember), binFile)
  if (t.os !== 'win32') fs.chmodSync(binFile, 0o755)
  fs.copyFileSync(path.join(extractDir, licenseMember), path.join(pkgDir, 'LICENSE-node.txt'))

  const name = packageName(scope, t)
  const manifest = {
    name,
    version: packageVersion,
    description: `Official Node.js v${nodeVersion} binary (${t.dist}), repackaged for LuckyLillia`,
    license: 'MIT',
    os: [t.os],
    cpu: [t.cpu],
    repository: { type: 'git', url: `git+https://github.com/${repo}.git` },
    homepage: `https://nodejs.org/dist/v${nodeVersion}/`,
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const tgz = path.join(distDir, `${scope.slice(1)}-node-${t.id}-${packageVersion}.tgz`)
  execFileSync('tar', ['-czf', tgz, '-C', work, 'package'], { stdio: 'inherit' })
  fs.rmSync(work, { recursive: true, force: true })

  // Windows 上打包会丢掉可执行位, 装到 Linux / macOS 上 node 就跑不起来
  if (t.os !== 'win32') {
    const listing = execFileSync('tar', ['-tvzf', tgz, `package/${t.bin}`], { encoding: 'utf8' })
    if (!/^-rwx/.test(listing.trim())) {
      const message = `${path.basename(tgz)} 里的 ${t.bin} 没有可执行位, 不能发布 (要在 Linux / macOS 上打包)`
      if (process.env.CI) fail(message)
      console.warn(`warning: ${message}`)
    }
  }

  const size = fs.statSync(tgz).size
  results.push({ name, version: packageVersion, file: path.relative(root, tgz).replaceAll('\\', '/'), sha256: sha256(tgz), size })
  console.log(`${name}@${packageVersion} -> ${path.basename(tgz)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

fs.writeFileSync(path.join(distDir, 'packages.json'), `${JSON.stringify(results, null, 2)}\n`)
console.log(`完成: ${results.length} 个包, 清单在 dist/packages.json`)
