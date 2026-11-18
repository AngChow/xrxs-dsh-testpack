/**
 * 打包前置检查（npm prepack 调用）。
 *
 * 本插件是纯 JS 源码包，没有编译产物，「构建」= 确认要打进 tgz 的文件都在且语法可用：
 *   - 运行时 JS 逐个跑 node --check，语法错误直接拦在打包前；
 *   - 会被读取的 JSON 逐个 JSON.parse；
 *   - package.json 的 files 白名单里每个条目必须真实存在，否则 npm pack 会静默漏打。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const jsFiles = ['index.js', 'client.js', 'lib/pgyer.js', 'lib/builders.js']
const jsonFiles = ['package.json', 'locale/zh.json', 'locale/en.json']
const required = [...jsFiles, ...jsonFiles, 'cordis.patch.yml', 'README.md', 'icon.svg']

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`缺少文件：${file}`)
}

for (const file of jsFiles) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' })
}

for (const file of jsonFiles) JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

for (const entry of pkg.files ?? []) {
  if (entry.includes('*')) continue
  if (!fs.existsSync(path.join(root, entry))) throw new Error(`package.json files 里的条目不存在：${entry}`)
}

console.log(`prepack ok：${required.length} 个文件就位，${jsFiles.length} 个 JS 通过语法检查`)
