/**
 * xrxs-dsh-testpack Client 半：在「设置 → 插件」注册「三端测试包」设置 tab。
 * 三平台项目路径/构建参数表单 + 蒲公英 API key / 鸿蒙 P12 密码录入（只进凭据库，不回显）
 * + 一键体检（含鸿蒙 Profile 类型校验）。通过 /api/xrxs-testpack RPC 读写 host。
 */
window.__ModuleLoader__.load({
  id: 'xrxs-dsh-testpack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/api/xrxs-testpack'
    const BLUE = '#4278EA'

    async function rpc(method, payload) {
      const res = await fetch(CHANNEL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload: payload ?? null }),
      })
      const data = await res.json().catch(() => null)
      const result = data?.result ?? data
      if (!result) throw new Error('RPC 响应为空')
      if (!result.ok) throw new Error(result.error?.message ?? 'RPC 失败')
      return result.value
    }

    const STYLE = `
      .xtp-page { display:flex; flex-direction:column; gap:14px; color:var(--dsw-alias-label-primary); font-size:13px; max-width:820px; }
      .xtp-lead { color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.6; }
      .xtp-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:16px; display:flex; flex-direction:column; gap:12px; }
      .xtp-card h3 { margin:0; font-size:13.5px; display:flex; align-items:center; gap:8px; }
      .xtp-badge { font-size:11px; padding:1px 8px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-weight:400; }
      .xtp-badge.ok { color:var(--dsw-alias-state-success-primary); }
      .xtp-badge.err { color:var(--dsw-alias-state-error-primary); }
      .xtp-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; }
      .xtp-row { display:flex; flex-direction:column; gap:5px; }
      .xtp-row.wide { grid-column:1 / -1; }
      .xtp-label { font-size:12px; font-weight:500; }
      .xtp-hint { font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.5; }
      .xtp-input { border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); padding:7px 10px; font-size:12.5px; outline:none; width:100%; box-sizing:border-box; font-family:inherit; }
      .xtp-input:focus { border-color:${BLUE}; }
      .xtp-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .xtp-btn { border:none; border-radius:8px; background:${BLUE}; color:#fff; padding:7px 16px; font-size:12.5px; cursor:pointer; }
      .xtp-btn.ghost { background:transparent; color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2); }
      .xtp-btn:disabled { opacity:.55; cursor:default; }
      .xtp-note { font-size:12.5px; } .xtp-note.ok { color:var(--dsw-alias-state-success-primary); } .xtp-note.err { color:var(--dsw-alias-state-error-primary); }
      .xtp-issues { margin:0; padding-left:18px; font-size:12px; color:var(--dsw-alias-state-error-primary); line-height:1.7; }
      .xtp-oklist { margin:0; padding-left:18px; font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.7; }
      .xtp-cred { display:flex; gap:8px; align-items:center; }
      .xtp-cred .xtp-input { flex:1; }
      .xtp-dot { width:8px; height:8px; border-radius:50%; flex:none; }
      .xtp-dot.on { background:var(--dsw-alias-state-success-primary); }
      .xtp-dot.off { background:var(--dsw-alias-state-error-primary); }
    `

    function Field({ label, hint, wide, value, onChange, placeholder, type }) {
      return h('div', { className: 'xtp-row' + (wide ? ' wide' : '') },
        h('label', { className: 'xtp-label' }, label),
        h('input', {
          className: 'xtp-input', value: value ?? '', placeholder: placeholder || '',
          type: type || 'text', spellCheck: false,
          onChange: e => onChange(e.target.value),
        }),
        hint ? h('div', { className: 'xtp-hint' }, hint) : null,
      )
    }

    function CredRow({ label, hint, status, onSave, onClear, placeholder }) {
      const [val, setVal] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      async function save() {
        setBusy(true); setNote(null)
        try { await onSave(val); setVal(''); setNote({ ok: true, text: '已保存到凭据库' }) }
        catch (e) { setNote({ ok: false, text: e?.message ?? String(e) }) }
        finally { setBusy(false) }
      }
      async function clear() {
        setBusy(true); setNote(null)
        try { await onClear(); setNote({ ok: true, text: '已清除' }) }
        catch (e) { setNote({ ok: false, text: e?.message ?? String(e) }) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'xtp-row wide' },
        h('label', { className: 'xtp-label' }, label),
        h('div', { className: 'xtp-cred' },
          h('span', { className: 'xtp-dot ' + (status?.configured ? 'on' : 'off'), title: status?.configured ? '已配置' : '未配置' }),
          h('input', {
            className: 'xtp-input', type: 'password', value: val, placeholder: status?.configured ? '已配置（输入新值可覆盖）' : (placeholder || '输入后保存'),
            spellCheck: false, autoComplete: 'new-password',
            onChange: e => setVal(e.target.value),
          }),
          h('button', { className: 'xtp-btn', disabled: busy || !val, onClick: save }, '保存'),
          status?.configured ? h('button', { className: 'xtp-btn ghost', disabled: busy, onClick: clear }, '清除') : null,
        ),
        note ? h('span', { className: 'xtp-note ' + (note.ok ? 'ok' : 'err') }, note.text) : null,
        h('div', { className: 'xtp-hint' }, hint),
      )
    }

    function DoctorResult({ r }) {
      if (!r) return null
      return h('div', null,
        r.issues?.length
          ? h('ul', { className: 'xtp-issues' }, r.issues.map((s, i) => h('li', { key: i }, s)))
          : h('div', { className: 'xtp-note ok' }, '✓ 环境就绪'),
        r.notes?.length ? h('ul', { className: 'xtp-oklist' }, r.notes.map((s, i) => h('li', { key: i }, s))) : null,
        r.profile?.ok ? h('div', { className: 'xtp-hint' },
          `Profile：${r.profile.type} / ${r.profile.distributionType} · ${r.profile.deviceCount} 台测试设备 · ${r.profile.bundleName}`) : null,
      )
    }

    function SettingsPage() {
      const [form, setForm] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [doctor, setDoctor] = React.useState(null)

      async function load(retry = 2) {
        for (let i = 0; i <= retry; i++) {
          try { setForm(await rpc('settings.get')); setLoadError(''); return }
          catch (e) {
            if (i === retry) setLoadError(e?.message ?? String(e))
            else await new Promise(r => setTimeout(r, 600)) // 保存触发插件重启，稍候重试
          }
        }
      }
      React.useEffect(() => { let a = true; rpc('settings.get').then(v => { if (a) setForm(v) }).catch(e => { if (a) setLoadError(e?.message ?? String(e)) }); return () => { a = false } }, [])

      const set = (plat, key) => v => setForm(p => ({ ...p, [plat]: { ...p[plat], [key]: v } }))

      async function save() {
        setBusy(true); setNote(null)
        try {
          await rpc('settings.save', { ios: form.ios, android: form.android, harmony: form.harmony })
          setNote({ ok: true, text: '已保存。插件重载中…' })
          await load()
          setNote({ ok: true, text: '已保存并生效。' })
        } catch (e) { setNote({ ok: false, text: '保存失败：' + (e?.message ?? e) }) }
        finally { setBusy(false) }
      }

      async function runDoctor() {
        setBusy(true); setNote(null)
        try { setDoctor(await rpc('doctor')) }
        catch (e) { setNote({ ok: false, text: '体检失败：' + (e?.message ?? e) }) }
        finally { setBusy(false) }
      }

      async function saveCred(which, value) { await rpc('credential.save', { which, value }); await load(0).catch(() => {}) ; setForm(p => p && ({ ...p, credentials: { ...p.credentials, [which === 'pgyer' ? 'pgyerApiKeyRef' : 'p12PasswordRef']: { ...p.credentials[which === 'pgyer' ? 'pgyerApiKeyRef' : 'p12PasswordRef'], configured: true } } })) }
      async function clearCred(which) { await rpc('credential.save', { which, clear: true }); setForm(p => p && ({ ...p, credentials: { ...p.credentials, [which === 'pgyer' ? 'pgyerApiKeyRef' : 'p12PasswordRef']: { ...p.credentials[which === 'pgyer' ? 'pgyerApiKeyRef' : 'p12PasswordRef'], configured: false } } })) }

      if (loadError) return h('div', { className: 'xtp-page' }, h('style', null, STYLE),
        h('div', { className: 'xtp-note err' }, '读取设置失败：' + loadError),
        h('button', { className: 'xtp-btn ghost', onClick: () => load() }, '重试'))
      if (!form) return h('div', { className: 'xtp-page' }, h('style', null, STYLE), h('div', { className: 'xtp-hint' }, '读取设置中…'))

      const ch = form.channels || {}
      const cred = form.credentials || {}
      const dr = doctor?.platforms
      return h('div', { className: 'xtp-page' },
        h('style', null, STYLE),
        h('div', { className: 'xtp-lead' }, '三端测试包 → 蒲公英固定内测渠道。路径与构建参数保存在插件配置；API key 与 P12 密码只存 DSH 凭据库（不回显、不进日志）。改完先「保存配置」再「一键体检」。'),

        // 凭据卡
        h('div', { className: 'xtp-card' },
          h('h3', null, '凭据', h('span', { className: 'xtp-badge' }, '只进凭据库')),
          h(CredRow, {
            label: '蒲公英 API Key', status: cred.pgyerApiKeyRef,
            placeholder: '32 位 key，蒲公英后台「API 信息」页复制',
            hint: '三平台共用。失效时上传会报 1002，来这里覆盖新值即可。',
            onSave: v => saveCred('pgyer', v), onClear: () => clearCred('pgyer'),
          }),
          h(CredRow, {
            label: '鸿蒙 P12 密码', status: cred.p12PasswordRef,
            placeholder: 'xrxs.p12 的原始密码（非 DevEco 加密串）',
            hint: '上传鸿蒙包时蒲公英用它签 manifest.json5；必须与签 hap 的 p12 同源。',
            onSave: v => saveCred('p12', v), onClear: () => clearCred('p12'),
          }),
        ),

        // iOS
        h('div', { className: 'xtp-card' },
          h('h3', null, 'iOS', h('span', { className: 'xtp-badge' }, ch.ios ? `pgyer.com/${ch.ios}` : ''),
            dr?.ios ? h('span', { className: 'xtp-badge ' + (dr.ios.ready ? 'ok' : 'err') }, dr.ios.ready ? '就绪' : '有问题') : null),
          h('div', { className: 'xtp-grid' },
            h(Field, { label: '项目路径', wide: true, value: form.ios.projectRoot, onChange: set('ios', 'projectRoot'), placeholder: '/path/to/mobile-ios' }),
            h(Field, { label: 'Scheme', value: form.ios.scheme, onChange: set('ios', 'scheme') }),
            h(Field, { label: '编译配置', value: form.ios.configuration, onChange: set('ios', 'configuration'), hint: 'Debug / Release / Gray' }),
            h(Field, { label: '导出方式', value: form.ios.exportMethod, onChange: set('ios', 'exportMethod'), hint: 'development / ad-hoc（对应 fastlane/ExportOptionPlist 下的 plist）' }),
          ),
          h(DoctorResult, { r: dr?.ios }),
        ),

        // Android
        h('div', { className: 'xtp-card' },
          h('h3', null, 'Android', h('span', { className: 'xtp-badge' }, ch.android ? `pgyer.com/${ch.android}` : ''),
            dr?.android ? h('span', { className: 'xtp-badge ' + (dr.android.ready ? 'ok' : 'err') }, dr.android.ready ? '就绪' : '有问题') : null),
          h('div', { className: 'xtp-grid' },
            h(Field, { label: '项目路径', wide: true, value: form.android.projectRoot, onChange: set('android', 'projectRoot'), placeholder: '/path/to/mobile-android' }),
            h(Field, { label: 'Gradle 参数', wide: true, value: form.android.gradleArgs, onChange: set('android', 'gradleArgs'), hint: '默认 clean assembleDebug；产物自动取 app/build/outputs 下最新 apk' }),
          ),
          h(DoctorResult, { r: dr?.android }),
        ),

        // 鸿蒙
        h('div', { className: 'xtp-card' },
          h('h3', null, '鸿蒙', h('span', { className: 'xtp-badge' }, ch.harmony ? `pgyer.com/${ch.harmony}` : ''),
            dr?.harmony ? h('span', { className: 'xtp-badge ' + (dr.harmony.ready ? 'ok' : 'err') }, dr.harmony.ready ? '就绪' : '有问题') : null),
          h('div', { className: 'xtp-hint' }, '蒲公英硬性要求：发布证书 + 「指定设备发布」(internaltesting) Profile。请在 build-profile.json5 里建 innerTest 签名配置指向该材料，product 填对应名字。调试 / app_gallery Profile 会被体检拦截。'),
          h('div', { className: 'xtp-grid' },
            h(Field, { label: '项目路径', wide: true, value: form.harmony.projectRoot, onChange: set('harmony', 'projectRoot'), placeholder: '/path/to/mobile_harmony' }),
            h(Field, { label: 'Product', value: form.harmony.product, onChange: set('harmony', 'product'), hint: 'build-profile.json5 products 里的名字（如 innerTest）' }),
            h(Field, { label: 'Build Mode', value: form.harmony.buildMode, onChange: set('harmony', 'buildMode'), hint: 'debug / release' }),
            h(Field, { label: 'P12 路径', wide: true, value: form.harmony.p12Path, onChange: set('harmony', 'p12Path'), hint: '留空则用 product 签名配置里的 storeFile', placeholder: '/path/to/xrxs.p12' }),
            h(Field, { label: 'devecocli 路径', wide: true, value: form.harmony.devecoCli, onChange: set('harmony', 'devecoCli'), hint: '默认 PATH 里的 devecocli' }),
          ),
          h(DoctorResult, { r: dr?.harmony }),
        ),

        // 操作
        h('div', { className: 'xtp-actions' },
          h('button', { className: 'xtp-btn', disabled: busy, onClick: save }, busy ? '处理中…' : '保存配置'),
          h('button', { className: 'xtp-btn ghost', disabled: busy, onClick: runDoctor }, '一键体检'),
          note ? h('span', { className: 'xtp-note ' + (note.ok ? 'ok' : 'err') }, note.text) : null,
        ),
        h('div', { className: 'xtp-hint' }, '体检不打包不上传；打包在会话里说「打个 iOS/Android/鸿蒙测试包」即可（testpack 工具）。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'xrxs-testpack', order: 64, label: () => '三端测试包' },
            SettingsPage,
          ),
        )
      },
    }
  },
})