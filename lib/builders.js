/**
 * 三端构建器：在子进程里跑各自的构建命令，产出安装包绝对路径。
 * 所有输出经 log() 进入 job 输出环（调用方负责脱敏）。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 递归找目录下最新的匹配文件（限深度，避免扫全仓库）。 */
async function newestMatch(dir, test, depth = 4) {
  let best = null
  async function walk(d, level) {
    let entries
    try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (level < depth) await walk(p, level + 1) }
      else if (test(e.name)) {
        const st = await fsp.stat(p).catch(() => null)
        if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs }
      }
    }
  }
  await walk(dir, 0)
  return best?.path ?? null
}

/**
 * 跑一条构建命令，输出泵进 log；返回退出码。
 * spawn 由调用方传入（ctx.subprocess.spawn），保持本模块无 cordis 依赖、可单测。
 */
export async function runBuildCommand(spawn, { argv, cwd, env = {}, log, timeoutMs = 45 * 60000 }) {
  log(`$ ${argv.join(' ')}`)
  const handle = spawn({
    argv,
    cwd,
    env,
    graceMs: 8000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
  })
  let outOff = 0, errOff = 0, timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { handle.terminate() } catch {} }, timeoutMs)
  const pump = setInterval(() => {
    for (const [stream, getOff, setOff] of [['stdout', () => outOff, v => { outOff = v }], ['stderr', () => errOff, v => { errOff = v }]]) {
      try {
        const r = handle.collected[stream]?.readFrom(getOff())
        if (r?.text) { setOff(r.nextOffset); log(r.text.replace(/\n$/, '')) }
      } catch {}
    }
  }, 500)
  try {
    const { exitCode } = await handle.done
    if (timedOut) throw new Error(`构建超时（${Math.round(timeoutMs / 60000)} 分钟）`)
    return exitCode
  } finally {
    clearInterval(pump)
    clearTimeout(timer)
    for (const [stream, off] of [['stdout', outOff], ['stderr', errOff]]) {
      try { const r = handle.collected[stream]?.readFrom(off); if (r?.text) log(r.text.replace(/\n$/, '')) } catch {}
    }
  }
}

/** iOS：bundle exec fastlane gym，Debug + development，产出 ipa。 */
export async function buildIos(spawn, cfg, { log, outDir }) {
  const root = cfg.projectRoot
  if (!fs.existsSync(path.join(root, `${cfg.scheme}.xcworkspace`))) throw new Error(`找不到 ${cfg.scheme}.xcworkspace（请用 workspace 而非 xcodeproj）`)
  await fsp.mkdir(outDir, { recursive: true })
  const stamp = Date.now()
  const ipaName = `XinRen_${cfg.configuration}_${stamp}.ipa`
  const exportPlist = path.join(root, 'fastlane/ExportOptionPlist', `${cfg.exportMethod}.plist`)
  const argv = ['bundle', 'exec', 'fastlane', 'gym',
    '--workspace', path.join(root, `${cfg.scheme}.xcworkspace`),
    '--scheme', cfg.scheme,
    '--clean',
    '--configuration', cfg.configuration,
    '--archive_path', path.join(outDir, `XinRen_${cfg.configuration}_${stamp}.xcarchive`),
    '--export_method', cfg.exportMethod,
    ...(fs.existsSync(exportPlist) ? ['--export_options', exportPlist] : []),
    '--skip_package_dependencies_resolution', 'true',
    '--destination', 'generic/platform=iOS',
    '--output_directory', outDir,
    '--output_name', ipaName,
  ]
  const code = await runBuildCommand(spawn, { argv, cwd: root, log })
  if (code !== 0) throw new Error(`fastlane gym 失败（退出码 ${code}）`)
  const ipa = path.join(outDir, ipaName)
  if (!fs.existsSync(ipa)) throw new Error(`构建成功但未找到 ipa：${ipa}`)
  return ipa
}

/** Android：./gradlew clean assembleDebug，产物在 app/build/outputs/apk/debug。 */
export async function buildAndroid(spawn, cfg, { log }) {
  const root = cfg.projectRoot
  const gradlew = path.join(root, 'gradlew')
  if (!fs.existsSync(gradlew)) throw new Error(`找不到 gradlew：${gradlew}`)
  const args = String(cfg.gradleArgs || 'clean assembleDebug').split(/\s+/).filter(Boolean)
  const code = await runBuildCommand(spawn, { argv: [gradlew, ...args], cwd: root, log })
  if (code !== 0) throw new Error(`gradlew 失败（退出码 ${code}）`)
  const apk = await newestMatch(path.join(root, 'app/build/outputs'), n => n.endsWith('.apk'))
  if (!apk) throw new Error('构建成功但未找到 apk（app/build/outputs 下）')
  return apk
}

/**
 * 鸿蒙：devecocli build。product 决定签名配置（build-profile.json5 products.signingConfig）。
 * 蒲公英要求发布证书 + 指定设备发布 Profile；doctor 已前置校验，这里只构建。
 */
export async function buildHarmony(spawn, cfg, { log, devecoCli }) {
  const root = cfg.projectRoot
  if (!fs.existsSync(path.join(root, 'build-profile.json5'))) throw new Error(`不是鸿蒙工程：${root}`)
  const argv = [devecoCli, 'build', '--product', cfg.product || 'default', '--build-mode', cfg.buildMode || 'debug']
  const code = await runBuildCommand(spawn, { argv, cwd: root, log, timeoutMs: 60 * 60000 })
  if (code !== 0) throw new Error(`devecocli build 失败（退出码 ${code}）`)
  const hap = await newestMatch(path.join(root, 'entry/build'), n => n.endsWith('-signed.hap'), 5)
  if (!hap) throw new Error('构建成功但未找到 entry/build 下的 *-signed.hap')
  return hap
}

/**
 * 静默跑一条小命令并收集输出（不泵日志），用于解析 p12 之类的一次性读取。
 * 与 runBuildCommand 的区别：不写日志、返回 stdout/stderr 文本。
 */
async function runCapture(spawn, { argv, cwd, env = {}, timeoutMs = 20000 }) {
  const handle = spawn({
    argv,
    cwd,
    env,
    graceMs: 4000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { handle.terminate() } catch {} }, timeoutMs)
  try {
    const { exitCode } = await handle.done
    if (timedOut) throw new Error('命令超时')
    const read = stream => {
      try { return handle.collected[stream]?.readFrom(0)?.text ?? '' } catch { return '' }
    }
    return { code: exitCode, stdout: read('stdout'), stderr: read('stderr') }
  } finally {
    clearTimeout(timer)
  }
}

/** 从证书 subject 里取 CN，兼容 OpenSSL 3（`CN=x`）与 LibreSSL（`/CN=x`）两种写法。 */
export function certSubjectCn(subject) {
  const m = String(subject ?? '').match(/CN=([^/,\n]+)/)
  return m ? m[1].trim() : ''
}

/**
 * 用 openssl 读 p12 里证书的 subject/CN，用于和蒲公英「证书列表」比对是否同一张证书。
 * 密码写进 0600 临时文件后立刻删除：不进 argv（ps 可见）、不进 env。
 */
export async function readP12Subject(spawn, { p12Path, password, openssl = 'openssl' }) {
  if (!fs.existsSync(p12Path)) return { ok: false, issue: `p12 不存在：${p12Path}` }
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const pwFile = path.join(os.tmpdir(), `pgyer-p12pw-${tag}`)
  const pemFile = path.join(os.tmpdir(), `pgyer-p12cert-${tag}.pem`)
  try {
    fs.writeFileSync(pwFile, String(password ?? ''), { mode: 0o600 })
    const exp = await runCapture(spawn, {
      argv: [openssl, 'pkcs12', '-in', p12Path, '-passin', `file:${pwFile}`, '-nokeys', '-clcerts', '-out', pemFile],
    })
    if (exp.code !== 0) {
      return { ok: false, issue: (exp.stderr || '').trim().slice(0, 200) || `openssl pkcs12 退出码 ${exp.code}` }
    }
    const sub = await runCapture(spawn, { argv: [openssl, 'x509', '-in', pemFile, '-noout', '-subject'] })
    if (sub.code !== 0) {
      return { ok: false, issue: (sub.stderr || '').trim().slice(0, 200) || `openssl x509 退出码 ${sub.code}` }
    }
    const subject = (sub.stdout || '').trim()
    return { ok: true, subject, cn: certSubjectCn(subject) }
  } catch (e) {
    return { ok: false, issue: String(e?.message ?? e) }
  } finally {
    for (const f of [pwFile, pemFile]) { try { fs.rmSync(f, { force: true }) } catch {} }
  }
}

/** 解析鸿蒙 build-profile.json5 里 product 引用的签名材料（宽松 JSON5：仅去注释）。 */
export function harmonySigningMaterial(root, productName) {
  const raw = fs.readFileSync(path.join(root, 'build-profile.json5'), 'utf8')
  const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')
  const j = JSON.parse(cleaned)
  const product = (j.app?.products ?? []).find(p => p.name === productName)
  if (!product) return { ok: false, issue: `build-profile.json5 里没有 product "${productName}"` }
  const sc = (j.app?.signingConfigs ?? []).find(s => s.name === product.signingConfig)
  if (!sc) return { ok: false, issue: `product "${productName}" 引用的 signingConfig "${product.signingConfig}" 不存在` }
  return { ok: true, signingConfigName: sc.name, material: sc.material ?? {} }
}

/** 从 p7b（PKCS7 内嵌 JSON）里读 profile 类型与设备数。 */
export function readP7bInfo(p7bPath) {
  const data = fs.readFileSync(p7bPath)
  const m = data.toString('latin1').match(/\{"version-name"[\s\S]*?"issuer"\s*:\s*"[^"]*"\}/)
  if (!m) return { ok: false, issue: '无法从 p7b 中解析出 profile JSON' }
  const j = JSON.parse(Buffer.from(m[0], 'latin1').toString('utf8'))
  return {
    ok: true,
    type: j.type,
    distributionType: j['app-distribution-type'],
    deviceCount: (j['debug-info']?.['device-ids'] ?? []).length,
    bundleName: j['bundle-info']?.['bundle-name'],
    notAfter: j.validity?.['not-after'],
  }
}