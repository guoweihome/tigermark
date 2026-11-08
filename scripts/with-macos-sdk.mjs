import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const env = { ...process.env }

if (process.platform === 'darwin' && !env.SDKROOT) {
  const fallback = '/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk'
  try {
    const selected = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim()
    if (selected.includes('MacOSX27') && existsSync(fallback)) {
      env.SDKROOT = fallback
    }
  } catch {
    // Keep the system SDK when xcrun is unavailable.
  }
}

const child = spawn(process.argv[2], process.argv.slice(3), {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
