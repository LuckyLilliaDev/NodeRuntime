#!/usr/bin/env node
/**
 * 给每个平台的 npm 包配置 Trusted Publishing (绑定本仓库的 release.yml), 之后 CI 不用 npm token 就能发布.
 *
 * npm 只能给已存在的包配 trusted publisher, 所以第一次要在本机分三步:
 *   1. 把还不存在的包一口气各发一个只有 package.json 的占位版本 0.0.0;
 *   2. 一起等 npm 处理完 (刚发布的包要几分钟才能查到);
 *   3. 逐个 npm trust github <包> --file release.yml --repo <仓库> --allow-publish.
 * 真正的 Node.js 版本全部由 GitHub Actions 发布 (带 provenance), 发布后会成为 latest.
 * 已发布 / 已绑定的包记在 .cache/bootstrap-npm-state.json, 重跑时跳过, 不会重复过 2FA.
 *
 * 用法 (需要先 npm login, 账号要能发布 runtime.json 里的 scope; 过程中 npm 可能要求 2FA 验证):
 *   node scripts/bootstrap-npm.mjs              执行
 *   node scripts/bootstrap-npm.mjs --dry-run    只打印要做什么
 *   node scripts/bootstrap-npm.mjs --repo owner/name   仓库不是 LuckyLilliaDev/NodeRuntime 时
 *   node scripts/bootstrap-npm.mjs --otp 123456       开了 2FA 又不在交互终端里时 (交互终端里 npm 会自己弹浏览器验证)
 *
 * 所有 npm 命令都带 --registry=https://registry.npmjs.org/, 不受本机默认镜像源影响.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS, packageName } from './targets.mjs'

const WORKFLOW_FILE = 'release.yml'
// 本机默认 registry 可能是镜像 (npmmirror 等), 发布 / 绑定必须走官方源, 每条 npm 命令都显式带上
const REGISTRY = 'https://registry.npmjs.org/'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { scope } = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'))

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const repoIndex = args.indexOf('--repo')
const repo = repoIndex >= 0 ? args[repoIndex + 1] : 'LuckyLilliaDev/NodeRuntime'
// 账号开了 2FA 且在非交互终端里运行时用: --otp <6 位验证码>. 验证码 30 秒左右过期, 中途过期就换新码重跑, 已完成的步骤会跳过
const otpIndex = args.indexOf('--otp')
const otp = otpIndex >= 0 ? args[otpIndex + 1] : undefined
if (otpIndex >= 0 && !/^\d{6,8}$/.test(otp ?? '')) {
  console.error('error: --otp 后面要跟验证器里的数字验证码')
  process.exit(1)
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
  console.error(`error: --repo 格式应为 owner/name, 收到 ${repo}`)
  process.exit(1)
}

// Windows 上 npm 是 npm.cmd, 要经过 shell; 参数自己加引号
function npm(npmArgs, { capture = false, cwd } = {}) {
  const shell = process.platform === 'win32'
  const allArgs = [...npmArgs, `--registry=${REGISTRY}`]
  const finalArgs = shell ? allArgs.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)) : allArgs
  const result = spawnSync('npm', finalArgs, {
    cwd,
    shell,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function run(description, npmArgs, { allowFail = false, ...options } = {}) {
  console.log(`  ${dryRun ? '[dry-run] ' : ''}${description}: npm ${npmArgs.join(' ')} --registry=${REGISTRY}`)
  if (dryRun) return true
  const ok = npm(otp ? [...npmArgs, `--otp=${otp}`] : npmArgs, options).ok
  if (!ok && !allowFail) {
    console.error(`error: ${description}失败, 修好后重新运行本脚本即可 (已完成的步骤会跳过)`)
    process.exit(1)
  }
  return ok
}

// --prefer-online: 不用本机缓存的元数据, 否则刚发布的包会一直显示不存在
const isVisible = (name) => npm(['view', name, 'name', '--prefer-online'], { capture: true }).ok

// 刚发布的包要过几分钟才能被查到, 在这之前 npm trust 会 404. 所有包一起等, 只等一轮
function waitAllVisible(names, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  let remaining = [...names]
  console.log(`\n等待 npm 处理刚发布的 ${remaining.length} 个包 (通常几分钟, 每 15 秒查一次)`)
  while (Date.now() < deadline) {
    remaining = remaining.filter((name) => {
      if (!isVisible(name)) return true
      console.log(`  ${name} 可以了`)
      return false
    })
    if (!remaining.length) return []
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000)
  }
  return remaining
}

const whoami = npm(['whoami'], { capture: true })
if (!whoami.ok) {
  console.error('error: 没有登录 npm, 先运行 npm login')
  process.exit(1)
}
console.log(`npm 账号: ${whoami.stdout.trim()} (${REGISTRY}); 绑定仓库: ${repo}, workflow: ${WORKFLOW_FILE}${dryRun ? ' (dry-run)' : ''}`)

// 本机记下已发布 / 已绑定的包: 刚发布的包查不到, 绑定状态也查不了 (npm trust list 要 2FA),
// 不记的话重跑会重复发布、重复绑定, 每次都多过一遍 2FA
const stateFile = path.join(root, '.cache', 'bootstrap-npm-state.json')
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
const key = (name) => `${repo}:${WORKFLOW_FILE}:${name}`
state.published ??= []
state.trusted ??= []
function save() {
  if (dryRun) return
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

const names = TARGETS.map((t) => packageName(scope, t)).filter((name) => {
  if (!state.trusted.includes(key(name))) return true
  console.log(`${name}: 本机记录已绑定, 跳过`)
  return false
})

// 1. 一口气发完所有缺的占位版本
console.log('\n1/3 发布占位版本 0.0.0')
const pending = []
for (const name of names) {
  if (isVisible(name)) {
    console.log(`${name}: 已存在`)
    continue
  }
  pending.push(name)
  if (state.published.includes(name)) {
    console.log(`${name}: 本机已发布过, 等 npm 处理`)
    continue
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-bootstrap-'))
  const manifest = {
    name,
    version: '0.0.0',
    description: `Placeholder for trusted publishing setup. Real Node.js builds are published from https://github.com/${repo}`,
    license: 'MIT',
    repository: { type: 'git', url: `git+https://github.com/${repo}.git` },
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(name)
  // 失败也继续等: 可能以前已经发出去了只是还查不到 (这次会报不能覆盖已发布版本); 真没发出去的会等到超时
  if (run('发布', ['publish', '--access', 'public'], { cwd: dir, allowFail: true })) {
    state.published.push(name)
    save()
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

// 2. 一起等
console.log('\n2/3 等待 npm 处理')
if (!pending.length) console.log('  没有需要等的包')
else if (!dryRun) {
  const missing = waitAllVisible(pending)
  if (missing.length) {
    console.error(`error: 这些包一直查不到, 过几分钟重新运行本脚本即可 (已完成的步骤会跳过):\n${missing.map((n) => `  ${n}`).join('\n')}`)
    process.exit(1)
  }
}

// 3. 统一绑定
console.log('\n3/3 绑定 GitHub Actions')
const trustFailures = []
for (const name of names) {
  console.log(name)
  if (run('绑定', ['trust', 'github', name, '--file', WORKFLOW_FILE, '--repo', repo, '--allow-publish', '--yes'], { allowFail: true })) {
    state.trusted.push(key(name))
    save()
  } else {
    trustFailures.push(name)
  }
}

if (trustFailures.length) {
  console.error(`\n以下包绑定失败 (如果上面的报错是已经绑定过, 可以忽略):\n${trustFailures.map((n) => `  ${n}`).join('\n')}`)
  process.exit(1)
}
console.log(`\n完成. 之后推 tag (v<runtime.json 的 packageVersion>) 由 GitHub Actions 发布`)
