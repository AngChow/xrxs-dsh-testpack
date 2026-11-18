# xrxs-dsh-testpack

DeepSeek Harness（DSH）插件：**三端测试包一条龙** —— iOS / Android / 鸿蒙（HarmonyOS）打测试包并自动上传[蒲公英](https://www.pgyer.com)固定内测渠道。

只做测试包分发，不做商店提审。

| 平台 | 构建方式 | 蒲公英渠道（固定） |
|---|---|---|
| iOS | `bundle exec fastlane gym`（Debug + development 导出） | `pgyer.com/ios_inner_test` |
| Android | `./gradlew clean assembleDebug` | `pgyer.com/android_inner_test` |
| 鸿蒙 | `devecocli build`（innerTest 签名）→ 上传 signed.hap → 按需上传同源 P12 证书 | `pgyer.com/harmony_inner_test` |

## 功能

- **三个 agent 工具**
  - `testpack_doctor`：免费体检（不打包不上传）——项目路径、构建工具链、凭据配置状态、鸿蒙签名材料与 Profile 类型校验
  - `testpack_run`：后台任务打包 + 上传，同平台不并发；体检有 issues 直接拒绝启动
  - `testpack_status`：非消费式读取任务进度 / 结果 / 分发链接
- **配置页**（插件 → 三端测试包 → 配置）
  - 三平台项目路径、Scheme / Gradle 参数 / 鸿蒙 Product 等表单，保存即热生效
  - 蒲公英 API key、鸿蒙 P12 密码录入（password 输入框，只进 DSH 凭据库，永不回显）
  - 一键体检，每平台「就绪 / 有问题」徽章 + 具体问题清单
- **上传器**：蒲公英官方「快速上传」三步流程（getCOSToken → COS multipart → 轮询 buildInfo），业务码失败明确报错；鸿蒙包发布后先查「证书列表」，**已有同一张 P12 就跳过上传**，没有才调 `uploadHarmonyCert`（蒲公英用它签 manifest.json5，华为安装校验必需）。证书上传失败但账户已有证书时降级为警告，不再把整次发布判失败
- **安全**：凭据只存 DSH 凭据库（`credentialRef`），配置与日志零明文；任务输出统一脱敏

## 安装

要求：macOS + DSH desktop/web profile（`engines.dsh >=0.2.0-rc.1 <0.3.0-0`）。

DSH **插件管理 → 添加插件** 选择本目录；或让 agent 执行 `plugin_manager install_bundle`。

```bash
git clone https://github.com/AngChow/xrxs-dsh-testpack.git
cd xrxs-dsh-testpack && npm install   # 仅 schemastery 一个运行时依赖
```

## 配置

安装后在 **插件 → 三端测试包 → 配置** 里改；默认值见 `cordis.patch.yml`：

```yaml
config:
  pgyerApiKeyRef: PGYER_API_KEY        # 蒲公英 key 的凭据库引用名
  ios:
    projectRoot: /path/to/mobile-ios   # 含 <scheme>.xcworkspace
    scheme: XinRen
    configuration: Debug               # Debug / Release / Gray
    exportMethod: development          # 对应 fastlane/ExportOptionPlist/<method>.plist
  android:
    projectRoot: /path/to/mobile-android
    gradleArgs: clean assembleDebug    # 产物自动取 app/build/outputs 下最新 apk
  harmony:
    projectRoot: /path/to/mobile_harmony
    product: innerTest                 # build-profile.json5 里的 product 名
    buildMode: debug
    p12Path: /path/to/xrxs.p12         # 留空用 product 签名配置的 storeFile
    p12PasswordRef: PGYER_HARMONY_P12_PASSWORD
    forceCertUpload: false             # true 表示每次发布都强制重传 P12（换证书后用）
```

> 蒲公英的 P12 证书按**账户/应用**保存，不是按版本：同一张证书传一次就够，之后上传 hap 时不会再要求上传。插件默认会先查证书列表，命中同 CN 证书即跳过；换证书后把 `forceCertUpload` 置 `true` 传一次，再改回 `false`。

渠道短链写死在代码里（`lib/pgyer.js` 的 `PLATFORM_CHANNEL`），换团队使用时改这里。

### 凭据（插件 → 三端测试包 → 配置 页录入，值只进 DSH 凭据库）

| Key | 内容 |
|---|---|
| `PGYER_API_KEY` | 蒲公英 API key（[后台 API 信息页](https://www.pgyer.com/manager/api)，32 位） |
| `PGYER_HARMONY_P12_PASSWORD` | 鸿蒙签名 P12 的**原始密码**（非 DevEco 加密串） |

## 各平台前置要求

- **iOS**：Xcode + bundler/fastlane（项目里 `bundle install`）；自动签名团队已登录、PLA 已同意；测试机 UDID 已注册
- **Android**：JDK（建议 17+）+ 项目 gradlew 可用。Apple Silicon 注意：老版 Room 注解处理器依赖的 sqlite-jdbc 无 arm64 native，需在 `annotationProcessor` classpath 强制 `org.xerial:sqlite-jdbc:3.45+`
- **鸿蒙**（蒲公英硬性规定，doctor 会解析 p7b 前置拦截）：
  1. **发布证书**（.p12）——调试证书不行
  2. **「指定设备发布」（internaltesting）类型 Profile**（.p7b），内含测试机 UDID——调试 Profile 和上架用 `app_gallery` Profile 都不行
  3. 在 `build-profile.json5` 新建 innerTest 签名配置指向上述材料，product 挂该签名配置
  4. 测试机用**华为自带浏览器**打开分发页安装（仅支持纯血 HarmonyOS NEXT）

## 使用

会话里直接说「打个 iOS / Android / 鸿蒙测试包」，agent 会 doctor → run → status 全自动；分发链接出现在任务结果里。

## 已知限制

- 蒲公英单包上限 2 GB；鸿蒙暂不支持元服务、多 hap、外部 hsp 依赖
- Android 若工程开了 abi splits，产物是单架构 split（arm64-v8a），x86 模拟器装不上
- 鸿蒙新增测试机需到 AGC 注册 UDID 并**重新生成 Profile**（设备名单签死在 p7b 里）
- 后台任务随 DSH 进程存续，重启后任务不恢复

## License

MIT