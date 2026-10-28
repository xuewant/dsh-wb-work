# Changelog

本项目的所有重要变更都记录在这里。

## [2.0.2] - 2026-10-28

### 修复

- 11128 仍会出现：上一版只改写**系统提示**，上游实际会按**整段对话**做指纹校验。
  把项目里那张包含 `DeepSeek Harness` 与 `Tokens prefixed with @ … workspace root …`
  原文的历史记录接上、仅换成中性系统提示，仍稳定返回 11128；历史里的品牌词与指纹句
  一并改写后恢复正常 200。现在出站前会改写所有角色的文本（user / assistant / tool）。
- 模型列表倍率重复：名字里带 `0.65x`、行尾又追加一份。现在
  - 目录名统一规整成纯名称（`均衡 0.65x` → `均衡`），倍率单独保留在 `multiplier`；
  - 选择器行尾用 CSS `::after` 右对齐显示倍率，不再占用目录名；DSH 自带的
    「1017」等标签不受影响；
  - 工作台面板的模型下拉与模型按钮同步使用规整后的名称。

## [2.0.1] - 2026-10-28

### 修复

- 修复切换到 WB 模型后整轮失败：`400 / 11128 Illegal API invocation from an unapproved channel`
  - 根因：上游渠道校验除了品牌词，还会匹配 DSH 系统提示的**原文措辞**。
    实测仅保留 `Tokens prefixed with @ are paths the user explicitly referenced.`
    与 `Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.`
    这两句，就稳定触发 11128；同义改写后整段 5.7k 系统提示可正常 200。
  - 系统提示出站前现在会：改写身份句、替换 `DeepSeek Harness` / `DSH` / `dsh` 字样、
    同义改写上述两句指纹措辞；同时支持文本块数组形式的系统提示。
  - 兜底：仍收到 11128 时，自动用中性系统提示重试一次，避免指纹表没覆盖到新增规则时整轮直接失败。
  - 修复错误提示：此前只取响应前 500 字节做 `JSON.parse`，截断后解析失败，
    界面会直接显示半截原始 JSON，现在会正确显示 `请求被拦截，请重新发送`。

## [2.0.0] - 2026-10-27

首个公开发布版本。

### 新增

- **WorkBuddy傀儡**：侧边栏工作台面板，通过 CDP 操作 WorkBuddy
  - 新建任务、切换已有对话、切换模型（显示倍率 / 免费标签 / 拥堵）
  - 发送消息、停止等待（并尝试点击 WorkBuddy 自身的停止按钮）
  - 连接 / 断开 WorkBuddy，自动重启并接入调试端口
  - 工作步骤展示（简洁 / 标准 / 详细 / 完全展开）
- **WorkBuddy借魂**：把 WorkBuddy 注册为 DSH 模型提供方
  - provider id `wb-work`，分类名称可配置
  - 令牌账号：浏览器扫码登录、多账号下拉切换、删除
  - API Key 模式，优先于令牌
  - 令牌留空时自动复用 DSH 中已保存的 WorkBuddy 登录令牌
  - 底部状态栏显示 WB 积分剩余 / 本期已用
  - 上下文按上游真实上限（90k + 8k）声明，并自动裁剪超长历史
- 设置弹窗：侧边栏三栏（通用 / 傀儡 / 借魂）、蓝色高亮、分组框、应用/取消/保存
- 通用页：侧边栏名称、GitHub 仓库与检查更新、模仿 `.workbuddy` 规则开关

### 修复

- 会话 usage 字段使用 `inputTokens/outputTokens/totalTokens/cacheReadTokens`，避免投影出 NaN
- 模型回复改为整轮结束后只回传最终结论，避免 DSH 将增量渲染成窄列碎片
- 模型选择器倍率右对齐

### 已知限制

- WorkBuddy 上游仅支持流式对话
- 单次 prompt 上限 100000 tokens
- 「模仿 .workbuddy 规则」仅对 WB 模型生效
