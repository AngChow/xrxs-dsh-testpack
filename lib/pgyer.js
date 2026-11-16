/**
 * 蒲公英上传器：官方「快速上传」三步流程 + 鸿蒙 P12 证书上传。
 * getCOSToken → multipart POST 到 COS → 轮询 buildInfo。
 * 业务码失败一律抛错并带平台 message（修掉老脚本静默失败的坑）。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const API = 'https://www.pgyer.com/apiv2/app'
const CERT_API = 'https://upload.pgyer.com/apiv2/app/uploadHarmonyCert'

export const PLATFORM_BUILD_TYPE = { ios: 'ios', android: 'android', harmony: 'harmonyos' }
export const PLATFORM_CHANNEL = {
  ios: 'ios_inner_test',
  android: 'android_inner_test',
  harmony: 'harmony_inner_test',
}

/** 带超时的 fetch，超时/网络错误统一转成可读 Error。 */
async function req(url, options = {}, timeoutMs = 60000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (e) {
    throw new Error(`蒲公英请求失败（${new URL(url).host}）：${e?.name === 'AbortError' ? '超时' : String(e?.message ?? e)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function jsonOf(res, what) {
  let j
  try { j = await res.json() } catch { throw new Error(`${what}：HTTP ${res.status}，响应不是 JSON`) }
  return j
}

/**
 * 上传一个安装包并等待发布完成。
 * @param {object} o
 * @param {string} o.apiKey 蒲公英 API key（调用方从凭据库解析，绝不落日志）
 * @param {'ios'|'android'|'harmony'} o.platform
 * @param {string} o.filePath 安装包绝对路径
 * @param {string} o.updateDesc 更新说明
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{buildKey:string,version:string,buildVersion:string,name:string,url:string,qrcode:string}>}
 */
export async function uploadAndPublish({ apiKey, platform, filePath, updateDesc, log = () => {} }) {
  const channel = PLATFORM_CHANNEL[platform]
  const fileName = path.basename(filePath)
  const stat = await fsp.stat(filePath)
  if (stat.size > 2 * 1024 * 1024 * 1024) throw new Error('安装包超过蒲公英单包 2GB 上限')

  // 1. getCOSToken
  log(`获取上传 token（渠道 ${channel}）…`)
  const form = new URLSearchParams({
    _api_key: apiKey,
    buildType: PLATFORM_BUILD_TYPE[platform],
    buildInstallType: '1',
    buildUpdateDescription: updateDesc || '',
    buildChannelShortcut: channel,
  })
  const tokenRes = await req(`${API}/getCOSToken`, { method: 'POST', body: form }, 30000)
  const token = await jsonOf(tokenRes, 'getCOSToken')
  if (token.code !== 0) {
    throw new Error(`getCOSToken 失败：code=${token.code} ${token.message || ''}${token.code === 1002 ? '（API key 无效，请更新凭据库）' : ''}`)
  }
  const { endpoint, key, params } = token.data

  // 2. 上传文件到 COS（multipart；file 必须是最后一个字段）
  log(`上传 ${fileName}（${(stat.size / 1048576).toFixed(1)} MB）…`)
  const fd = new FormData()
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v))
  fd.append('x-cos-meta-file-name', fileName)
  const buf = await fsp.readFile(filePath)
  fd.append('file', new Blob([buf]), fileName)
  const upRes = await req(endpoint, { method: 'POST', body: fd }, 15 * 60000)
  if (upRes.status !== 204) {
    const text = await upRes.text().catch(() => '')
    throw new Error(`文件上传失败：HTTP ${upRes.status} ${text.slice(0, 300)}`)
  }

  // 3. 轮询 buildInfo 直到发布完成
  log('文件上传完成，等待蒲公英发布…')
  const deadline = Date.now() + 10 * 60000
  for (;;) {
    await new Promise(r => setTimeout(r, 4000))
    const infoRes = await req(`${API}/buildInfo?_api_key=${encodeURIComponent(apiKey)}&buildKey=${encodeURIComponent(key)}`, {}, 30000)
    const info = await jsonOf(infoRes, 'buildInfo')
    if (info.code === 0) {
      const d = info.data
      return {
        buildKey: d.buildKey,
        version: String(d.buildVersion ?? ''),
        buildVersion: String(d.buildBuildVersion ?? ''),
        name: String(d.buildName ?? ''),
        url: `https://www.pgyer.com/${channel}`,
        qrcode: String(d.buildQRCodeURL ?? ''),
      }
    }
    if (info.code === 1246 || info.code === 1247) {
      if (Date.now() > deadline) throw new Error('等待发布超时（10 分钟），请到蒲公英后台确认')
      continue
    }
    throw new Error(`发布失败：code=${info.code} ${info.message || ''}`)
  }
}

/**
 * 鸿蒙：上传与 hap 同源的 P12 证书（蒲公英用它签 manifest.json5）。
 * code=0 且 message 非空表示证书已存但与包签名不一致 → 视为警告返回。
 */
export async function uploadHarmonyCert({ apiKey, buildKey, p12Path, p12Password, log = () => {} }) {
  if (!fs.existsSync(p12Path)) throw new Error(`P12 证书不存在：${p12Path}`)
  log('上传鸿蒙 P12 证书…')
  const fd = new FormData()
  fd.append('_api_key', apiKey)
  fd.append('buildKey', buildKey)
  fd.append('password', p12Password)
  fd.append('file', new Blob([await fsp.readFile(p12Path)]), path.basename(p12Path))
  const res = await req(CERT_API, { method: 'POST', body: fd }, 120000)
  const j = await jsonOf(res, 'uploadHarmonyCert')
  if (j.code !== 0) throw new Error(`P12 证书上传失败：code=${j.code} ${j.message || ''}`)
  return { ok: true, warning: j.message || null }
}