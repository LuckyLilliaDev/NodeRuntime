// 平台列表, build.mjs 和 bootstrap-npm.mjs 共用.
// id 和桌面端 PlatformHelper.PlatformIdentifier 一一对应, 改名要两边一起改; 加平台后要先跑一次 bootstrap-npm.mjs.
export const TARGETS = [
  { id: 'win-x64', dist: 'win-x64', ext: 'zip', bin: 'node.exe', os: 'win32', cpu: 'x64' },
  { id: 'win-arm64', dist: 'win-arm64', ext: 'zip', bin: 'node.exe', os: 'win32', cpu: 'arm64' },
  { id: 'macos-x64', dist: 'darwin-x64', ext: 'tar.gz', bin: 'node', os: 'darwin', cpu: 'x64' },
  { id: 'macos-arm64', dist: 'darwin-arm64', ext: 'tar.gz', bin: 'node', os: 'darwin', cpu: 'arm64' },
  { id: 'linux-x64', dist: 'linux-x64', ext: 'tar.gz', bin: 'node', os: 'linux', cpu: 'x64' },
  { id: 'linux-arm64', dist: 'linux-arm64', ext: 'tar.gz', bin: 'node', os: 'linux', cpu: 'arm64' },
]

export const packageName = (scope, target) => `${scope}/node-${target.id}`
