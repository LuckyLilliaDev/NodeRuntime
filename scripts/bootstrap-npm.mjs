#!/usr/bin/env node
/**
 * 给每个平台的 npm 包配置 Trusted Publishing (绑定本仓库的 release.yml), 之后 CI 不用 npm token 就能发布.
 *
 * npm 只能给已存在的包配 trusted publisher, 所以第一次要在本机:
 *   1. 包还不存在时, 发布一个只有 package.json 的占位版本 0.0.0 (发布后标记 deprecated);
 *   2. npm trust github <包> --file release.yml --repo <仓库> --allow-publish.
 * 真正的 Node.js 版本全部由 GitHub Actions 发布 (带 provenance), 发布后会成为 latest.
 * 已存在的包跳过第 1 步, 已绑定本仓库的包跳过第 2 步, 所以可以重复运行 (比如以后加了新平台).
 *
 * 用法 (需要先 npm login, 账号要能发布 runtime.json 里的 scope; 过程中 npm 可能要求 2FA 验证):
 *   node scripts/bootstrap-npm.mjs              执行
 *   node scripts/bootstrap-npm.mjs --dry-run    只打印要做什么
 *   node scripts/bootstrap-npm.mjs --repo owner/name   仓库不是 LuckyLilliaDev/NodeRuntime 时
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS, packageName } from './targets.mjs'

const WORKFLOW_FILE = 'release.yml'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { scope } = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'))

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const repoIndex = args.indexOf('--repo')
const repo = repoIndex >= 0 ? args[repoIndex + 1] : 'LuckyLilliaDev/NodeRuntime'
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
  console.error(`error: --repo 格式应为 owner/name, 收到 ${repo}`)
  process.exit(1)
}

// Windows 上 npm 是 npm.cmd, 要经过 shell; 参数自己加引号
function npm(npmArgs, { capture = false, cwd } = {}) {
  const shell = process.platform === 'win32'
  const finalArgs = shell ? npmArgs.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)) : npmArgs
  const result = spawnSync('npm', finalArgs, {
    cwd,
    shell,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function run(description, npmArgs, options) {
  console.log(`  ${dryRun ? '[dry-run] ' : ''}${description}: npm ${npmArgs.join(' ')}`)
  if (dryRun) return
  if (!npm(npmArgs, options).ok) {
    console.error(`error: ${description}失败, 修好后重新运行本脚本即可 (已完成的步骤会跳过)`)
    process.exit(1)
  }
}

const whoami = npm(['whoami'], { capture: true })
if (!whoami.ok) {
  console.error('error: 没有登录 npm, 先运行 npm login')
  process.exit(1)
}
console.log(`npm 账号: ${whoami.stdout.trim()}; 绑定仓库: ${repo}, workflow: ${WORKFLOW_FILE}${dryRun ? ' (dry-run)' : ''}`)

for (const target of TARGETS) {
  const name = packageName(scope, target)
  console.log(`\n${name}`)

  const exists = npm(['view', name, 'name'], { capture: true }).ok
  if (exists) {
    console.log('  已存在, 不发占位版本')
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-bootstrap-'))
    const manifest = {
      name,
      version: '0.0.0',
      description: `Placeholder for trusted publishing setup. Real Node.js builds are published from https://github.com/${repo}`,
      license: 'MIT',
      repository: { type: 'git', url: `git+https://github.com/${repo}.git` },
    }
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    run('发布占位版本 0.0.0', ['publish', '--access', 'public'], { cwd: dir })
    run('标记占位版本 deprecated', ['deprecate', `${name}@0.0.0`, 'placeholder, use a real version'])
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const trusted = exists ? npm(['trust', 'list', name, '--json'], { capture: true }) : { ok: false, stdout: '' }
  if (trusted.ok && trusted.stdout.includes(repo)) {
    console.log(`  已绑定 ${repo}, 跳过`)
    continue
  }
  run('绑定 GitHub Actions', ['trust', 'github', name, '--file', WORKFLOW_FILE, '--repo', repo, '--allow-publish', '--yes'])
}

console.log(`\n完成. 之后推 tag (v<runtime.json 的 packageVersion>) 由 GitHub Actions 发布; 核对绑定: npm trust list <包名>`)
