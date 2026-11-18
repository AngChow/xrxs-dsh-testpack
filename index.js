/**
 * xrxs-dsh-testpack：三端测试包 → 蒲公英固定内测渠道。
 *
 * 工具：
 *   - testpack_doctor：免费体检（工具链/项目/凭据配置状态/鸿蒙签名材料），不打包不上传。
 *   - testpack_run：后台任务，打包 + 上传蒲公英。渠道固定，配置即授权。
 *   - testpack_status：非消费式读取任务状态与脱敏输出。
 *
 * 凭据：蒲公英 API key 与鸿蒙 P12 密码只存 DSH 凭据库（credentialRef），
 * 绝不进配置明文、对话或日志（输出统一脱敏）。
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import { uploadAndPublish, uploadHarmonyCert, listCertificates, PLATFORM_CHANNEL } from './lib/pgyer.js'
import { buildIos, buildAndroid, buildHarmony, harmonySigningMaterial, readP7bInfo, readP12Subject, certSubjectCn } from './lib/builders.js'

export const name = 'xrxs-testpack'
export const inject = ['tools', 'jobs', 'subprocess', 'credentials', 'systemPrompt']

export const Config = z.object({
  pgyerApiKeyRef: z.string().default('PGYER_API_KEY')
    .description('蒲公英 API key 的凭据库引用名。'),
  outputMaxBytes: z.number().step(1).min(4096).default(65536)
    .description('单次工具输出上限（字节）。'),
  ios: z.object({
    projectRoot: z.string().default('~/workspace_codex/mobile-ios'),
    scheme: z.string().default('XinRen'),
    configuration: z.string().default('Debug'),
    exportMethod: z.string().default('development'),
  }).default({}),
  android: z.object({
    projectRoot: z.string().default('~/workspace_codex/mobile-android'),
    gradleArgs: z.string().default('clean assembleDebug'),
  }).default({}),
  harmony: z.object({
    projectRoot: z.string().default('~/workspace_codex/mobile_harmony'),
    product: z.string().default('default'),
    buildMode: z.string().default('debug'),
    p12Path: z.string().default(''),
    p12PasswordRef: z.string().default('PGYER_HARMONY_P12_PASSWORD'),
    forceCertUpload: z.boolean().default(false)
      .description('默认 false：账户里已有同 CN 的证书就跳过上传（证书按账号保存，同一张只需传一次）。换证书后置 true 强制重传。'),
    devecoCli: z.string().default('devecocli'),
  }).default({}),
})

const PLATFORMS = ['ios', 'android', 'harmony']
const RESULT_PREFIX = '@@TESTPACK_RESULT@@ '

function expandHome(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p }
function cap(t, max) { const v = String(t ?? ''); return v.length <= max ? v : `…[truncated]\n${v.slice(-max)}` }
function toolError(msg) { throw new Error(`[testpack] ${msg}`) }

/** 把已解析的敏感值从文本里抹掉。 */
function makeRedactor(secrets) {
  const list = secrets.filter(s => s && s.length >= 6)
  return text => { let t = String(text); for (const s of list) t = t.split(s).join('***'); return t }
}

export function apply(ctx, config) {
  const activeRuns = new Map() // platform -> jobId

  const outBase = path.join(os.homedir(), '.dsh', 'testpack')

  function platformCfg(platform) {
    const c = { ...config[platform] }
    c.projectRoot = expandHome(c.projectRoot)
    if (platform === 'harmony') c.p12Path = expandHome(c.p12Path || '')
    return c
  }

  async function resolveApiKey() {
    const info = await ctx.credentials.describe(config.pgyerApiKeyRef)
    if (!info.configured) toolError(`凭据库缺少 ${config.pgyerApiKeyRef}（蒲公英 API key），请在 插件 → 三端测试包 → 配置 页录入（值只进 DSH 凭据库）`)
    const hit = await ctx.credentials.resolve(config.pgyerApiKeyRef)
    if (!hit?.value) toolError(`凭据 ${config.pgyerApiKeyRef} 解析为空`)
    return hit.value
  }

  async function which(cmd) {
    try { return await ctx.subprocess.resolveExecutable(cmd) } catch { return null }
  }

  // ---------- doctor ----------
  async function runDoctor(platforms) {
    const report = { pgyer: {}, platforms: {} }
    const keyInfo = await ctx.credentials.describe(config.pgyerApiKeyRef)
    report.pgyer = { credentialRef: config.pgyerApiKeyRef, configured: keyInfo.configured, source: keyInfo.source ?? null }

    for (const p of platforms) {
      const cfg = platformCfg(p)
      const r = { projectRoot: cfg.projectRoot, channel: `https://www.pgyer.com/${PLATFORM_CHANNEL[p]}`, issues: [], notes: [] }
      r.projectExists = fs.existsSync(cfg.projectRoot)
      if (!r.projectExists) r.issues.push('项目目录不存在')

      if (p === 'ios') {
        r.workspace = fs.existsSync(path.join(cfg.projectRoot, `${cfg.scheme}.xcworkspace`))
        if (!r.workspace) r.issues.push(`缺少 ${cfg.scheme}.xcworkspace`)
        const bundle = await which('bundle')
        r.bundler = Boolean(bundle)
        if (!bundle) r.issues.push('bundle 不可用（brew install ruby 后 gem install bundler）')
        else {
          const h = ctx.subprocess.spawn({ argv: [bundle, 'check'], cwd: cfg.projectRoot, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } } })
          const { exitCode } = await h.done
          r.fastlaneReady = exitCode === 0
          if (exitCode !== 0) r.issues.push('fastlane 依赖未就绪：项目里跑 bundle install')
        }
        r.build = `fastlane gym ${cfg.configuration} + ${cfg.exportMethod}`
      }

      if (p === 'android') {
        r.gradlew = fs.existsSync(path.join(cfg.projectRoot, 'gradlew'))
        if (!r.gradlew) r.issues.push('缺少 gradlew')
        r.build = `./gradlew ${cfg.gradleArgs}`
        const javaHome = process.env.JAVA_HOME || null
        r.javaHome = javaHome
        if (!javaHome) r.notes.push('未设 JAVA_HOME，gradlew 将用 PATH 里的 java')
      }

      if (p === 'harmony') {
        const cli = await which(cfg.devecoCli)
        r.devecocli = cli
        if (!cli) r.issues.push(`devecocli 不可用（${cfg.devecoCli}）`)
        r.build = `devecocli build --product ${cfg.product} --build-mode ${cfg.buildMode}`
        // 签名材料校验：蒲公英要求发布证书 + 指定设备发布 Profile
        try {
          const sm = harmonySigningMaterial(cfg.projectRoot, cfg.product)
          if (!sm.ok) r.issues.push(sm.issue)
          else {
            r.signingConfig = sm.signingConfigName
            const m = sm.material
            r.p12 = { path: m.storeFile ?? null, exists: Boolean(m.storeFile && fs.existsSync(m.storeFile)) }
            if (!r.p12.exists) r.issues.push(`签名 P12 不存在：${m.storeFile ?? '(未配置)'}`)
            if (m.profile && fs.existsSync(m.profile)) {
              const info = readP7bInfo(m.profile)
              r.profile = info
              if (info.ok) {
                if (info.type === 'debug') r.issues.push('当前 Profile 是调试类型：蒲公英分发必须用「指定设备发布」Profile + 发布证书（去 AGC 申请后新建 innerTest 签名配置并把 product 指过去）')
                else if (info.distributionType !== 'internaltesting') r.issues.push(`当前 Profile 分发类型是 ${info.distributionType}（上架用）：蒲公英要求 internaltesting（指定设备发布）`)
                else if (!info.deviceCount) r.issues.push('指定设备发布 Profile 里没有设备 UDID，测试机装不上')
                else r.notes.push(`Profile 含 ${info.deviceCount} 台测试设备`)
              }
            } else r.issues.push(`Profile 文件不存在：${m.profile ?? '(未配置)'}`)
          }
        } catch (e) { r.issues.push(`解析 build-profile.json5 失败：${String(e?.message ?? e)}`) }
        // P12 密码凭据（上传蒲公英时需要）
        const pwRef = config.harmony.p12PasswordRef
        const pwInfo = await ctx.credentials.describe(pwRef)
        r.p12Password = { credentialRef: pwRef, configured: pwInfo.configured }
        if (!pwInfo.configured) r.issues.push(`凭据库缺少 ${pwRef}（鸿蒙 P12 密码，上传蒲公英必需）`)
        if (cfg.p12Path && !fs.existsSync(cfg.p12Path)) r.issues.push(`配置的 p12Path 不存在：${cfg.p12Path}`)
      }
      r.ready = r.issues.length === 0
      report.platforms[p] = r
    }
    return report
  }

  ctx.tools.register({
    name: 'testpack_doctor',
    description: '体检三端测试包环境（不打包不上传不花钱）：项目路径、构建工具链、蒲公英 API key 配置状态、鸿蒙签名材料与 Profile 类型。只返回配置状态，绝不返回凭据值。打包前先跑这个。',
    parameters: {
      type: 'object',
      properties: {
        platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS }, description: '只体检这些平台；省略体检全部。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async (args) => {
      try {
        const report = await runDoctor(args.platforms?.length ? args.platforms : PLATFORMS)
        return cap(JSON.stringify(report, null, 1), config.outputMaxBytes)
      } catch (e) { return JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }
    },
  })

  // ---------- run ----------
  ctx.tools.register({
    name: 'testpack_run',
    description: '打测试包并上传蒲公英（后台任务）。渠道固定：ios→ios_inner_test，android→android_inner_test，harmony→harmony_inner_test。配置即授权，无需每次审批；同一平台不允许并发。先跑 testpack_doctor，issues 为空再启动。返回 jobId，用 testpack_status 收结果。',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: PLATFORMS, description: '目标平台。' },
        updateDesc: { type: 'string', description: '蒲公英版本更新说明（1-300 字）。' },
      },
      required: ['platform', 'updateDesc'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async (args, exec) => {
      const platform = args.platform
      const updateDesc = String(args.updateDesc || '').trim()
      if (!updateDesc || updateDesc.length > 300) toolError('updateDesc 需为 1-300 字')
      if (activeRuns.has(platform)) toolError(`${platform} 已有任务在跑（${activeRuns.get(platform)}），先用 testpack_status 收结果`)

      // 前置体检：有 issues 直接拒绝
      const report = await runDoctor([platform])
      const pr = report.platforms[platform]
      if (!report.pgyer.configured) toolError(`凭据库缺少 ${config.pgyerApiKeyRef}`)
      if (!pr.ready) toolError(`${platform} 环境未就绪：${pr.issues.join('；')}`)

      const apiKey = await resolveApiKey()
      const secrets = [apiKey]
      let p12Password = null
      if (platform === 'harmony') {
        const hit = await ctx.credentials.resolve(config.harmony.p12PasswordRef)
        p12Password = hit?.value ?? null
        if (!p12Password) toolError(`凭据 ${config.harmony.p12PasswordRef} 解析为空`)
        secrets.push(p12Password)
      }
      const redact = makeRedactor(secrets)
      const cfg = platformCfg(platform)
      const outDir = path.join(outBase, platform)
      const channel = PLATFORM_CHANNEL[platform]

      const jobId = ctx.jobs.start({
        kind: 'testpack',
        label: `${platform} 测试包 → pgyer.com/${channel}`,
        owner: exec.agent?.id,
        outputLimitBytes: config.outputMaxBytes,
        run(job) {
          const log = t => job.append(redact(t) + '\n', { channel: 'stdout' })
          let cancelled = false
          const done = (async () => {
            try {
              job.updateProgress('构建中')
              log(`=== ${platform} 测试包：构建 → 上传蒲公英 ${channel} ===`)
              let artifact
              if (platform === 'ios') artifact = await buildIos(ctx.subprocess.spawn.bind(ctx.subprocess), cfg, { log, outDir })
              else if (platform === 'android') artifact = await buildAndroid(ctx.subprocess.spawn.bind(ctx.subprocess), cfg, { log })
              else artifact = await buildHarmony(ctx.subprocess.spawn.bind(ctx.subprocess), cfg, { log, devecoCli: pr.devecocli })
              log(`构建产物：${artifact}`)
              if (cancelled) return { status: 'killed', detail: '构建后取消' }

              job.updateProgress('上传蒲公英')
              const pub = await uploadAndPublish({ apiKey, platform, filePath: artifact, updateDesc, log })
              log(`发布成功：${pub.name} v${pub.version} (build ${pub.buildVersion})`)

              let certWarning = null
              if (platform === 'harmony') {
                // 蒲公英的 P12 证书按账户保存、按版本匹配：同一张证书只需上传一次。
                // 已有同 CN 证书时重复上传没有意义（还可能被接口以 3016 拒绝），所以先查再决定。
                const spawnFn = ctx.subprocess.spawn.bind(ctx.subprocess)
                const sm = harmonySigningMaterial(cfg.projectRoot, cfg.product)
                const p12Path = cfg.p12Path || (sm.ok ? sm.material.storeFile : '')
                let existing = []
                try {
                  const r = await listCertificates({ apiKey })
                  existing = r.list
                  if (existing.length > 0) {
                    log(`账户已有 ${existing.length} 张证书：${existing.map(c => `${c.certificateName}（${c.certificateCreated}）`).join('、')}`)
                  }
                } catch (e) {
                  log(`⚠️ 证书列表查询失败，按原流程上传：${String(e?.message ?? e)}`)
                }
                const local = await readP12Subject(spawnFn, { p12Path, password: p12Password })
                const sameCert = local.ok && existing.find(c => certSubjectCn(c.certificateName) === local.cn)
                // 本地证书与账户里已有的都对不上（例如刚换了证书）：这次上传必须成功，失败仍要判失败
                const rotation = local.ok && existing.length > 0 && !sameCert
                const canSkip = !config.harmony.forceCertUpload &&
                  (!!sameCert || (existing.length > 0 && !local.ok))
                if (canSkip) {
                  if (sameCert) {
                    log(`证书已存在（CN=${local.cn}，${sameCert.certificateCreated}），跳过上传`)
                  } else {
                    certWarning = `本地证书解析失败（${local.issue}），已按账户已有证书跳过上传；如刚更换证书请把 harmony.forceCertUpload 设为 true`
                    log(`⚠️ 证书警告：${certWarning}`)
                  }
                } else {
                  job.updateProgress('上传 P12 证书')
                  try {
                    const cert = await uploadHarmonyCert({ apiKey, buildKey: pub.buildKey, p12Path, p12Password, log })
                    certWarning = cert.warning
                    if (certWarning) log(`⚠️ 证书警告：${certWarning}`)
                    else log('P12 证书上传成功')
                  } catch (e) {
                    const msg = String(e?.message ?? e)
                    // 账户里已有同类证书、且不是在换证书时，上传失败不该把整次发布判失败：蒲公英仍用已有证书签 manifest
                    if (existing.length > 0 && !rotation) {
                      certWarning = `证书上传失败，但账户已有证书，通常不影响安装：${msg}`
                      log(`⚠️ 证书警告：${certWarning}`)
                    } else {
                      throw e
                    }
                  }
                }
              }

              const result = { ok: true, platform, artifact, ...pub, certWarning, channelUrl: pub.url }
              log(RESULT_PREFIX + JSON.stringify(result))
              log(`下载页：${pub.url}`)
              return { status: 'completed', detail: `v${pub.version} → ${pub.url}`, result: JSON.stringify(result) }
            } catch (e) {
              const msg = redact(String(e?.message ?? e))
              log(`❌ 失败：${msg}`)
              const result = { ok: false, platform, error: msg }
              log(RESULT_PREFIX + JSON.stringify(result))
              return { status: cancelled ? 'killed' : 'failed', detail: msg, result: JSON.stringify(result) }
            } finally {
              activeRuns.delete(platform)
            }
          })()
          return { cancel(reason) { cancelled = true; log(`收到取消请求：${reason ?? ''}`) }, done }
        },
      })
      activeRuns.set(platform, jobId)
      return JSON.stringify({ ok: true, jobId, platform, channel: `https://www.pgyer.com/${channel}`, note: '后台任务已启动，用 testpack_status 读取进度与结果。' }, null, 1)
    },
  })

  // ---------- status ----------
  ctx.tools.register({
    name: 'testpack_status',
    description: '读取测试包后台任务的状态与脱敏输出。非消费式读取，可反复调用。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'testpack_run 返回的任务 id。' },
        fromByte: { type: 'integer', description: '输出流读取偏移量；默认 0。' },
        maxBytes: { type: 'integer', description: '本次最多返回字节数；受插件 outputMaxBytes 限制。' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async (args, exec) => {
      const view = ctx.jobs.get(args.jobId, exec.agent?.id)
      if (!view) toolError(`job "${args.jobId}" 不存在或不属于本会话`)
      const read = ctx.jobs.readAt(args.jobId, args.fromByte ?? 0, exec.agent?.id)
      const budget = Math.min(args.maxBytes ?? config.outputMaxBytes, config.outputMaxBytes)
      let text = read.chunks.map(c => c.text).join('')
      let result = null
      for (const line of text.split('\n')) {
        if (line.startsWith(RESULT_PREFIX)) { try { result = JSON.parse(line.slice(RESULT_PREFIX.length)) } catch {} }
      }
      text = text.split('\n').filter(l => !l.startsWith(RESULT_PREFIX)).join('\n')
      text = cap(text, budget)
      return JSON.stringify({
        jobId: view.id, status: view.status, progress: view.progress ?? null,
        startedAt: view.startedAt, finishedAt: view.finishedAt ?? null,
        nextByte: read.next, lossy: read.lossy, result, output: text,
      }, null, 1)
    },
  })

  ctx.systemPrompt.section({
    name: 'tool:xrxs-testpack',
    order: 134,
    text: [
      '打 iOS/Android/鸿蒙测试包并上传蒲公英用 testpack_* 工具：先 testpack_doctor 体检，issues 为空再 testpack_run，结果用 testpack_status 收。',
      '渠道固定不可选：ios_inner_test / android_inner_test / harmony_inner_test。',
      '蒲公英 API key 与鸿蒙 P12 密码存 DSH 凭据库，绝不要让用户在对话中粘贴；用户可在 插件 → 三端测试包 → 配置 页改项目路径与录入凭据。',
      '鸿蒙包上蒲公英必须发布证书 + 指定设备发布(internaltesting) Profile；doctor 会校验，调试 Profile 或 app_gallery Profile 都不能用。',
      '鸿蒙 P12 证书按蒲公英账号保存、同一张只需传一次：插件发布后会先查证书列表，已有同 CN 证书就跳过上传（换证书时把 harmony.forceCertUpload 设 true 强制重传）。',
    ].join(' '),
  })

  // ---- 配置页 RPC（client.js 的插件行配置页调用）----
  const RPC_CHANNEL = '/api/xrxs-testpack'
  const rpcFail = (message, code = 'error', status = 400) => Response.json({ ok: false, error: { code, message } }, { status })

  /** 非敏感配置回显 + 凭据配置状态（绝不回显凭据值）。 */
  async function settingsGet() {
    const refs = {
      pgyerApiKeyRef: config.pgyerApiKeyRef,
      p12PasswordRef: config.harmony.p12PasswordRef,
    }
    const cred = {}
    for (const [name, ref] of Object.entries(refs)) {
      const info = await ctx.credentials.describe(ref)
      cred[name] = { ref, configured: info.configured, writable: info.writable }
    }
    return {
      ios: { ...config.ios },
      android: { ...config.android },
      harmony: { ...config.harmony },
      channels: PLATFORM_CHANNEL,
      credentials: cred,
    }
  }

  /** 保存非敏感配置（白名单字段），经 configEditor 持久化；保存会重启插件 apply。 */
  async function settingsSave(payload) {
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (!editor || entry === undefined) throw new Error('配置编辑器不可用，无法保存设置')
    const str = v => (typeof v === 'string' ? v.trim() : undefined)
    const patch = {}
    const pick = (src, keys) => {
      const out = {}
      for (const k of keys) { const v = str(src?.[k]); if (v !== undefined) out[k] = v }
      return out
    }
    if (payload.ios) patch.ios = pick(payload.ios, ['projectRoot', 'scheme', 'configuration', 'exportMethod'])
    if (payload.android) patch.android = pick(payload.android, ['projectRoot', 'gradleArgs'])
    if (payload.harmony) patch.harmony = pick(payload.harmony, ['projectRoot', 'product', 'buildMode', 'p12Path', 'devecoCli'])
    await editor.edit(entry, cur => ({
      ...cur,
      ...(patch.ios ? { ios: { ...(cur?.ios ?? {}), ...patch.ios } } : {}),
      ...(patch.android ? { android: { ...(cur?.android ?? {}), ...patch.android } } : {}),
      ...(patch.harmony ? { harmony: { ...(cur?.harmony ?? {}), ...patch.harmony } } : {}),
    }))
    return { saved: Object.keys(patch) }
  }

  /** 录入/清除凭据：值只进 DSH 凭据库，不落配置、不回显。 */
  async function credentialSave(payload) {
    const which = String(payload?.which ?? '')
    const ref = which === 'pgyer' ? config.pgyerApiKeyRef
      : which === 'p12' ? config.harmony.p12PasswordRef
        : null
    if (!ref) throw new Error('which 必须是 pgyer 或 p12')
    const value = typeof payload.value === 'string' ? payload.value.trim() : ''
    if (payload.clear === true) {
      await ctx.credentials.unset(ref)
      return { ref, configured: false }
    }
    if (!value) throw new Error('凭据值不能为空')
    if (which === 'pgyer' && !/^[0-9a-f]{32}$/.test(value)) throw new Error('蒲公英 API key 应为 32 位小写十六串（后台「API 信息」页复制）')
    await ctx.credentials.set(ref, value)
    return { ref, configured: true }
  }

  async function handleRpc(request) {
    let body
    try { body = await request.json() } catch { return rpcFail('body is not JSON', 'bad-request') }
    const method = body?.method
    const payload = body?.payload || {}
    try {
      switch (method) {
        case 'settings.get': return Response.json({ ok: true, value: await settingsGet() })
        case 'settings.save': return Response.json({ ok: true, value: await settingsSave(payload) })
        case 'credential.save': return Response.json({ ok: true, value: await credentialSave(payload) })
        case 'doctor': {
          const platforms = Array.isArray(payload.platforms) && payload.platforms.length
            ? payload.platforms.filter(p => PLATFORMS.includes(p)) : PLATFORMS
          return Response.json({ ok: true, value: await runDoctor(platforms) })
        }
        default: return rpcFail(`未知方法 ${method ?? '(empty)'}`, 'method-not-found', 404)
      }
    } catch (err) {
      return rpcFail(String(err?.message ?? err), 'handler-failed', 500)
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (cctx) => {
      cctx.effect(() => {
        let dispose = null
        void cctx.connection.fetch
          .register({ path: RPC_CHANNEL, methods: ['POST'], requestBody: 'buffered', fetch: handleRpc })
          .then((d) => { dispose = d })
          .catch((e) => console.log('[xrxs-testpack] rpc register failed:', e?.message ?? e))
        return () => { if (dispose) void Promise.resolve(dispose()).catch(() => {}) }
      }, 'xrxs-testpack: rpc fetch route')
    })
  }
}