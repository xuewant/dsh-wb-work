/**
 * dhs-wb-work — Host half (standalone WorkBuddy controller).
 *
 * Owns:
 *   - a minimal Chrome DevTools Protocol client (HTTP discovery + WebSocket),
 *   - page scripts that read/click the WorkBuddy renderer,
 *   - settings (work directory, CDP port, step display level),
 *   - a scheduled-task relaunch so WorkBuddy starts with the debugging port.
 *
 * No other plugin is involved. Everything the browser half needs is served
 * from /dhs-wb-work/*.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkbuddyAdapter, workbuddyRulesText } from './provider.js'

export const name = 'dhs-wb-work'
export const inject = ['llm', 'webServer', 'attachments']

const VERSION = '2.0.0'
const PROVIDER_ID = 'wb-work'
const DEFAULTS = {
  port: 0,
  cwd: '',
  stepView: 'standard',
  lastSession: -1,
  lastModel: '',
  pollMs: 900,
  apiKey: '',
  token: '',
  category: 'WB 工作台',
  sidebarName: 'WB 工作台',
  updateRepo: '',
  workbuddyRules: false,
  workbuddyRulesDsh: false,
  showTaskList: true,
  accounts: [],
  activeAccountId: '',
}
const STEP_VIEWS = new Set(['brief', 'standard', 'detailed', 'full'])

/** Model ids WorkBuddy accepts, used until the live menu has been read once. */
const FALLBACK_MODELS = [
  { id: 'fast-model', name: '快速', multiplier: 0.21 },
  { id: 'balanced-model', name: '均衡', multiplier: 0.65 },
  { id: 'deep-model', name: '极致', multiplier: 1.2 },
  { id: 'hy4-preview', name: 'Hy4 preview', multiplier: 0.29, badges: [{ label: '夜间免费' }] },
  { id: 'hy3', name: 'Hy3', multiplier: 0, badges: [{ label: '限时免费' }] },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', multiplier: 0.11, badges: [{ label: '夜间折扣' }] },
  { id: 'step-5-preview', name: 'Step-5-Preview', multiplier: 0.33 },
  { id: 'glm-5.3', name: 'GLM-5.3', multiplier: 0.69 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', multiplier: 0.08 },
  { id: 'glm-5.2', name: 'GLM-5.2', multiplier: 0.79, badges: [{ label: '夜间折扣' }] },
  { id: 'glm-5.1', name: 'GLM-5.1', multiplier: 0.79 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', multiplier: 0.71 },
  { id: 'space-bunny', name: 'Space-Bunny', multiplier: 0.08 },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', multiplier: 0.08 },
  { id: 'minimax-m3', name: 'MiniMax-M3', multiplier: 0.25 },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', multiplier: 0.97 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', multiplier: 1.62 },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', multiplier: 0.77 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', multiplier: 0.51, badges: [{ label: '夜间折扣' }] },
  { id: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6-Pro', multiplier: 0.13 },
]

/* ------------------------------ settings ------------------------------ */

function settingsFile () {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dhs-wb-work', 'settings.json')
}

/** A deterministic port for this machine, stable across restarts. */
function generatedPort () {
  const seed = `${hostname()}|${userInfo().username}|dhs-wb-work`
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return 9300 + (Math.abs(hash) % 80)
}

async function loadSettings () {
  let value = { ...DEFAULTS }
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), 'utf8'))
    for (const key of Object.keys(DEFAULTS)) {
      if (key === 'port') {
        if (Number.isInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535) value.port = parsed.port
      } else if (key === 'lastSession' || key === 'pollMs') {
        if (Number.isFinite(parsed[key])) value[key] = parsed[key]
      } else if (typeof parsed[key] === 'string') {
        value[key] = parsed[key]
      }
    }
    if (Array.isArray(parsed.accounts)) {
      value.accounts = parsed.accounts
        .filter((account) => account && typeof account.token === 'string' && account.token !== '')
        .map((account) => ({
          id: String(account.id || randomUUID()),
          label: String(account.label || 'WorkBuddy'),
          token: account.token,
          createdAt: Number(account.createdAt) || Date.now(),
        }))
    }
    if (typeof parsed.activeAccountId === 'string') value.activeAccountId = parsed.activeAccountId
  } catch {
    /* 首次运行 */
  }
  if (!value.port) value.port = generatedPort()
  return value
}
async function saveSettings (value) {
  const file = settingsFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, file)
}

let providerCatalog = FALLBACK_MODELS
let storedToken = ''

function credentialsFile () {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
}

/** Reuse the WorkBuddy login token DSH already stores for this machine. */
async function loadStoredToken () {
  try {
    const raw = await readFile(credentialsFile(), 'utf8')
    return raw.match(/"accessToken":"([^"]+)"/)?.[1] ?? ''
  } catch {
    return ''
  }
}

/** 「均衡 0.65x」「Hy4 preview 夜间免费 0.29x」这类显示名拆成纯名称 + 倍率。 */
function normalizeModelEntry (entry) {
  if (!entry || typeof entry !== 'object') return entry
  let name = typeof entry.name === 'string' ? entry.name.trim() : ''
  let multiplier = typeof entry.multiplier === 'number' && Number.isFinite(entry.multiplier) ? entry.multiplier : null
  const trailing = name.match(/^(.*?)\s+([\d.]+)\s*x$/i)
  if (trailing && trailing[1].trim() !== '') {
    name = trailing[1].trim()
    if (multiplier === null) multiplier = Number(trailing[2])
  }
  return { ...entry, name: name === '' ? entry.name : name, multiplier }
}

function withNormalizedModels (value) {
  if (!value || !Array.isArray(value.models)) return value
  return { ...value, models: value.models.map(normalizeModelEntry) }
}

function applyCatalog (value) {
  if (!value || !Array.isArray(value.models)) return
  const entries = value.models.filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
  if (entries.length === 0) return
  // 上游模型 id 一律是小写连字符形式；显示名（DeepSeek-V4.1-Flash）不能当 id 用。
  const known = new Map(FALLBACK_MODELS.map((model) => [model.name.toLowerCase(), model.id]))
  providerCatalog = entries.map((entry) => {
    const raw = entry.id
    const byName = known.get(String(entry.name || '').toLowerCase())
    const id = /[A-Z]/.test(raw) && byName ? byName : raw.toLowerCase()
    return normalizeModelEntry({
      id,
      name: entry.name || id,
      multiplier: entry.multiplier,
      badges: entry.badges,
      busyLevel: entry.busyLevel,
    })
  })
}

async function directoryExists (path) {
  if (!path) return null
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/* -------------------------------- CDP -------------------------------- */

class Cdp {
  constructor (wsUrl) {
    this.wsUrl = wsUrl
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
  }

  static async discover (port, timeoutMs = 4000) {
    let response
    try {
      response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new Error(`CDP 端口 ${port} 不可达（${(error && error.message) || error}）`)
    }
    if (!response.ok) throw new Error(`CDP 端口 ${port} 返回 HTTP ${response.status}`)
    const targets = await response.json()
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    if (!page) throw new Error(`CDP 端口 ${port} 上没有 page 目标`)
    return page
  }

  connect (timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl)
      this.socket = socket
      const timer = setTimeout(() => {
        try { socket.close() } catch {}
        reject(new Error('CDP WebSocket 连接超时'))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP WebSocket 连接失败'))
      })
      socket.addEventListener('close', () => {
        for (const { reject: fail } of this.pending.values()) fail(new Error('CDP 连接已关闭'))
        this.pending.clear()
      })
      socket.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        const waiter = message.id ? this.pending.get(message.id) : undefined
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message || 'CDP 调用失败'))
        else waiter.resolve(message.result)
      })
    })
  }

  send (method, params = {}, timeoutMs = 10000) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error('CDP 尚未连接'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
    })
  }

  async evaluate (expression, timeoutMs = 10000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs)
    if (result.exceptionDetails) {
      throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text || '页面脚本抛错')
    }
    return result.result ? result.result.value : undefined
  }

  close () {
    const socket = this.socket
    this.socket = null
    try { if (socket) socket.close() } catch {}
  }
}

let live = null

async function connect (port) {
  if (live && live.port === port && live.cdp.socket && live.cdp.socket.readyState === 1) {
    return live.cdp
  }
  if (live) {
    try { live.cdp.close() } catch {}
    live = null
  }
  const page = await Cdp.discover(port)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  live = { port, cdp, page }
  return cdp
}

function disconnect () {
  if (!live) return
  try { live.cdp.close() } catch {}
  live = null
}

async function withPage (port, task) {
  let cdp = await connect(port)
  try {
    return await task(cdp)
  } catch (error) {
    disconnect()
    cdp = await connect(port)
    return await task(cdp)
  }
}

/* ------------------------------ page scripts ------------------------------ */

const CLEAN = "const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();"

const SEND_CONTROL = `
  const primary = document.querySelector('[data-track-id="agent_session_input_status"]');
  const home = document.querySelector('button[aria-label="发送"]');
  const button = primary || home;
  const disabled = !button || /_customContentDisabled_/.test(String(button.className)) || /wb-button--disabled/.test(String(button.className)) || button.disabled === true || button.getAttribute('aria-disabled') === 'true';
`

const SCRIPT_STATE = `(() => {
  ${CLEAN}
  const editor = document.querySelector('div[contenteditable="true"][data-slate-editor]');
  const label = document.querySelector('.cr-model-selector__trigger-label') || document.querySelector('[class*="_triggerLabel_1cr0m"]');
  const list = document.querySelector('.cr-message-list');
  const containers = [...document.querySelectorAll('[class*="_chatMessageContainer_ttf8p"]')].filter((e) => e.offsetParent);
  ${SEND_CONTROL}
  return {
    ok: true,
    title: document.title,
    composer: Boolean(editor),
    model: label ? clean(label.innerText) : '',
    messageList: Boolean((list && list.offsetParent) || containers.length > 0),
    sendDisabled: button ? disabled : null,
    editing: editor ? clean(editor.innerText).slice(0, 40) : '',
  };
})()`

const SCRIPT_SESSIONS = `(() => {
  ${CLEAN}
  const cards = [...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent);
  return {
    ok: true,
    items: cards.map((card, index) => {
      const titleEl = card.querySelector('[class*="_titleStatic_"], [class*="_title_1ufy3"]');
      const timeEl = card.querySelector('[class*="_time_1ufy3"]');
      return {
        index,
        title: clean(titleEl ? titleEl.innerText : card.innerText).slice(0, 120),
        time: timeEl ? clean(timeEl.innerText) : '',
        selected: /_selected_/.test(String(card.className)),
      };
    }),
  };
})()`

function scriptCardRect (index) {
  return `(() => {
    const cards = [...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent);
    const card = cards[${Number(index)}];
    if (!card) return { ok: false, reason: '会话卡片不存在' };
    card.scrollIntoView({ block: 'center' });
    const rect = card.getBoundingClientRect();
    return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, title: String(card.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
  })()`
}

const SCRIPT_NEW_TASK = `(() => {
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent);
  const tab = buttons.find((b) => /conversation-list-tab-button/.test(String(b.className)) && /新建任务/.test(String(b.innerText || '')));
  const labelled = buttons.find((b) => b.getAttribute('aria-label') === '新建任务' && /conversation/.test(String(b.className)));
  const target = tab || labelled;
  if (!target) return { ok: false, reason: '没有找到侧边栏的「新建任务」' };
  target.click();
  return { ok: true, by: tab ? 'tab' : 'aria' };
})()`

const SCRIPT_MODEL_OPEN = `(() => {
  const menu = document.querySelector('.cr-model-selector__menu, [class*="_popoverList_1cr0m"]');
  if (menu && menu.offsetParent) return { ok: true, alreadyOpen: true };
  const trigger = document.querySelector('button.cr-model-selector__trigger, button[class*="_trigger_1cr0m"]');
  if (trigger && trigger.offsetParent) {
    trigger.click();
    return { ok: true };
  }
  const tab = [...document.querySelectorAll('button.conversation-list-tab-button')].find((b) => /新建任务/.test(String(b.innerText || '')));
  if (tab) {
    tab.click();
    return { ok: false, opening: true, reason: '已切换到新建任务，等待输入框' };
  }
  return { ok: false, reason: 'WorkBuddy 里没有模型选择器，也没有「新建任务」入口' };
})()`

const SCRIPT_MODEL_READ = `(() => {
  ${CLEAN}
  const crList = document.querySelector('[class*="_modelListContainer_1cr0m"], .cr-model-selector__list');
  if (crList && crList.offsetParent) {
    // 列表项元素的 React key 就是上游模型 id（deepseek-v4.1-flash），
    // 而 option.id 可能被填成显示名（DeepSeek-V4.1-Flash），所以以 key 为准。
    const keyedItems = [...crList.children].map((item) => {
      const fiberKey = Object.keys(item).find((key) => key.startsWith('__reactFiber$'));
      let id = '';
      if (fiberKey) {
        let fiber = item[fiberKey];
        for (let guard = 0; fiber && guard < 6; guard += 1) {
          if (typeof fiber.key === 'string' && fiber.key !== '') { id = fiber.key; break; }
          fiber = fiber.return;
        }
      }
      return { item, id };
    }).filter((entry) => entry.id !== '' && !entry.id.startsWith('custom'));
    const models = keyedItems.map(({ item, id }, index) => {
      const iconNode = item.querySelector('.cr-model-selector__item-icon, [class*="_item-icon"]');
      const credits = clean((item.querySelector('.cr-model-selector__item-credits, [class*="credits"]') || {}).innerText || '');
      const domName = clean((item.querySelector('.cr-model-selector__item-name, [class*="item-name"]') || {}).innerText || '');
      const flat = clean(item.innerText || '');
      const firstLine = flat.split('\\n')[0] || '';
      const name = domName || firstLine;
      const match = credits.match(/([\\d.]+)/) || flat.match(/([\\d.]+)\\s*x/i);
      return {
        index,
        id,
        name,
        credits,
        multiplier: match ? Number(match[1]) : null,
        busyLevel: '',
        badges: [],
        selected: /selected|--selected/.test(String(item.className || '')),
        iconHtml: iconNode ? String(iconNode.innerHTML).slice(0, 4000) : '',
        effort: '',
        canDisableThinking: null,
        supportsImages: null,
      };
    }).filter((model) => model.name !== '' && !/自定义模型|配置自定义/.test(model.name));
    if (models.length > 0) return { ok: true, open: true, layout: 'cr', models };
  }
  const list = document.querySelector('[class*="_popoverList_1cr0m"], [class*="_list_19dy6"]');
  if (!list) return { ok: false, open: false, reason: '模型菜单没有打开' };
  const items = [...list.querySelectorAll('[class*="_modelItem_wjpjq"], [class*="_item_19dy6"]')];
  const badgeWords = ['夜间免费', '限时免费', '夜间折扣', '订阅优先', '免费'];
  const models = items.map((item, index) => {
    const label = clean(item.innerText);
    const nameNode = item.querySelector('[class*="_modelName_wjpjq"]');
    const creditsNode = item.querySelector('[class*="_modelCredits_wjpjq"]');
    const iconNode = item.querySelector('[class*="_modelIcon_wjpjq"]');
    const credits = creditsNode ? clean(creditsNode.innerText) : '';
    const match = (credits || label).match(/([\\d.]+)\\s*x/i);
    let name = nameNode ? clean(nameNode.innerText) : label;
    if (!nameNode) {
      const cut = label.match(/([\\d.]+)\\s*x\\s*$/i);
      name = cut ? label.slice(0, cut.index).trim() : label;
      for (const word of badgeWords) if (name.endsWith(word)) { name = name.slice(0, -word.length).trim(); break; }
    }
    const found = [...item.querySelectorAll('[class*="badge"], [class*="tag"]')].map((node) => clean(node.innerText)).filter(Boolean);
    return {
      index,
      name,
      label,
      credits,
      multiplier: match ? Number(match[1]) : null,
      badges: found.map((text) => ({ label: text, color: '', background: '' })),
      busyLevel: '',
      selected: Boolean(item.querySelector('[class*="_modelCheckSlot"] svg, [class*="_modelCheckSlot"] img')),
      iconHtml: iconNode ? String(iconNode.innerHTML).slice(0, 4000) : '',
    };
  });
  return { ok: true, open: true, layout: 'popover', models: models.filter((model) => model.name && !/自定义模型|配置自定义/.test(model.name)) };
})()`

function scriptModelSelect (wanted) {
  return `(() => {
    ${CLEAN}
    const wanted = ${JSON.stringify(String(wanted))}.toLowerCase();
    const items = [...document.querySelectorAll('.cr-model-selector__item, [class*="_modelItem_wjpjq"], [class*="_item_19dy6"]')].filter((e) => e.offsetParent);
    const nameOf = (el) => {
      const node = el.querySelector('.cr-model-selector__item-name');
      return clean(node ? node.innerText : el.innerText);
    };
    const target = items.find((item) => nameOf(item).toLowerCase().includes(wanted));
    if (!target) return { ok: false, reason: '模型菜单里没有：' + ${JSON.stringify(String(wanted))} };
    target.click();
    return { ok: true, label: clean(target.innerText) };
  })()`
}

const SCRIPT_ESCAPE = `(() => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
  document.dispatchEvent(event);
  return { ok: true };
})()`

const SCRIPT_READ = `(() => {
  ${CLEAN}
  const list = document.querySelector('.cr-message-list');
  if (list && list.offsetParent) {
    const nodes = [...list.querySelectorAll('.cr-self-message, .cr-markdown')];
    const messages = [];
    for (const node of nodes) {
      const isUser = node.classList.contains('cr-self-message');
      if (!isUser && node.closest('.cr-self-message')) continue;
      const text = clean(node.innerText);
      if (!text) continue;
      messages.push({ role: isUser ? 'user' : 'assistant', text: text.slice(0, 12000) });
    }
    const fold = list.parentElement ? list.parentElement.querySelector('.avatar-fold-line-clickable') : null;
    return { ok: true, layout: 'cr', total: messages.length, status: fold ? clean(fold.innerText) : '', messages };
  }
  const containers = [...document.querySelectorAll('[class*="_chatMessageContainer_ttf8p"]')].filter((e) => e.offsetParent);
  const box = containers[containers.length - 1];
  if (!box) return { ok: false, reason: '消息区不在当前页面（先打开一个对话）' };
  const nodes = [...box.querySelectorAll('[class*="_userMessage_ttf8p"], .cb-assistant-message')].filter((n) => n.offsetParent);
  const messages = [];
  for (const node of nodes) {
    const isUser = /_userMessage_/.test(String(node.className));
    let text = clean(node.innerText);
    if (!text) continue;
    if (isUser) text = text.replace(/\\s*\\d{1,2}:\\d{2}\\s*$/, '').trim();
    if (!text) continue;
    messages.push({ role: isUser ? 'user' : 'assistant', text: text.slice(0, 12000) });
  }
  const fold = box.querySelector('.avatar-fold-line-clickable');
  return { ok: true, layout: 'ttf', total: messages.length, status: fold ? clean(fold.innerText) : '', messages };
})()`

const SCRIPT_FOCUS_EDITOR = `(() => {
  const editor = document.querySelector('div[contenteditable="true"][data-slate-editor]');
  if (!editor) return { ok: false, reason: '输入框不存在' };
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  return { ok: true };
})()`

const SCRIPT_SEND_STATE = `(() => {
  ${SEND_CONTROL}
  if (!button) return { ok: false, reason: '发送按钮不存在' };
  return { ok: !disabled, disabled };
})()`

const SCRIPT_SEND_CLICK = `(() => {
  ${SEND_CONTROL}
  if (!button) return { ok: false, reason: '发送按钮不存在' };
  if (disabled) return { ok: false, reason: '发送按钮仍是禁用态' };
  button.click();
  return { ok: true };
})()`

/* ------------------------------ operations ------------------------------ */

async function probeState (port) {
  const cdp = await connect(port)
  const page = { title: '', url: '' }
  try {
    const version = await cdp.send('Runtime.evaluate', { expression: '({ title: document.title, url: location.href })', returnByValue: true })
    const value = version.result && version.result.value
    if (value) { page.title = value.title; page.url = value.url }
  } catch {}
  const ui = await cdp.evaluate(SCRIPT_STATE)
  return { ok: true, port, browser: live && live.page ? live.page.title : page.title, page, ui }
}

async function listSessions (port) {
  return await withPage(port, (cdp) => cdp.evaluate(SCRIPT_SESSIONS))
}

async function openSession (port, index) {
  return await withPage(port, async (cdp) => {
    const target = await cdp.evaluate(scriptCardRect(index))
    if (!target || !target.ok) return target || { ok: false, reason: '会话卡片不存在' }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    return { ok: true, index, title: target.title }
  })
}

async function newTask (port) {
  return await withPage(port, (cdp) => cdp.evaluate(SCRIPT_NEW_TASK))
}

async function pressEscape (cdp) {
  try {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  } catch {
    await cdp.evaluate(SCRIPT_ESCAPE).catch(() => {})
  }
}

let modelCache = { port: 0, at: 0, value: null }

async function openModelMenu (cdp) {
  let last = { ok: false, reason: '模型菜单打不开' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opened = await cdp.evaluate(SCRIPT_MODEL_OPEN)
    if (opened && opened.ok) return opened
    last = opened || last
    if (opened && opened.opening) {
      await new Promise((resolve) => setTimeout(resolve, 900))
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return last
}

function modelsFile () {
  return join(dirname(settingsFile()), 'models.json')
}

async function saveModelsCache (value) {
  const file = modelsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ at: Date.now(), layout: value.layout || '', models: value.models || [] })}\n`, { mode: 0o600 })
}

async function loadModelsCache () {
  try {
    return JSON.parse(await readFile(modelsFile(), 'utf8'))
  } catch {
    return null
  }
}

async function listModels (port, force = false) {
  if (!force && modelCache.port === port && modelCache.value && Date.now() - modelCache.at < 60000) {
    return { ...modelCache.value, cached: true, ageMs: Date.now() - modelCache.at }
  }
  let result
  try {
    result = await withPage(port, async (cdp) => {
      const opened = await openModelMenu(cdp)
      if (!opened.ok) return opened
      let value = null
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        value = await cdp.evaluate(SCRIPT_MODEL_READ)
        if (value && value.open) break
      }
      await pressEscape(cdp)
      return value || { ok: false, reason: '模型菜单没有出现' }
    })
  } catch (error) {
    result = { ok: false, reason: String((error && error.message) || error) }
  }
  if (result && result.ok) {
    modelCache = { port, at: Date.now(), value: result }
    applyCatalog(result)
    await saveModelsCache(result).catch(() => {})
    return result
  }
  // 打不开菜单时退回上次落盘的清单，保证「连上就能选」
  const cached = await loadModelsCache()
  if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
    return { ...cached, ok: true, cached: true, stale: true, reason: result && result.reason }
  }
  return result
}

async function setModel (port, wanted) {
  const result = await withPage(port, async (cdp) => {
    const opened = await openModelMenu(cdp)
    if (!opened.ok) return opened
    let clicked = null
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      clicked = await cdp.evaluate(scriptModelSelect(wanted))
      if (clicked && clicked.ok) break
      const read = await cdp.evaluate(SCRIPT_MODEL_READ)
      if (!read || !read.open) continue
    }
    await pressEscape(cdp)
    return clicked || { ok: false, reason: '没有找到该模型' }
  })
  if (result && result.ok) modelCache = { port, at: 0, value: null }
  return result
}

async function readMessages (port, view) {
  const raw = await withPage(port, (cdp) => cdp.evaluate(SCRIPT_READ))
  if (!raw || raw.ok === false) return raw || { ok: false, reason: '读取失败' }
  let messages = raw.messages || []
  if (view === 'brief') {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    messages = lastAssistant ? [lastAssistant] : messages.slice(-1)
  }
  if (view === 'full') {
    messages = messages.map((message) => ({ ...message, text: message.text.slice(0, 40000) }))
  }
  return { ok: true, total: raw.total, status: raw.status, messages }
}

/** Type into the Slate composer through the CDP input domain, then click send. */
const SCRIPT_CLEAR_EDITOR = `(() => {
  const editor = document.querySelector('div[contenteditable="true"][data-slate-editor]');
  if (!editor) return { ok: true };
  editor.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  return { ok: true };
})()`

async function composeAndSend (port, text, options = {}) {
  const cdp = await connect(port)
  const focused = await cdp.evaluate(SCRIPT_FOCUS_EDITOR)
  if (!focused || !focused.ok) return focused || { ok: false, reason: '输入框不可用' }
  await cdp.send('Input.insertText', { text })
  let disabled = true
  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    const state = await cdp.evaluate(SCRIPT_SEND_STATE)
    if (state && state.ok === true) { disabled = false; break }
  }
  if (disabled) {
    await cdp.evaluate(SCRIPT_CLEAR_EDITOR).catch(() => {})
    return { ok: false, reason: '输入后发送按钮仍不可用（可能被应用拒收）' }
  }
  if (options.dryRun) {
    await cdp.evaluate(SCRIPT_CLEAR_EDITOR).catch(() => {})
    return { ok: true, typed: true, dryRun: true }
  }
  const clicked = await cdp.evaluate(SCRIPT_SEND_CLICK)
  return clicked || { ok: false, reason: '点击发送失败' }
}

/* ------------------------------ relaunch ------------------------------ */

function runPowerShell (script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const file = join(tmpdir(), `dhs-wb-work-${process.pid}-${Date.now()}.ps1`)
    try {
      // Windows PowerShell 5.1 把无 BOM 的 .ps1 按 ANSI 读——中文标题会乱码，
      // 所以这里显式写 UTF-8 BOM。
      writeFileSync(file, `\uFEFF$ErrorActionPreference = 'Continue'\n${script}\n`, 'utf8')
    } catch (error) {
      resolve({ ok: false, reason: `写入临时脚本失败：${String(error && error.message)}` })
      return
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      try { unlinkSync(file) } catch {}
      const line = String(stdout).split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.startsWith('{')).pop()
      if (!line) {
        resolve({ ok: false, reason: `PowerShell 没有返回结果（exit ${code}）：${String(stderr || stdout).slice(0, 300)}` })
        return
      }
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, reason: `无法解析 PowerShell 输出：${line.slice(0, 300)}` })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: `无法启动 PowerShell：${String(error && error.message)}` })
    })
  })
}

// small helper so the module can require builtins without an import for each

async function relaunchWorkbuddy (port) {
  const taskName = 'dsh-wb-work-relaunch'
  const flags = [
    `--remote-debugging-port=${port}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ].join(' ')
  const script = `
$task = ${JSON.stringify(taskName)}
$flags = ${JSON.stringify(flags)}
$running = Get-Process WorkBuddy -ErrorAction SilentlyContinue
$exe = $null
foreach ($p in $running) { if ($p.Path -and (Test-Path $p.Path)) { $exe = $p.Path; break } }
if (-not $exe) {
  $keys = @()
  foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
    $keys += Get-ChildItem $root -ErrorAction SilentlyContinue
  }
  foreach ($key in $keys) {
    $item = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if ($item.DisplayName -match 'WorkBuddy') {
      $candidate = [string]$item.DisplayIcon
      if ($candidate) { $candidate = ($candidate -split ',')[0].Trim('"'); if (Test-Path $candidate) { $exe = $candidate; break } }
    }
  }
}
if (-not $exe) {
  foreach ($candidate in @("$env:LOCALAPPDATA\\Programs\\WorkBuddy\\WorkBuddy.exe", "$env:ProgramFiles\\WorkBuddy\\WorkBuddy.exe")) {
    if (Test-Path $candidate) { $exe = $candidate; break }
  }
}
if (-not $exe) { Write-Output '{"ok":false,"reason":"找不到 WorkBuddy.exe"}'; exit }
$wasRunning = [bool]$running
$running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Milliseconds 1200
$left = Get-Process WorkBuddy -ErrorAction SilentlyContinue
if ($left) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1200 }
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $exe -Argument $flags
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
if (-not (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) { Write-Output '{"ok":false,"reason":"计划任务注册失败"}'; exit }
Start-ScheduledTask -TaskName $task
$out = [ordered]@{ ok = $true; exe = $exe; wasRunning = $wasRunning; task = $task }
Write-Output ($out | ConvertTo-Json -Compress)
`
  const result = await runPowerShell(script, 60000)
  if (!result.ok) return result
  const waitMs = Math.max(8000, 40000)
  const started = Date.now()
  for (;;) {
    try {
      await Cdp.discover(port, 2000)
      disconnect()
      return { ...result, port, waitedMs: Date.now() - started }
    } catch {
      if (Date.now() - started > waitMs) {
        return { ...result, ok: false, port, reason: `端口 ${port} 在 ${waitMs} ms 内没有就绪` }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/* ------------------------------ HTTP helpers ------------------------------ */

function sendJson (res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readJson (req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) return finish({ ok: false, reason: '请求体过大' })
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return finish({ ok: true, value: {} })
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, reason: '请求体不是合法 JSON' })
      }
    })
    req.on('error', (error) => finish({ ok: false, reason: String((error && error.message) || error) }))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------ plugin ------------------------------ */

export function apply (ctx) {
  let settings = { ...DEFAULTS }
  let paused = false
  let pendingLogin = null
  let lastModelUsed = ''
  let lastModelAt = 0
  let sendCancelled = false
  let refreshAdapter = () => {}

  /** 自动识别安装来源：优先设置里的仓库，其次插件自身 package.json 的 repository。 */
  async function detectRepo () {
    const configured = String(settings.updateRepo || '').trim()
    if (/^[\w.-]+\/[\w.-]+$/.test(configured)) return configured
    try {
      const own = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      const raw = typeof own?.repository === 'string' ? own.repository : (own?.repository?.url || '')
      const match = String(raw).match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
      if (match) return `${match[1]}/${match[2]}`
    } catch { /* 读不到自己的 package.json */ }
    return ''
  }
  const pausedBody = () => ({ ok: false, paused: true, port: settings.port, reason: '已手动断开 WorkBuddy 连接' })

  const activeAccount = () => (settings.accounts || []).find((account) => account.id === settings.activeAccountId) ?? null
  const activeToken = () => {
    const account = activeAccount()
    return account && typeof account.token === 'string' ? account.token : ''
  }
  const publicConfig = () => ({
    ...settings,
    apiKey: '',
    token: '',
    hasApiKey: settings.apiKey !== '',
    hasToken: settings.token !== '' || activeToken() !== '',
    accounts: (settings.accounts || []).map((account) => ({
      id: account.id,
      label: account.label,
      createdAt: account.createdAt,
      active: account.id === settings.activeAccountId,
      preview: `${account.token.slice(0, 10)}…${account.token.slice(-6)}`,
    })),
  })
  const addAccount = (label, token) => {
    const clean = String(token || '').trim()
    if (clean.length < 20) return null
    const account = { id: randomUUID(), label: String(label || 'WorkBuddy').slice(0, 60), token: clean, createdAt: Date.now() }
    settings = { ...settings, accounts: [...(settings.accounts || []), account], activeAccountId: account.id }
    return account
  }

  const ready = (async () => {
    settings = await loadSettings()
    storedToken = await loadStoredToken()
    try { applyCatalog(await loadModelsCache()) } catch { /* 首次运行没有缓存 */ }
    if ((settings.accounts || []).length === 0 && storedToken !== '') {
      const account = addAccount('WorkBuddy 登录令牌', storedToken)
      if (account !== null) await saveSettings(settings).catch(() => {})
    }
    try {
      const file = join(dirname(settingsFile()), 'activated.json')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify({ at: Date.now(), pid: process.pid, version: VERSION, port: settings.port })}\n`, { mode: 0o600 })
    } catch {}
  })()

  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res, next) => {
      try {
        await ready
        const out = await handler(req)
        if (!out) {
          if (typeof next === 'function') return next()
          return sendJson(res, 404, { ok: false, error: 'not found' })
        }
        sendJson(res, out.status || 200, out.body)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  route('/dhs-wb-work/config', async (req) => {
    if (req.method === 'GET') {
      return { body: { ok: true, ...publicConfig(), suggestedPort: generatedPort(), exists: await directoryExists(settings.cwd), settingsFile: settingsFile() } }
    }
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'GET or POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const body = parsed.value || {}
    const next = { ...settings }
    if (typeof body.cwd === 'string') next.cwd = body.cwd.slice(0, 4096).trim()
    if (typeof body.category === 'string') next.category = body.category.trim().slice(0, 60)
    if (typeof body.sidebarName === 'string') next.sidebarName = body.sidebarName.trim().slice(0, 40)
    if (typeof body.updateRepo === 'string') next.updateRepo = body.updateRepo.trim().slice(0, 120)
    if (typeof body.workbuddyRules === 'boolean') next.workbuddyRules = body.workbuddyRules
    if (typeof body.workbuddyRulesDsh === 'boolean') next.workbuddyRulesDsh = body.workbuddyRulesDsh
    if (typeof body.showTaskList === 'boolean') next.showTaskList = body.showTaskList
    if (typeof body.apiKey === 'string' && body.apiKey !== '') next.apiKey = body.apiKey.trim().slice(0, 8192)
    if (body.clearApiKey === true) next.apiKey = ''
    if (typeof body.token === 'string' && body.token !== '') next.token = body.token.trim().slice(0, 16384)
    if (typeof body.stepView === 'string' && STEP_VIEWS.has(body.stepView)) next.stepView = body.stepView
    if (typeof body.lastModel === 'string') next.lastModel = body.lastModel.slice(0, 200)
    if (Number.isFinite(body.lastSession)) next.lastSession = Math.trunc(body.lastSession)
    if (body.port !== undefined) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { status: 400, body: { ok: false, error: '端口必须是 1024-65535 的整数' } }
      if (port !== next.port) { next.port = port; disconnect() }
    }
    settings = next
    await saveSettings(settings)
    refreshAdapter()
    return { body: { ok: true, ...settings, suggestedPort: generatedPort(), exists: await directoryExists(settings.cwd) } }
  })

  route('/dhs-wb-work/token/login', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'CLI/2.171.0 CodeBuddy/2.171.0',
      'x-product': 'SaaS',
      'x-ide-type': 'CLI',
      'x-ide-name': 'CodeBuddy',
      'x-ide-version': '2.171.0',
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    }
    try {
      const response = await fetch('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI', { method: 'POST', headers, body: '{}' })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.code !== 0 || !body?.data?.authUrl) {
        return { body: { ok: false, reason: body?.message || body?.msg || `HTTP ${response.status}` } }
      }
      const state = String(body.data.state || '')
      const authUrl = String(body.data.authUrl)
      try {
        spawn('rundll32.exe', ['url.dll,FileProtocolHandler', authUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } catch { /* 浏览器没打开也不影响继续轮询 */ }
      pendingLogin = { state, authUrl, at: Date.now() }
      return { body: { ok: true, state, authUrl } }
    } catch (error) {
      return { body: { ok: false, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/token/poll', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const state = String(parsed.value?.state || pendingLogin?.state || '')
    if (state === '') return { body: { ok: false, reason: '没有正在等待的登录' } }
    const baseHeaders = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'CLI/2.171.0 CodeBuddy/2.171.0',
      'x-product': 'SaaS',
      'x-ide-type': 'CLI',
      'x-ide-name': 'CodeBuddy',
      'x-ide-version': '2.171.0',
    }
    try {
      const response = await fetch(`https://copilot.tencent.com/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
        headers: { ...baseHeaders, 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' },
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.code !== 0 || !body?.data?.accessToken) {
        if (response.status === 401 || response.status === 403) {
          return { body: { ok: false, reason: body?.message || body?.msg || '登录被拒绝' } }
        }
        return { body: { ok: true, pending: true } }
      }
      const auth = body.data
      let label = 'WorkBuddy'
      try {
        const accountResponse = await fetch(`https://copilot.tencent.com/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
          headers: {
            ...baseHeaders,
            authorization: `Bearer ${auth.accessToken}`,
            'X-No-User-Id': 'true',
            'X-No-Enterprise-Id': 'true',
            'X-No-Department-Info': 'true',
          },
        })
        const accountBody = await accountResponse.json().catch(() => null)
        const account = accountBody?.data
        label = account?.displayName || account?.nickname || account?.userId || label
      } catch { /* 账号信息拿不到就用默认备注 */ }
      addAccount(String(label), auth.accessToken)
      await saveSettings(settings)
      pendingLogin = null
      return { body: { ok: true, ...publicConfig() } }
    } catch (error) {
      return { body: { ok: false, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/token/open-login', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', 'https://www.codebuddy.cn/'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return { body: { ok: true } }
    } catch (error) {
      return { body: { ok: false, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/token/import', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    storedToken = await loadStoredToken()
    if (!storedToken) return { body: { ok: false, reason: 'DSH 里没有找到 WorkBuddy 登录令牌' } }
    addAccount('WorkBuddy 登录令牌', storedToken)
    await saveSettings(settings)
    return { body: { ok: true, ...publicConfig() } }
  })

  route('/dhs-wb-work/token/add', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const account = addAccount(parsed.value?.label, parsed.value?.token)
    if (account === null) return { body: { ok: false, reason: '令牌至少 20 个字符' } }
    await saveSettings(settings)
    return { body: { ok: true, ...publicConfig() } }
  })

  route('/dhs-wb-work/token/remove', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const id = String(parsed.value?.id || '')
    const accounts = (settings.accounts || []).filter((account) => account.id !== id)
    const activeAccountId = settings.activeAccountId === id ? (accounts[0]?.id ?? '') : settings.activeAccountId
    settings = { ...settings, accounts, activeAccountId }
    await saveSettings(settings)
    return { body: { ok: true, ...publicConfig() } }
  })

  route('/dhs-wb-work/token/active', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const id = String(parsed.value?.id || '')
    if (!(settings.accounts || []).some((account) => account.id === id)) return { body: { ok: false, reason: '账号不存在' } }
    settings = { ...settings, activeAccountId: id }
    await saveSettings(settings)
    return { body: { ok: true, ...publicConfig() } }
  })

  route('/dhs-wb-work/credits', async () => {
    const token = activeToken() || settings.token || storedToken
    if (token === '') return { body: { ok: false, reason: '没有可用的 WorkBuddy 令牌' } }
    try {
      const now = new Date()
      const end = new Date(now.getTime())
      end.setFullYear(end.getFullYear() + 101)
      const format = (date) => {
        const pad = (value) => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      }
      const host = 'https://www.codebuddy.cn'
      const response = await fetch(`${host}/v2/billing/meter/get-user-resource`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-client-platform': 'web',
          origin: host,
          referer: `${host}/profile/plans-usage`,
          authorization: `Bearer ${token}`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
          'x-domain': host,
        },
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3],
          PackageEndTimeRangeBegin: format(now),
          PackageEndTimeRangeEnd: format(end),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const body = await response.json().catch(() => null)
      const accounts = body?.data?.Response?.Data?.Accounts ?? body?.data?.data?.Response?.Data?.Accounts ?? body?.data?.accounts ?? []
      let remaining = 0
      let total = 0
      for (const account of accounts) {
        const remain = Number(account.CycleCapacityRemainPrecise ?? account.CycleCapacityRemain ?? account.CapacityRemainPrecise ?? account.CapacityRemain ?? 0)
        const size = Number(account.CycleCapacitySizePrecise ?? account.CycleCapacitySize ?? account.CapacitySizePrecise ?? account.CapacitySize ?? 0)
        if (Number.isFinite(remain)) remaining += remain
        if (Number.isFinite(size)) total += size
      }
      return {
        body: {
          ok: true,
          remaining: Number(remaining.toFixed(2)),
          total: Number(total.toFixed(2)),
          used: Number(Math.max(0, total - remaining).toFixed(2)),
          model: lastModelUsed,
          active: lastModelAt > 0 && Date.now() - lastModelAt < 3600000,
          at: Date.now(),
        },
      }
    } catch (error) {
      return { body: { ok: false, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/update', async (req) => {
    let repo = String(settings.updateRepo || '').trim()
    if (req.method === 'POST') {
      const parsed = await readJson(req)
      if (parsed.ok && typeof parsed.value?.repo === 'string' && parsed.value.repo.trim() !== '') repo = parsed.value.repo.trim()
    }
    if (repo === '') repo = await detectRepo()
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { body: { ok: false, reason: '无法识别安装来源的 GitHub 仓库，请在设置里填写 owner/repo' } }
    }
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dhs-wb-work' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        const reason = response.status === 404
          ? '该仓库还没有发布 Release（或仓库地址不对）'
          : `GitHub 返回 HTTP ${response.status}`
        return { body: { ok: false, repo, reason } }
      }
      const release = await response.json()
      const latest = String(release.tag_name || release.name || '').replace(/^v/i, '')
      return {
        body: {
          ok: true,
          repo,
          current: VERSION,
          latest,
          name: release.name || release.tag_name || '',
          notes: String(release.body || '').slice(0, 8000),
          url: release.html_url || '',
          publishedAt: release.published_at || '',
          hasUpdate: latest !== '' && latest !== VERSION,
        },
      }
    } catch (error) {
      return { body: { ok: false, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/cancel', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    sendCancelled = true
    return { body: { ok: true } }
  })

  route('/dhs-wb-work/stop', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    sendCancelled = true
    const script = `(() => {
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      for (const el of document.querySelectorAll('button[aria-label], button[title]')) {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '')).trim()
        if (/停止|stop/i.test(label) && !el.disabled && visible(el)) { el.click(); return { ok: true, via: 'label', label } }
      }
      for (const el of document.querySelectorAll('button')) {
        const cls = String(el.className || '')
        if (/stop/i.test(cls) && !el.disabled && visible(el)) { el.click(); return { ok: true, via: 'class', cls: cls.slice(0, 60) } }
      }
      return { ok: false, reason: '没有找到停止按钮' }
    })()`
    try {
      const stopped = await withPage(settings.port, (cdp) => cdp.evaluate(script))
      return { body: { ok: true, stopped } }
    } catch (error) {
      return { body: { ok: true, stopped: { ok: false, reason: String((error && error.message) || error) } } }
    }
  })

  route('/dhs-wb-work/rules', async () => {
    const text = await workbuddyRulesText(settings.cwd)
    return { body: { ok: true, text, cwd: settings.cwd } }
  })

  route('/dhs-wb-work/state', async () => {
    if (paused) return { body: { ...pausedBody(), canRelaunch: true } }
    try {
      const state = await probeState(settings.port)
      return { body: { ...state, canRelaunch: true } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, canRelaunch: true, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/sessions', async () => {
    if (paused) return { body: pausedBody() }
    try {
      return { body: { ok: true, port: settings.port, ...(await listSessions(settings.port)) } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/models', async (req) => {
    if (paused) return { body: pausedBody() }
    const force = String(req.url || '').includes('force=1')
    try {
      return { body: { ok: true, port: settings.port, ...withNormalizedModels(await listModels(settings.port, force)) } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/catalog', async () => {
    return { body: { ok: true, models: providerCatalog } }
  })

  route('/dhs-wb-work/read', async (req) => {
    if (paused) return { body: pausedBody() }
    const view = STEP_VIEWS.has(settings.stepView) ? settings.stepView : 'standard'
    try {
      return { body: { ok: true, port: settings.port, view, ...(await readMessages(settings.port, view)) } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, view, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/open', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const index = Number(parsed.value && parsed.value.index)
    if (!Number.isInteger(index) || index < 0) return { status: 400, body: { ok: false, error: 'index 无效' } }
    try {
      const result = await openSession(settings.port, index)
      return { body: { ok: true, port: settings.port, ...result } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/model', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const parsed = await readJson(req)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.reason } }
    const wanted = parsed.value && parsed.value.name
    if (typeof wanted !== 'string' || !wanted.trim()) return { status: 400, body: { ok: false, error: 'name 必填' } }
    try {
      const result = await setModel(settings.port, wanted)
      if (result && result.ok) {
        settings = { ...settings, lastModel: wanted }
        await saveSettings(settings)
      }
      return { body: { ok: Boolean(result && result.ok), port: settings.port, ...result } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/new-task', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    try {
      const result = await newTask(settings.port)
      return { body: { ok: Boolean(result && result.ok), port: settings.port, ...result } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/focus', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    try {
      const cdp = await connect(settings.port)
      try { await cdp.send('Page.bringToFront') } catch {}
      return { body: { ok: true, port: settings.port } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/connect', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    paused = false
    // 端口已经开着就直接连，只有连不上才重启 WorkBuddy。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await Cdp.discover(settings.port, 2500)
        const state = await probeState(settings.port)
        if (state && state.ok) {
          return { body: { ok: true, restarted: false, port: settings.port, state } }
        }
      } catch {
        /* 端口没响应，下一轮或重启 */
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    try {
      const result = await relaunchWorkbuddy(settings.port)
      return { body: { restarted: true, port: settings.port, ...result } }
    } catch (error) {
      return { body: { ok: false, restarted: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/disconnect', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    paused = true
    disconnect()
    return { body: { ok: true, paused: true, port: settings.port } }
  })

  route('/dhs-wb-work/relaunch', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    try {
      const result = await relaunchWorkbuddy(settings.port)
      return { body: { port: settings.port, ...result } }
    } catch (error) {
      return { body: { ok: false, port: settings.port, reason: String((error && error.message) || error) } }
    }
  })

  route('/dhs-wb-work/pick-folder', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST only' } }
    const initial = String(settings.cwd || '').replace(/'/g, "''")
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WbFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    public class FileOpenDialogRCW { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName(out IntPtr pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem shellItem);

    public static string Pick(string title, string initial)
    {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        dialog.SetOptions(0x20u | 0x40u | 0x800u);
        dialog.SetTitle(title);
        if (!string.IsNullOrEmpty(initial))
        {
            try
            {
                IShellItem folder;
                Guid iid = typeof(IShellItem).GUID;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                if (folder != null) dialog.SetFolder(folder);
            }
            catch { }
        }
        if (dialog.Show(IntPtr.Zero) != 0) return null;
        IShellItem result;
        dialog.GetResult(out result);
        string path;
        result.GetDisplayName(0x80058000u, out path);
        return path;
    }
}
"@ | Out-Null
$picked = [WbFolderPicker]::Pick('选择工作路径', '${initial}')
if ($picked) {
  $out = [ordered]@{ ok = $true; path = $picked }
  Write-Output ($out | ConvertTo-Json -Compress)
} else {
  Write-Output '{"ok":false,"cancelled":true}'
}
`
    const result = await runPowerShell(script, 180000)
    if (result && result.ok && typeof result.path === 'string' && result.path) {
      settings = { ...settings, cwd: result.path }
      await saveSettings(settings)
      return { body: { ok: true, path: settings.cwd, exists: await directoryExists(settings.cwd) } }
    }
    return { body: { ok: false, cancelled: Boolean(result && result.cancelled), reason: (result && result.reason) || '没有选择目录' } }
  })

  // streaming send
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dhs-wb-work/send',
    handler: async (req, res) => {
      await ready
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const parsed = await readJson(req, 200000)
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.reason })
      const body = parsed.value || {}
      const text = String(body.text || '').trim()
      if (!text) return sendJson(res, 400, { ok: false, error: 'text 必填' })
      sendCancelled = false

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      let closed = false
      const write = (event, data) => {
        if (closed) return
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { closed = true }
      }
      req.on('close', () => { closed = true })

      try {
        write('start', { port: settings.port, chars: text.length, view: settings.stepView })
        if (body.model) {
          const applied = await setModel(settings.port, body.model)
          write('model', { ok: Boolean(applied && applied.ok), label: applied && applied.label, reason: applied && applied.reason })
        }
        if (body.newTask) {
          const created = await newTask(settings.port)
          write('newTask', created)
          await sleep(900)
        } else if (Number.isInteger(body.index) && body.index >= 0) {
          const opened = await openSession(settings.port, body.index)
          write('opened', opened)
          await sleep(900)
        }

        const sent = await composeAndSend(settings.port, text, { dryRun: Boolean(body.dryRun) })
        write('sent', sent)
        if (!sent || !sent.ok) {
          write('error', { message: (sent && sent.reason) || '发送失败' })
          write('done', { ok: false })
          res.end()
          return
        }
        if (body.dryRun) {
          write('done', { ok: true, dryRun: true })
          res.end()
          return
        }

        // Sending from the home composer creates a conversation; make sure the
        // message view is actually on screen before polling it.
        for (let i = 0; i < 12; i += 1) {
          const now = await probeState(settings.port).catch(() => null)
          if (now && now.ui && now.ui.messageList) break
          await sleep(400)
        }
        try {
          const now = await probeState(settings.port)
          if (!now.ui || !now.ui.messageList) {
            const sessionsNow = await listSessions(settings.port)
            const selected = (sessionsNow.items || []).find((item) => item.selected)
            if (selected) {
              await openSession(settings.port, selected.index)
              write('opened', { index: selected.index, title: selected.title })
              await sleep(900)
            }
          }
        } catch { /* 打不开就继续轮询消息区 */ }

        const anchorText = text.slice(0, 24)
        const pollMs = Math.min(3000, Math.max(400, Number(body.pollMs) || settings.pollMs || 900))
        const maxMs = Math.min(600000, Math.max(20000, Number(body.maxMs) || 600000))
        let last = ''
        let anchored = false
        let idle = 0
        const startedAt = Date.now()
        while (!closed && Date.now() - startedAt < maxMs) {
          if (sendCancelled) {
            write('cancelled', {})
            break
          }
          await sleep(pollMs)
          let current
          try {
            current = await readMessages(settings.port, 'full')
          } catch {
            continue
          }
          if (!current || current.ok === false) continue
          const messages = current.messages || []
          let anchor = -1
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'user' && messages[i].text.includes(anchorText)) { anchor = i; break }
          }
          if (anchor < 0) { idle += 1; continue }
          if (!anchored) { anchored = true; write('anchor', { index: anchor, total: messages.length }) }
          const after = messages.slice(anchor + 1).filter((message) => message.role === 'assistant')
          const now = after.length ? after[after.length - 1].text : ''
          if (now.length > last.length && now.startsWith(last)) {
            write('delta', { text: now.slice(last.length) })
            last = now
            idle = 0
          } else if (now && now !== last) {
            write('replace', { text: now })
            last = now
            idle = 0
          } else {
            idle += 1
            if (idle >= Math.max(6, Math.ceil(6000 / pollMs)) && last) break
            if (idle >= Math.max(15, Math.ceil(20000 / pollMs)) && !last) {
              write('error', { message: '已发送，但界面没有出现回复（可能仍在思考）' })
              break
            }
          }
        }
        modelCache = { port: 0, at: 0, value: null }
        write('done', { ok: true, chars: last.length })
        res.end()
      } catch (error) {
        write('error', { message: String((error && error.message) || error) })
        write('done', { ok: false })
        try { res.end() } catch {}
      }
    },
  }))

  const buildAdapter = () => new WorkbuddyAdapter({
    getConfig: () => ({
      apiKey: settings.apiKey,
      token: settings.token || activeToken() || storedToken,
      category: settings.category,
      cwd: settings.cwd,
      workbuddyRules: settings.workbuddyRules === true,
      showTaskList: settings.showTaskList !== false,
      // 图片块只带 attachmentId，需要通过附件服务取出原始字节。
      readImage: (ref) => ctx.attachments.readImage(ref),
    }),
    getModels: () => providerCatalog,
    noteModel: (model) => { lastModelUsed = model; lastModelAt = Date.now() },
  })
  let disposeAdapter = null
  const startAdapter = () => {
    disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], buildAdapter())
  }
  refreshAdapter = () => {
    try { disposeAdapter?.() } catch { /* 旧注册可能已释放 */ }
    disposeAdapter = null
    startAdapter()
    try { ctx.emit?.('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }
  }
  // 必须等配置从磁盘读完后才注册：providerInfo 在注册时就会取分类名。
  ready.then(startAdapter).catch(() => { try { startAdapter() } catch { /* llm 不可用 */ } })
  ctx.effect(() => () => {
    try { disposeAdapter?.() } catch { /* 已释放 */ }
  })
}
