# dhs-wb-work

在 DSH（DeepSeek Harness）里使用 WorkBuddy：**一个插件，两个能力**。

1. **WorkBuddy傀儡** — 侧边栏工作台面板，通过 CDP 操作本机 WorkBuddy：新建任务、切换已有对话、切换模型、收发消息、停止生成。
2. **WorkBuddy借魂** — 把 WorkBuddy 注册成 DSH 的模型提供方（provider id：`wb-work`），在 DSH 模型选择器里以可配置的分类名出现，模型名会带上积分倍率、免费标签与拥堵状态；支持令牌账号（浏览器扫码登录）或 API Key。

## 功能

### 工作台面板

- 侧边栏入口（名称可在设置里改）；
- 对话下拉：列出 WorkBuddy 侧边栏里的对话，选中即打开；
- 模型下拉：列出模型名 + `倍率x` + 免费标签 + 拥堵条，选中即切换；
- 新建任务、发送消息、停止等待（并尝试点击 WorkBuddy 自身的停止按钮）；
- 工作步骤展示（简洁 / 标准 / 详细 / 完全展开）；
- 连接 / 断开 WorkBuddy，自动重启并接入调试端口。

### 模型提供方

- 新 provider：`wb-work`，分类名称可自定义，设置后出现在 DSH 模型选择器；
- 模型显示名只带「免费标签 / 拥堵」，积分倍率在选择器行尾右对齐单独显示（不再重复出现在名字里）；
- 凭据二选一：**令牌账号**（浏览器扫码登录，支持多账号下拉切换）或 **API Key**；
- 令牌留空时自动复用 DSH 中已保存的 WorkBuddy 登录令牌；
- 底部状态栏显示 **WB 积分剩余 / 本期已用**（仅在使用 WB 模型时出现）；
- 上下文按上游真实上限声明（90k 上下文 + 8k 输出），并带超长自动裁剪保护。

## 环境要求

- DSH `web` 或 `desktop` profile（0.2.x）；
- 本机安装 WorkBuddy 桌面版（默认 CDP 端口 9330，可在设置里改）；
- Node.js ≥ 20。

## 安装

```powershell
dsh plugin --profile {profile} add {path}
```

其中 `{profile}` 是 `web` 或 `desktop`，`{path}` 是插件目录或 tarball 路径。

或手动：

1. 把本目录复制到 `{DSH_HOME}\profiles\{profile}\node_modules\dhs-wb-work`；
2. 在该 profile 的 `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dhs-wb-work"`；
3. 刷新页面（`Ctrl+R`），侧边栏出现工作台入口。

> 直接放进 `node_modules` 而不写进 `dependencies` 时，后续 `pnpm install` 可能清掉它；长期使用建议 `link:` 安装或用 `npm pack` 打 tarball。

## 设置

设置弹窗分三栏：

| 栏目 | 内容 |
| --- | --- |
| **通用** | 侧边栏名称、GitHub 仓库（检查更新）、模仿 WorkBuddy 的 `.workbuddy` 规则 |
| **WorkBuddy傀儡** | CDP 调试端口、重启应用端口、工作步骤展示 |
| **WorkBuddy借魂** | 模型分类名称、令牌账号（扫码登录 / 下拉切换 / 删除）、API Key |

底部按钮：**应用**（保存但不关窗）、**取消**（不保存）、**保存**（保存并关闭）。

### 令牌登录

点「添加账号」会调用 WorkBuddy 的 plugin 登录接口，在浏览器打开 `copilot.tencent.com/login` 扫码页；登录成功后新账号会自动出现在下拉框并设为当前。

### API Key

填了 API Key 就优先使用；留空时使用当前令牌账号。

### 模仿 `.workbuddy` 规则

开启后，WB 模型每轮对话会读取**工作路径**下：

- `.workbuddy/workbuddy.md`
- `.workbuddy/memory/*.md`
- `.workbuddy/skills/*/SKILL.md`

注入系统提示，让模型按 WorkBuddy 的约定做事。注意：该能力由 WB provider 实现，仅对 WB 模型生效。

## 数据与隐私

- 设置与令牌保存在 `{DSH_HOME}\dhs-wb-work\settings.json`（权限 0600），**不会**上传到任何地方；
- 聊天内容会发送给 WorkBuddy 的 `copilot.tencent.com` 接口，与 WorkBuddy 客户端自身行为一致；
- 插件不读取 WorkBuddy 的本地数据库，只通过 CDP 与官方 HTTP 接口交互。

## 已知限制

- 上游只支持**流式**对话，非流式请求会被拒绝；
- 上游存在渠道校验（`11128 Illegal API invocation from an unapproved channel`）：除品牌词外，还会匹配 DSH 系统提示的原文措辞。插件已改写身份句、`DeepSeek Harness` / `DSH` 字样与已知指纹句，并在仍失败时用中性系统提示自动重试一次；上游新增规则时仍可能需要更新插件；
- 单次 prompt 上限 100000 tokens，插件按 90k 声明并自动裁剪超长历史；
- 停止按钮依赖 WorkBuddy 页面上的停止控件，若其 DOM 变化可能找不到（此时只会停止面板等待）；
- 「模仿 .workbuddy 规则」仅对 WB 模型生效，DSH 自有模型无法注入。

## 开发

```
package.json        bundle 元数据 + dsh.client 声明
cordis.patch.yml    插入 id: dhs-wb-work
index.js            Host：路由、CDP 控制、模型提供方注册、设置读写
provider.js         WorkBuddy 模型适配器（流式 / 工具调用 / usage）
client.js           Client：面板、模型下拉、设置弹窗、积分徽标
locale/{zh,en}.json 插件管理页标题与描述
icon.svg            侧边栏图标
```

修改 `client.js` 后刷新页面；修改 `index.js` / `provider.js` 需要让 profile 重新组合（例如调整 bundles 顺序再恢复），或重启 DSH。

## 更新检查

在「通用」里填写 `owner/repo`，点「检查更新」即可读取 GitHub Releases 的最新版本与更新说明。

## License

MIT
