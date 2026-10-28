/**
 * dhs-wb-work — Client half (standalone).
 *
 * Sidebar entry + full-screen workbench. The page keeps two choices in the
 * composer — task and model — plus one settings button. The model picker is a
 * custom list (icon, name, free-period badge, congestion bars, right-aligned
 * credit multiplier, selected check), mirroring WorkBuddy's own menu.
 */
window.__ModuleLoader__.load({
  id: 'dhs-wb-work',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dhs-wb-work:workbench';
    const API = '/dhs-wb-work';
    let panelLabel = 'WB 工作台';

    const T = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      radius: 'var(--dsw-radius-md, 8px)',
    };
    const FONT = "var(--dsw-font-family, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif)";

    const STEP_VIEWS = [
      ['brief', '简洁', '只显示最新一条回复'],
      ['standard', '标准', '显示完整对话'],
      ['detailed', '详细', '附带任务状态与耗时'],
      ['full', '完全展开', '原文不截断，最多 4 万字'],
    ];

    const BUSY = {
      congested: { bars: 3, color: '#e5484d', text: '拥堵' },
      busy: { bars: 2, color: '#e5484d', text: '繁忙' },
      normal: { bars: 1, color: '#f0a441', text: '正常' },
      idle: { bars: 0, color: '', text: '空闲' },
      unknown: { bars: 0, color: '', text: '未知' },
    };

    /** 按下时的「玻璃蒙版 + 蓝色高亮」。 */
    const GLASS_PRESS = {
      background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)',
      borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)',
      boxShadow: '0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.35)',
      backdropFilter: 'blur(8px)',
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function getJson(url) {
      const response = await fetch(url, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    /* ---------------- 模型选择器：倍率放行尾右对齐 ----------------
     * DSH 的模型行是「名字 + 右侧对勾」，没有额外的右侧栏位；名字由提供方目录决定。
     * 这里用 CSS 给 wb-work 的行加一个 ::after，把倍率推到名字末端（对勾之前），
     * 这样目录名里不用再带一份 «0.65x»。选择器自带的「1017」标签等不受影响。
     */
    const MULTIPLIER_STYLE_ID = 'dhs-wb-work-model-multiplier';
    const MULTIPLIER_BASE_CSS = [
      '[data-provider-id="wb-work"][data-model-id]{display:flex;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap}',
      '[data-provider-id="wb-work"][data-model-id]::after{margin-left:auto;flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1}',
    ].join('');

    function multiplierCss(models) {
      const rules = [MULTIPLIER_BASE_CSS];
      for (const model of Array.isArray(models) ? models : []) {
        if (!model || typeof model.id !== 'string' || typeof model.multiplier !== 'number' || !Number.isFinite(model.multiplier)) continue;
        const id = model.id.replace(/["\\]/g, '');
        if (id === '') continue;
        rules.push(`[data-provider-id="wb-work"][data-model-id="${id}"]::after{content:"${model.multiplier.toFixed(2)}x"}`);
      }
      return rules.join('\n');
    }

    function installMultiplierStyles(models) {
      if (typeof document === 'undefined' || !document.head) return;
      let tag = document.getElementById(MULTIPLIER_STYLE_ID);
      if (!tag) {
        tag = document.createElement('style');
        tag.id = MULTIPLIER_STYLE_ID;
        tag.dataset.plugin = 'dhs-wb-work';
        document.head.appendChild(tag);
      }
      tag.textContent = multiplierCss(models);
    }

    function refreshMultiplierStyles() {
      return getJson(API + '/catalog')
        .then((data) => installMultiplierStyles(data && data.models))
        .catch(() => { /* 拿不到目录就保持现有规则 */ });
    }

    async function streamSend(body, onEvent, signal) {
      const response = await fetch(API + '/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let reason = text;
        try { reason = JSON.parse(text).error || text; } catch { /* plain */ }
        throw new Error(reason || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { onEvent(event, JSON.parse(data)); } catch { /* 半截帧 */ }
        }
      }
    }

    /* ------------------------------ small parts ------------------------------ */

    function IconBtn({ children, title, onClick, disabled, primary, active, large }) {
      const size = large ? 40 : 32;
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        disabled,
        onClick,
        style: {
          width: size,
          height: size,
          flex: `0 0 ${size}px`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          border: `1px solid ${primary ? T.accent : active ? T.borderStrong : T.border}`,
          background: primary ? T.accent : active ? T.layer2 : 'transparent',
          color: primary ? '#fff' : T.dim,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          padding: 0,
        },
      }, children);
    }

    /** 带按压反馈的按钮：按下（或 active）时显示玻璃蓝高亮。 */
    const PressButton = React.forwardRef(function PressButton(props, ref) {
      const { children, style, active, disabled, ...rest } = props;
      const [pressed, setPressed] = React.useState(false);
      const highlighted = Boolean(active || pressed) && !disabled;
      return h('button', {
        ref,
        type: 'button',
        disabled,
        onPointerDown: () => setPressed(true),
        onPointerUp: () => setPressed(false),
        onPointerLeave: () => setPressed(false),
        onPointerCancel: () => setPressed(false),
        onBlur: () => setPressed(false),
        ...rest,
        style: {
          transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
          ...style,
          ...(highlighted ? GLASS_PRESS : null),
        },
      }, children);
    });

    function Pill({ tone, children, onClick, title }) {
      const color = tone === 'ok' ? T.ok : tone === 'warn' ? T.warn : tone === 'error' ? T.error : T.dim;
      return h('span', {
        onClick,
        title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 9px',
          borderRadius: 999,
          border: `1px solid ${color}`,
          color,
          font: `11.5px ${FONT}`,
          lineHeight: 1.4,
          cursor: onClick ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
        },
      }, h('span', { style: { width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' } }), children);
    }

    function fieldStyle() {
      return {
        width: '100%',
        height: 32,
        boxSizing: 'border-box',
        borderRadius: 6,
        border: `1px solid ${T.borderStrong}`,
        background: T.layer1,
        color: T.text,
        font: `12.5px ${FONT}`,
        padding: '0 9px',
        outline: 'none',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.04)',
      };
    }

    function labelStyle() {
      return { font: `11.5px ${FONT}`, color: T.dim, marginBottom: 4, display: 'block' };
    }

    /** 设置页统一用蓝色高亮与分组框。 */
    const BLUE = '#2563eb';
    const sectionBox = {
      background: T.layer2,
      border: `1px solid ${T.borderStrong}`,
      borderRadius: 12,
      padding: 14,
      marginBottom: 14,
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    };

    function ModelIcon({ model, size }) {
      const box = { width: size, height: size, flex: `0 0 ${size}px`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: T.text, overflow: 'hidden' };
      if (model && model.iconHtml) {
        return h('span', { style: box, dangerouslySetInnerHTML: { __html: model.iconHtml } });
      }
      const letter = model && model.name ? model.name.replace(/[^A-Za-z\u4e00-\u9fa5]/g, '').slice(0, 1).toUpperCase() : '?';
      return h('span', {
        style: { ...box, borderRadius: 5, background: T.layer2, font: `600 ${Math.round(size * 0.6)}px ${FONT}`, color: T.dim },
      }, letter);
    }

    function BadgeChip({ badge }) {
      if (!badge || !badge.label) return null;
      const color = badge.color || T.dim;
      const background = badge.background || 'transparent';
      return h('span', {
        style: {
          padding: '1px 6px',
          borderRadius: 999,
          border: `1px solid ${color}33`,
          background,
          color,
          font: `10.5px ${FONT}`,
          lineHeight: 1.5,
          whiteSpace: 'nowrap',
        },
      }, badge.label);
    }

    function BusyBars({ level }) {
      const info = BUSY[level] || BUSY.unknown;
      if (!info.bars) return null;
      return h('span', {
        title: `拥堵：${info.text}`,
        style: { display: 'inline-flex', alignItems: 'flex-end', gap: 1.5, height: 11, flex: '0 0 auto' },
      }, [0, 1, 2].map((index) => h('span', {
        key: index,
        style: {
          width: 2,
          height: 4 + index * 3,
          borderRadius: 1,
          background: index < info.bars ? info.color : T.border,
          opacity: index < info.bars ? 1 : 0.5,
        },
      })));
    }

    function Popover({ children, style, onClose }) {
      // The panel is absolutely positioned inside the composer (position:
      // relative); the fixed backdrop only closes it on an outside click.
      return h(React.Fragment, null,
        h('div', { onClick: onClose, style: { position: 'fixed', inset: 0, zIndex: 30 } }),
        h('div', {
          style: {
            position: 'absolute',
            background: T.bg,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            boxShadow: '0 14px 40px rgba(0,0,0,0.22)',
            zIndex: 31,
            overflow: 'hidden',
            ...style,
          },
        }, children));
    }

    /* ------------------------------ panel ------------------------------ */

    function Workbench() {
      const [config, setConfig] = React.useState(null);
      const [state, setState] = React.useState(null);
      const [sessions, setSessions] = React.useState([]);
      const [models, setModels] = React.useState([]);
      const [messages, setMessages] = React.useState([]);
      const [input, setInput] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [busyLabel, setBusyLabel] = React.useState('');
      const [streamText, setStreamText] = React.useState('');
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [tab, setTab] = React.useState('workbench');
      const [modelTab, setModelTab] = React.useState('token');
      const [tokenForm, setTokenForm] = React.useState(false);
      const [tokenLabel, setTokenLabel] = React.useState('WorkBuddy');
      const [tokenValue, setTokenValue] = React.useState('');
      const [tokenBusy, setTokenBusy] = React.useState(false);
      const [loginPending, setLoginPending] = React.useState(null);
      const [updateInfo, setUpdateInfo] = React.useState(null);
      const [updateError, setUpdateError] = React.useState('');
      const [draft, setDraft] = React.useState({ port: '', stepView: 'standard', category: 'WB 工作台', sidebarName: 'WB 工作台', updateRepo: '', workbuddyRules: false, workbuddyRulesDsh: false, showTaskList: true, apiKey: '', token: '' });
      const [saving, setSaving] = React.useState(false);
      const [modelOpen, setModelOpen] = React.useState(false);
      const [modelAnchor, setModelAnchor] = React.useState(null);
      const [sessionOpen, setSessionOpen] = React.useState(false);
      const [sessionAnchor, setSessionAnchor] = React.useState(null);
      const [disconnectOpen, setDisconnectOpen] = React.useState(false);
      const [disconnectAnchor, setDisconnectAnchor] = React.useState(null);
      const [modelsLoading, setModelsLoading] = React.useState(false);
      const [picking, setPicking] = React.useState(false);

      const busyRef = React.useRef(false);
      const listRef = React.useRef(null);
      const modelBtnRef = React.useRef(null);
      const sendAbortRef = React.useRef(null);
      const sessionBtnRef = React.useRef(null);
      const connectBtnRef = React.useRef(null);
      busyRef.current = busy;

      const flash = (text) => {
        setNote(text);
        window.setTimeout(() => setNote(''), 4000);
      };

      const loadConfig = React.useCallback(async () => {
        const data = await getJson(API + '/config');
        setConfig(data);
        setDraft({
          port: String(data.port || ''),
          stepView: data.stepView || 'standard',
          category: data.category || 'WB 工作台',
          sidebarName: data.sidebarName || 'WB 工作台',
          updateRepo: data.updateRepo || '',
          workbuddyRules: data.workbuddyRules === true,
          workbuddyRulesDsh: data.workbuddyRulesDsh === true,
          showTaskList: data.showTaskList !== false,
          apiKey: data.apiKey || '',
          token: data.token || '',
        });
        panelLabel = data.sidebarName || 'WB 工作台';
        return data;
      }, []);

      const refresh = React.useCallback(async (quiet, withModels) => {
        try {
          const stateData = await getJson(API + '/state');
          setState(stateData);
          if (!stateData.ok) {
            if (!quiet) setError(stateData.reason || 'WorkBuddy 不可达');
            return;
          }
          const sessionData = await getJson(API + '/sessions').catch(() => null);
          const readData = await getJson(API + '/read').catch(() => null);
          if (sessionData && Array.isArray(sessionData.items)) setSessions(sessionData.items);
          if (readData && Array.isArray(readData.messages) && !busyRef.current) setMessages(readData.messages);
          if (withModels) {
            const modelData = await getJson(API + '/models').catch(() => null);
            if (modelData && Array.isArray(modelData.models)) setModels(modelData.models);
          }
          if (!quiet) setError('');
        } catch (failure) {
          if (!quiet) setError(String((failure && failure.message) || failure));
        }
      }, []);

      React.useEffect(() => {
        loadConfig().then(() => refresh(true, true)).catch((failure) => setError(String((failure && failure.message) || failure)));
      }, [loadConfig, refresh]);

      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (busyRef.current) return;
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          refresh(true, false);
        }, 8000);
        return () => window.clearInterval(timer);
      }, [refresh]);

      React.useEffect(() => {
        const node = listRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages.length, streamText]);

      const connected = Boolean(state && state.ok);
      const stateModel = state && state.ui && state.ui.model ? String(state.ui.model) : '';
      const currentName = (config && config.lastModel) || stateModel;
      const currentModel = models.find((entry) => entry.name === currentName) || null;

      const openModels = async (force) => {
        const button = modelBtnRef.current;
        if (button) {
          const rect = button.getBoundingClientRect();
          const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
          const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
          const width = Math.min(440, Math.max(320, viewportWidth - 24));
          const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
          setModelAnchor({ left, bottom: viewportHeight - rect.top + 6, width });
        }
        setModelOpen(true);
        setModelsLoading(true);
        try {
          const data = await getJson(API + '/models' + (force ? '?force=1' : ''));
          if (Array.isArray(data.models)) setModels(data.models);
          else if (!data.ok) setError(data.reason || '读取模型失败');
          refreshMultiplierStyles();
        } catch (failure) {
          setError(`读取模型失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setModelsLoading(false);
        }
      };

      const openSessions = async () => {
        const button = sessionBtnRef.current;
        if (button) {
          const rect = button.getBoundingClientRect();
          const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
          const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
          const width = Math.min(380, Math.max(280, viewportWidth - 24));
          const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
          setSessionAnchor({ left, bottom: viewportHeight - rect.top + 6, width });
        }
        setSessionOpen(true);
        try {
          const data = await getJson(API + '/sessions');
          if (Array.isArray(data.items)) setSessions(data.items);
        } catch {
          /* 列表刷新失败就沿用现有缓存 */
        }
      };

      const chooseSession = async (index) => {
        setSessionOpen(false);
        if (index < 0) {
          await postJson(API + '/config', { lastSession: -1 }).catch(() => null);
          setConfig((current) => (current ? { ...current, lastSession: -1 } : current));
          return;
        }
        await openSession(index);
      };

      const importToken = async () => {
        setError('');
        try {
          const data = await postJson(API + '/token/import', {});
          if (!data.ok) throw new Error(data.reason || '没有可导入的令牌');
          setConfig(data);
          flash('已导入 DSH 登录令牌');
        } catch (failure) {
          setError(`导入失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const startLogin = async () => {
        setError('');
        try {
          const data = await postJson(API + '/token/login', {});
          if (!data.ok) throw new Error(data.reason || '无法创建登录会话');
          setLoginPending({ state: data.state, at: Date.now() });
          setTokenForm(false);
          flash('已打开浏览器，请完成登录');
        } catch (failure) {
          setError(`登录失败：${String((failure && failure.message) || failure)}`);
        }
      };

      React.useEffect(() => {
        if (!loginPending) return undefined;
        let stopped = false;
        const timer = setInterval(async () => {
          if (stopped) return;
          if (Date.now() - loginPending.at > 300000) {
            setLoginPending(null);
            setError('登录超时，请重试');
            return;
          }
          try {
            const data = await postJson(API + '/token/poll', { state: loginPending.state });
            if (data.ok && Array.isArray(data.accounts)) {
              setConfig(data);
              setLoginPending(null);
              flash('账号已添加');
            } else if (!data.ok) {
              setError(`登录失败：${data.reason || '未知错误'}`);
              setLoginPending(null);
            }
          } catch { /* 轮询抖动忽略 */ }
        }, 1500);
        return () => { stopped = true; clearInterval(timer); };
      }, [loginPending]);

      const addToken = async () => {
        setTokenBusy(true);
        setError('');
        try {
          const data = await postJson(API + '/token/add', { label: tokenLabel, token: tokenValue });
          if (!data.ok) throw new Error(data.reason || '添加失败');
          setConfig(data);
          setTokenValue('');
          setTokenForm(false);
          flash('令牌已添加');
        } catch (failure) {
          setError(`添加失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setTokenBusy(false);
        }
      };

      const removeToken = async (id) => {
        setError('');
        try {
          const data = await postJson(API + '/token/remove', { id });
          if (data.ok) {
            setConfig(data);
            flash('已删除账号');
          }
        } catch (failure) {
          setError(`删除失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const setTokenActive = async (id) => {
        setError('');
        try {
          const data = await postJson(API + '/token/active', { id });
          if (data.ok) {
            setConfig(data);
            flash('已切换账号');
          }
        } catch (failure) {
          setError(`切换失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const checkUpdate = async () => {
        setError('');
        setUpdateError('');
        setUpdateInfo(null);
        try {
          const data = await postJson(API + '/update', {});
          if (!data.ok) throw new Error(data.reason || '检查失败');
          setUpdateInfo(data);
        } catch (failure) {
          setUpdateError(String((failure && failure.message) || failure));
        }
      };

      const copyRules = async () => {
        setError('');
        try {
          const data = await postJson(API + '/rules', {});
          if (!data.ok || !data.text) throw new Error('没有可复制的规则（先设置工作路径）');
          await navigator.clipboard.writeText(data.text);
          flash('已复制规则，粘贴到对话开头即可');
        } catch (failure) {
          setError(`复制规则失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const saveSettings = async (close = true) => {
        setSaving(true);
        setError('');
        try {
          const port = Number(draft.port);
          const data = await postJson(API + '/config', {
            port,
            stepView: draft.stepView,
            category: draft.category,
            sidebarName: draft.sidebarName,
            updateRepo: draft.updateRepo,
            workbuddyRules: draft.workbuddyRules === true,
            workbuddyRulesDsh: draft.workbuddyRulesDsh === true,
            showTaskList: draft.showTaskList !== false,
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
            ...(draft.token ? { token: draft.token } : {}),
          });
          setConfig(data);
          panelLabel = data.sidebarName || panelLabel;
          if (close) setSettingsOpen(false);
          const portChanged = data.port !== Number((config && config.port) || 0);
          flash(portChanged ? '已保存；端口变了，点「重启 WorkBuddy」让它生效' : (close ? '设置已保存' : '已应用（弹窗保持打开）'));
          await refresh(true, portChanged);
        } catch (failure) {
          setError(`保存设置失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setSaving(false);
        }
      };

      const openSession = async (index) => {
        if (index < 0) return;
        setError('');
        try {
          const data = await postJson(API + '/open', { index });
          if (!data.ok) throw new Error(data.reason || '打开失败');
          await postJson(API + '/config', { lastSession: index }).catch(() => null);
          setConfig((current) => (current ? { ...current, lastSession: index } : current));
          await sleep(900);
          const readData = await getJson(API + '/read');
          if (Array.isArray(readData.messages)) setMessages(readData.messages);
        } catch (failure) {
          setError(`打开对话失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const pickModel = async (name) => {
        if (!name) return;
        setModelOpen(false);
        setError('');
        try {
          const data = await postJson(API + '/model', { name });
          if (!data.ok) throw new Error(data.reason || '切换失败');
          setConfig((current) => (current ? { ...current, lastModel: name } : current));
          flash(`已切换模型：${name}`);
        } catch (failure) {
          setError(`切换模型失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const createTask = async () => {
        setError('');
        setBusy(true);
        setBusyLabel('新建对话…');
        try {
          const data = await postJson(API + '/new-task', {});
          if (!data.ok) throw new Error(data.reason || '新建失败');
          setMessages([]);
          setStreamText('');
          await postJson(API + '/config', { lastSession: -1 }).catch(() => null);
          setConfig((current) => (current ? { ...current, lastSession: -1 } : current));
          await sleep(800);
          await refresh(true, true);
          flash('已新建对话');
        } catch (failure) {
          setError(`新建对话失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setBusy(false);
          setBusyLabel('');
        }
      };

      const relaunch = async () => {
        if (!window.confirm('重启会关闭当前 WorkBuddy 窗口（会话已落盘），确定继续？')) return;
        setError('');
        setBusy(true);
        setBusyLabel('重启 WorkBuddy…（最多约 40 秒）');
        try {
          const data = await postJson(API + '/relaunch', {});
          if (!data.ok) throw new Error(data.reason || '端口未就绪');
          await refresh(true, true);
          flash('WorkBuddy 已带调试端口重启');
        } catch (failure) {
          setError(`重启失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setBusy(false);
          setBusyLabel('');
        }
      };

      const connectWorkbuddy = async () => {
        setError('');
        setBusy(true);
        setBusyLabel('正在连接 WorkBuddy…');
        try {
          const data = await postJson(API + '/connect', {});
          if (!data.ok) throw new Error(data.reason || '没有连接上 WorkBuddy');
          await refresh(true, true);
          flash(data.restarted ? '已连接 WorkBuddy（端口未开，已自动重启）' : '已连接 WorkBuddy');
        } catch (failure) {
          setError(`连接失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setBusy(false);
          setBusyLabel('');
        }
      };

      const toggleConnect = () => {
        if (!connected) {
          connectWorkbuddy();
          return;
        }
        const button = connectBtnRef.current;
        if (button) {
          const rect = button.getBoundingClientRect();
          const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
          const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
          const width = 170;
          const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
          setDisconnectAnchor({ left, bottom: viewportHeight - rect.top + 6, width });
        }
        setDisconnectOpen((value) => !value);
      };

      const disconnectWorkbuddy = async () => {
        setDisconnectOpen(false);
        setError('');
        try {
          await postJson(API + '/disconnect', {});
          await refresh(true, true);
          flash('已断开 WorkBuddy 连接');
        } catch (failure) {
          setError(`断开失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const focusWindow = async () => {
        try {
          await postJson(API + '/focus', {});
          flash('已把 WorkBuddy 调到前台');
        } catch (failure) {
          setError(`聚焦失败：${String((failure && failure.message) || failure)}`);
        }
      };
      void focusWindow;

      const pickFolder = async () => {
        setError('');
        setPicking(true);
        try {
          const data = await postJson(API + '/pick-folder', {});
          if (data.ok && data.path) {
            setConfig((current) => ({ ...(current || {}), cwd: data.path }));
            flash(`工作目录：${data.path}`);
          } else if (!data.cancelled) {
            setError(data.reason || '没有选择目录');
          }
        } catch (failure) {
          setError(`选择目录失败：${String((failure && failure.message) || failure)}`);
        } finally {
          setPicking(false);
        }
      };

      const clearFolder = async () => {
        try {
          const data = await postJson(API + '/config', { cwd: '' });
          setConfig(data);
          flash('已清除工作目录');
        } catch (failure) {
          setError(`清除失败：${String((failure && failure.message) || failure)}`);
        }
      };

      const send = async () => {
        const text = input.trim();
        if (!text || busy || !connected) return;
        const body = { text };
        if (config && config.cwd) body.text = `工作目录：${config.cwd}\n\n${text}`;
        if (currentName) body.model = currentName;
        if (config && Number.isInteger(config.lastSession) && config.lastSession >= 0) body.index = config.lastSession;

        setBusy(true);
        setBusyLabel('发送中…');
        setError('');
        setStreamText('');
        setInput('');
        setMessages((current) => [...current, { role: 'user', text }]);
        const controller = new AbortController();
        sendAbortRef.current = controller;
        try {
          await streamSend(body, (event, payload) => {
            if (event === 'delta' && payload && payload.text) setStreamText((current) => current + payload.text);
            else if (event === 'replace' && payload && payload.text) setStreamText(payload.text);
            else if (event === 'error') setError((payload && payload.message) || 'WorkBuddy 返回错误');
            else if (event === 'cancelled') flash('已停止等待回复');
            else if (event === 'sent' && payload && payload.ok === false) setError(payload.reason || '发送失败');
            else if (event === 'model' && payload && payload.ok === false) flash('模型切换失败，已按当前模型发送');
          }, controller.signal);
        } catch (failure) {
          if (!controller.signal.aborted) setError(`发送失败：${String((failure && failure.message) || failure)}`);
        } finally {
          sendAbortRef.current = null;
          setBusy(false);
          setBusyLabel('');
          setStreamText('');
          await sleep(600);
          await refresh(true, false);
        }
      };

      const cancelSend = async () => {
        try {
          if (sendAbortRef.current) sendAbortRef.current.abort();
          const result = await postJson(API + '/stop', {});
          flash(result && result.stopped && result.stopped.ok ? '已停止' : '已停止等待（WorkBuddy 未找到停止按钮）');
        } catch {
          flash('已停止');
        }
      };

      const renderMessage = (message, index) => {
        const isUser = message.role === 'user';
        return h('div', {
          key: `m${index}`,
          style: { display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 4, maxWidth: '100%' },
        },
          h('span', { style: { font: `10.5px ${FONT}`, color: T.dim, padding: '0 4px' } }, isUser ? '我' : 'WorkBuddy'),
          h('div', {
            style: {
              maxWidth: '88%',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: isUser ? T.layer2 : T.layer1,
              border: `1px solid ${isUser ? T.borderStrong : T.border}`,
              borderRadius: 12,
              padding: '9px 12px',
              font: `13px ${FONT}`,
              color: T.text,
              lineHeight: 1.6,
            },
          }, message.text));
      };

      const currentSession = config && Number.isInteger(config.lastSession)
        ? sessions.find((item) => item.index === config.lastSession)
        : null;
      const sessionLabel = currentSession ? currentSession.title : '当前对话';
      const activeSession = Boolean(config && Number.isInteger(config.lastSession) && config.lastSession >= 0);
      const modelLabel = currentModel ? currentModel.name : currentName || '选择模型';

      const sessionRowStyle = (active) => ({
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        border: 0,
        background: active ? T.layer2 : 'transparent',
        color: T.text,
        font: `12.5px ${FONT}`,
        cursor: 'pointer',
        textAlign: 'left',
      });

      const sessionPool = [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: `1px solid ${T.border}` },
        },
          h('span', { style: { font: `11.5px ${FONT}`, color: T.dim } }, '对话'),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: openSessions,
            style: { border: 0, background: 'transparent', color: T.dim, font: `11.5px ${FONT}`, cursor: 'pointer' },
          }, '刷新'),
        ),
        h('div', { style: { maxHeight: 380, overflowY: 'auto', padding: '4px 0' } },
          h('button', {
            type: 'button',
            onClick: () => chooseSession(-1),
            style: sessionRowStyle(!activeSession),
          },
            h('span', { style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '（当前对话）'),
            !activeSession
              ? h('span', { style: { color: T.accent, fontWeight: 600, width: 14, textAlign: 'center' } }, '✓')
              : h('span', { style: { width: 14 } }),
          ),
          sessions.map((item) => {
            const active = Boolean(config && config.lastSession === item.index);
            return h('button', {
              key: `s${item.index}`,
              type: 'button',
              onClick: () => chooseSession(item.index),
              style: sessionRowStyle(active),
            },
              h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' } },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
                item.time ? h('span', { style: { color: T.dim, font: `10.5px ${FONT}` } }, item.time) : null),
              active
                ? h('span', { style: { color: T.accent, fontWeight: 600, width: 14, textAlign: 'center' } }, '✓')
                : h('span', { style: { width: 14 } }),
            );
          }),
        ),
      ];

      const modelPool = [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: `1px solid ${T.border}` },
        },
          h('span', { style: { font: `11.5px ${FONT}`, color: T.dim } }, '模型'),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: () => openModels(true),
            style: { border: 0, background: 'transparent', color: T.dim, font: `11.5px ${FONT}`, cursor: 'pointer' },
          }, modelsLoading ? '读取中…' : '刷新'),
        ),
        h('div', { style: { maxHeight: 380, overflowY: 'auto', padding: '4px 0' } },
          models.map((entry) => {
            const active = entry.name === currentName;
            return h('button', {
              key: entry.index,
              type: 'button',
              onClick: () => pickModel(entry.name),
              style: {
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                border: 0,
                background: active ? T.layer2 : 'transparent',
                color: T.text,
                font: `12.5px ${FONT}`,
                cursor: 'pointer',
                textAlign: 'left',
              },
            },
              h(ModelIcon, { model: entry, size: 18 }),
              h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 } }, entry.name),
              (entry.badges || []).slice(0, 1).map((badge, badgeIndex) => h(BadgeChip, { key: badgeIndex, badge })),
              h(BusyBars, { level: entry.busyLevel }),
              h('span', { style: { color: T.dim, font: `11.5px ${FONT}`, whiteSpace: 'nowrap', marginLeft: 'auto' } }, entry.multiplier == null ? '—' : `${entry.multiplier.toFixed(2)}x`),
              active ? h('span', { style: { color: T.accent, fontWeight: 600, width: 14, textAlign: 'center' } }, '✓') : h('span', { style: { width: 14 } }),
            );
          }),
        ),
      ];

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          padding: '16px 20px 18px',
          boxSizing: 'border-box',
          background: T.bg,
          color: T.text,
          font: `13px ${FONT}`,
        },
      },
        /* header */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingBottom: 10 } },
          h('span', { style: { font: `600 15px ${FONT}` } }, 'WB 工作台'),
          h(Pill, {
            tone: connected ? 'ok' : (state && state.paused ? 'warn' : 'error'),
            title: '点击刷新',
            onClick: () => refresh(false, true),
          }, connected
            ? `CDP ${state.port}${stateModel ? ` · ${stateModel}` : ''}`
            : (state && state.paused ? '已断开 WorkBuddy' : `端口 ${config ? config.port : '…'} 未监听`)),
          h('div', { style: { flex: 1 } }),
        ),

        /* messages */
        h('div', {
          ref: listRef,
          style: {
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '6px 2px 12px',
          },
        },
          messages.length === 0 && !streamText
            ? h('div', { style: { margin: 'auto', color: T.dim, font: `12.5px ${FONT}`, textAlign: 'center', lineHeight: 1.8 } },
              connected ? h('div', null, '选择或新建一个对话，然后直接输入任务。') : h('div', null, 'WorkBuddy 还没有带上调试端口。', h('br'), '点下方「连接 WorkBuddy」。'))
            : null,
          messages.map(renderMessage),
          streamText
            ? h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
              h('span', { style: { font: `10.5px ${FONT}`, color: T.dim, padding: '0 4px' } }, 'WorkBuddy'),
              h('div', {
                style: {
                  maxWidth: '88%',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: T.layer1,
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  padding: '9px 12px',
                  font: `13px ${FONT}`,
                  lineHeight: 1.6,
                },
              }, streamText))
            : null,
          busy && !streamText
            ? h('div', { style: { color: T.dim, font: `11.5px ${FONT}`, padding: '2px 4px' } }, busyLabel || '处理中…')
            : null,
        ),

        /* composer */
        h('div', {
          style: {
            flexShrink: 0,
            position: 'relative',
            border: `1px solid ${T.borderStrong}`,
            borderRadius: 16,
            background: T.layer1,
            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)',
            padding: '10px 12px 8px',
          },
        },
          h('textarea', {
            value: input,
            placeholder: connected ? '今天帮你做些什么？' : 'WorkBuddy 未连接',
            disabled: !connected || busy,
            rows: 3,
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'none',
              border: 0,
              outline: 'none',
              background: 'transparent',
              color: T.text,
              font: `13.5px ${FONT}`,
              lineHeight: 1.6,
              padding: '2px 2px 8px',
              minHeight: 58,
            },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(PressButton, {
              title: config && config.cwd ? `工作路径：${config.cwd}（点击重新选择）` : '选择工作路径',
              onClick: pickFolder,
              disabled: busy || picking,
              active: picking,
              style: {
                height: 30,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '0 10px',
                borderRadius: 999,
                border: `1px solid ${config && config.cwd ? T.borderStrong : T.border}`,
                background: config && config.cwd ? T.layer2 : 'transparent',
                color: T.text,
                font: `12px ${FONT}`,
                cursor: busy || picking ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.5 : 1,
                whiteSpace: 'nowrap',
              },
            },
              h('svg', { viewBox: '0 0 16 16', width: 14, height: 14 },
                h('path', { d: 'M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.4 1.6H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 })),
              h('span', null, '工作路径')),
            h(PressButton, {
              title: '新建任务',
              onClick: createTask,
              disabled: !connected || busy,
              style: {
                height: 30,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '0 10px',
                borderRadius: 999,
                border: `1px solid ${T.border}`,
                background: 'transparent',
                color: T.text,
                font: `12px ${FONT}`,
                cursor: !connected || busy ? 'not-allowed' : 'pointer',
                opacity: !connected || busy ? 0.5 : 1,
                whiteSpace: 'nowrap',
              },
            },
              h('svg', { viewBox: '0 0 16 16', width: 14, height: 14 },
                h('path', { d: 'M13.5 7.5a5.2 5.2 0 0 1-5.2 5.2H4.2L2 14.5V7.5a5.2 5.2 0 0 1 5.2-5.2h1.1a5.2 5.2 0 0 1 5.2 5.2Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
                h('path', { d: 'M8 5v4M6 7h4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })),
              h('span', null, '新建任务')),
            h(PressButton, {
              ref: sessionBtnRef,
              onClick: openSessions,
              disabled: !connected || busy,
              active: sessionOpen,
              title: currentSession ? `对话：${currentSession.title}` : '选择对话',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                flex: 1,
                minWidth: 80,
                padding: '0 8px',
                borderRadius: 8,
                border: `1px solid ${T.border}`,
                background: 'transparent',
                color: T.text,
                font: `12px ${FONT}`,
                cursor: !connected || busy ? 'not-allowed' : 'pointer',
                opacity: !connected || busy ? 0.5 : 1,
              },
            },
              h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, style: { flex: '0 0 14px' } },
                h('path', { d: 'M13.5 7.5a5.2 5.2 0 0 1-5.2 5.2H4.2L2 14.5V7.5a5.2 5.2 0 0 1 5.2-5.2h1.1a5.2 5.2 0 0 1 5.2 5.2Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 })),
              h('span', {
                style: { flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, sessionLabel),
              h('span', { style: { color: T.dim, fontSize: 9, flex: '0 0 auto' } }, '▾')),
            h(PressButton, {
              ref: modelBtnRef,
              onClick: () => openModels(false),
              disabled: !connected || busy,
              active: modelOpen,
              title: '选择模型（含免费时段与拥堵状态）',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                maxWidth: 230,
                padding: '0 8px',
                borderRadius: 8,
                border: `1px solid ${modelOpen ? T.borderStrong : T.border}`,
                background: modelOpen ? T.layer2 : 'transparent',
                color: T.text,
                font: `12px ${FONT}`,
                cursor: !connected || busy ? 'not-allowed' : 'pointer',
                opacity: !connected || busy ? 0.5 : 1,
              },
            },
              h(ModelIcon, { model: currentModel, size: 16 }),
              h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 } }, modelLabel),
              currentModel && currentModel.badges && currentModel.badges[0] ? h(BadgeChip, { badge: currentModel.badges[0] }) : null,
              currentModel ? h(BusyBars, { level: currentModel.busyLevel }) : null,
              h('span', { style: { color: T.dim, font: `11px ${FONT}`, whiteSpace: 'nowrap' } },
                currentModel && currentModel.multiplier != null ? `${currentModel.multiplier.toFixed(2)}x` : ''),
              h('span', { style: { color: T.dim, fontSize: 9 } }, '▾')),
            h('div', { style: { flex: 1 } }),
            h(PressButton, {
              title: '设置',
              onClick: () => { setTab('general'); setModelTab('token'); setSettingsOpen(true); },
              disabled: busy,
              style: {
                height: 30,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '0 10px',
                borderRadius: 999,
                border: `1px solid ${T.border}`,
                background: 'transparent',
                color: T.text,
                font: `12px ${FONT}`,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.5 : 1,
                whiteSpace: 'nowrap',
              },
            },
              h('svg', { viewBox: '0 0 24 24', width: 14, height: 14 },
                h('path', { d: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
                h('path', {
                  d: 'M19.4 13.5l1.1.9-1.6 2.8-1.4-.5a7.5 7.5 0 0 1-1.7 1l-.2 1.5h-3.2l-.2-1.5a7.5 7.5 0 0 1-1.7-1l-1.4.5-1.6-2.8 1.1-.9a7.6 7.6 0 0 1 0-2l-1.1-.9 1.6-2.8 1.4.5a7.5 7.5 0 0 1 1.7-1l.2-1.5h3.2l.2 1.5a7.5 7.5 0 0 1 1.7 1l1.4-.5 1.6 2.8-1.1.9a7.6 7.6 0 0 1 0 2Z',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
                })),
              h('span', null, '设置')),
            h(PressButton, {
              ref: connectBtnRef,
              title: connected ? '已连接 WorkBuddy（点击可断开）' : '连接 WorkBuddy（会自动重启应用并接入调试端口）',
              onClick: toggleConnect,
              disabled: busy,
              style: {
                height: 30,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '0 10px',
                marginRight: 16,
                borderRadius: 999,
                border: `1px solid ${connected ? `color-mix(in srgb, ${T.ok} 45%, transparent)` : `color-mix(in srgb, ${T.error} 45%, transparent)`}`,
                background: connected
                  ? `color-mix(in srgb, ${T.ok} 10%, transparent)`
                  : `color-mix(in srgb, ${T.error} 8%, transparent)`,
                color: connected ? T.ok : T.error,
                font: `12px ${FONT}`,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.5 : 1,
                whiteSpace: 'nowrap',
              },
            },
              h('svg', { viewBox: '0 0 16 16', width: 14, height: 14 },
                h('path', { d: 'M6.2 9.8 9.8 6.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
                h('path', { d: 'M7.1 4.6 8.5 3.2a2.4 2.4 0 0 1 3.4 3.4L10.5 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
                h('path', { d: 'M8.9 11.4 7.5 12.8a2.4 2.4 0 0 1-3.4-3.4L5.5 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })),
              h('span', null, connected ? '已连接' : '连接 WorkBuddy'),
              connected ? h('span', { style: { color: T.ok, fontSize: 9, marginLeft: 1 } }, '▾') : null),
            busy
              ? h(IconBtn, { title: '停止', onClick: cancelSend, primary: true, large: true },
                h('svg', { viewBox: '0 0 16 16', width: 16, height: 16 },
                  h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.6, fill: 'currentColor' })))
              : h(IconBtn, { title: '发送', onClick: send, disabled: !connected || !input.trim(), primary: true, large: true },
                h('svg', { viewBox: '0 0 16 16', width: 18, height: 18 },
                  h('path', { d: 'M8 12.5V4M4 7.5L8 3.5l4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
          ),

          /* chosen work directory */
          config && config.cwd
            ? h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 6,
                font: `11.5px ${FONT}`,
                color: T.dim,
                minWidth: 0,
              },
            },
              h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, style: { flex: '0 0 13px' } },
                h('path', { d: 'M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.4 1.6H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 })),
              h('span', {
                title: config.cwd,
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
              }, config.cwd),
              h('button', {
                type: 'button',
                title: '清除工作目录',
                onClick: clearFolder,
                style: { border: 0, background: 'transparent', color: T.dim, cursor: 'pointer', font: `13px ${FONT}`, padding: '0 2px', flex: '0 0 auto' },
              }, '×'),
            )
            : null,

          /* connect popover */
          disconnectOpen && disconnectAnchor
            ? h(Popover, {
              onClose: () => setDisconnectOpen(false),
              style: { position: 'fixed', left: disconnectAnchor.left, bottom: disconnectAnchor.bottom, width: disconnectAnchor.width },
            },
              h('button', {
                type: 'button',
                onClick: disconnectWorkbuddy,
                style: {
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 12px',
                  border: 0,
                  background: 'transparent',
                  color: T.error,
                  font: `12.5px ${FONT}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                },
              },
                h('span', { style: { width: 6, height: 6, borderRadius: 999, background: T.error, flex: '0 0 6px' } }),
                h('span', null, '断开连接')),
            )
            : null,

          /* session popover */
          sessionOpen && sessionAnchor
            ? h(Popover, {
              onClose: () => setSessionOpen(false),
              style: { position: 'fixed', left: sessionAnchor.left, bottom: sessionAnchor.bottom, width: sessionAnchor.width, maxHeight: '70vh' },
            }, sessionPool)
            : null,

          /* model popover */
          modelOpen && modelAnchor
            ? h(Popover, {
              onClose: () => setModelOpen(false),
              style: { position: 'fixed', left: modelAnchor.left, bottom: modelAnchor.bottom, width: modelAnchor.width, maxHeight: '70vh' },
            }, modelPool)
            : null,

          /* file path popover */
          null,
        ),

        /* feedback */
        error ? h('div', { style: { flexShrink: 0, color: T.error, font: `12px ${FONT}`, whiteSpace: 'pre-wrap', paddingTop: 8 } }, error) : null,
        note ? h('div', { style: { flexShrink: 0, color: T.dim, font: `11.5px ${FONT}`, paddingTop: 6 } }, note) : null,

        /* settings modal */
        settingsOpen
          ? h('div', {
            style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 },
            onClick: (event) => { if (event.target === event.currentTarget) setSettingsOpen(false); },
          },
            h('div', {
              style: { width: 660, maxWidth: '94vw', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, boxShadow: '0 18px 50px rgba(0,0,0,0.24)' },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${T.border}` } },
                h('span', { style: { font: `600 14px ${FONT}` } }, '设置'),
                h('div', { style: { flex: 1 } }),
                h('button', {
                  type: 'button',
                  onClick: () => setSettingsOpen(false),
                  style: { border: 0, background: 'transparent', color: T.dim, cursor: 'pointer', font: `16px ${FONT}` },
                }, '×'),
              ),
              h('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
                h('div', { style: { flex: '0 0 auto', minWidth: 96, display: 'flex', flexDirection: 'column', gap: 6, borderRight: `1px solid ${T.borderStrong}`, paddingRight: 14 } },
                  [['general', '通用'], ['workbench', 'WorkBuddy傀儡'], ['model', 'WorkBuddy借魂']].map(([key, label]) => h('button', {
                    key,
                    type: 'button',
                    onClick: () => setTab(key),
                    style: {
                      textAlign: 'center',
                      whiteSpace: 'nowrap',
                      border: `1px solid ${tab === key ? BLUE : 'transparent'}`,
                      background: tab === key ? BLUE : 'transparent',
                      color: tab === key ? '#fff' : T.dim,
                      borderRadius: 8,
                      padding: '6px 10px',
                      font: `12px ${FONT}`,
                      cursor: 'pointer',
                    },
                  }, label))),
                h('div', { style: { flex: 1, minWidth: 0, height: 430, display: 'flex', flexDirection: 'column' } },
                h('div', { style: { flex: 1, overflowY: 'auto', paddingRight: 4 } },

              tab === 'general' ? h('div', null,
                h('div', { style: { font: `11.5px ${FONT}`, color: T.dim, marginBottom: 10, lineHeight: 1.6 } },
                  '全局设置：侧边栏名称、GitHub 更新检查、是否模仿 WorkBuddy 的 .workbuddy 规则。'),
                h('div', { style: sectionBox },
                  h('label', { style: labelStyle() }, '侧边栏名称'),
                  h('input', {
                    value: draft.sidebarName,
                    placeholder: 'WB 工作台',
                    onChange: (event) => setDraft({ ...draft, sidebarName: event.target.value }),
                    style: fieldStyle(),
                  }),
                  h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: '4px 0 0' } },
                    '左侧边栏入口的显示名（与模型分类名无关，刷新后生效）。')),
                h('div', { style: sectionBox },
                  h('label', { style: labelStyle() }, '检查更新'),
                  h('div', { style: { font: `11px ${FONT}`, color: T.dim, marginBottom: 8, lineHeight: 1.6 } },
                    '通过 GitHub 安装时，自动检测该仓库的最新 Release；本地目录安装时读取插件 package.json 的 repository。'),
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                    h('button', {
                      type: 'button',
                      onClick: checkUpdate,
                      style: { border: `1px solid ${T.borderStrong}`, background: T.layer1, color: T.text, borderRadius: 6, padding: '5px 12px', font: `11.5px ${FONT}`, cursor: 'pointer', whiteSpace: 'nowrap' },
                    }, '检查更新'),
                    updateInfo
                      ? h('div', { style: { font: `11.5px ${FONT}`, color: updateInfo.hasUpdate ? BLUE : T.dim, lineHeight: 1.6, paddingTop: 4 } },
                        updateInfo.hasUpdate
                          ? `发现新版本 v${updateInfo.latest}（当前 v${updateInfo.current}）`
                          : `已是最新版本 v${updateInfo.current}`,
                        updateInfo.repo ? h('span', { style: { color: T.dim } }, ` · ${updateInfo.repo}`) : null)
                      : updateError
                        ? h('div', { style: { font: `11.5px ${FONT}`, color: T.error, lineHeight: 1.6, paddingTop: 4 } }, updateError)
                        : null)),
                h('div', { style: sectionBox },
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, font: `12px ${FONT}`, color: T.text, cursor: 'pointer', margin: '0 0 4px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(draft.workbuddyRules),
                      onChange: (event) => setDraft({ ...draft, workbuddyRules: event.target.checked }),
                    }),
                    '借魂模式使用 .workbuddy 规则'),
                  h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: 0 } },
                    '开启后，WB 模型对话会自动读取工作路径下 .workbuddy 的 workbuddy.md / memory / skills 并注入系统提示。'),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, font: `12px ${FONT}`, color: T.text, cursor: 'pointer', margin: '12px 0 4px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(draft.workbuddyRulesDsh),
                      onChange: (event) => setDraft({ ...draft, workbuddyRulesDsh: event.target.checked }),
                    }),
                    'DSH 对话也使用该规则'),
                  h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: 0 } },
                    '开启后点「复制规则提示词」，把内容粘贴到 DSH 对话开头，任意模型都会按这些规则执行。'),
                  h('div', { style: { display: 'flex', gap: 8, margin: '8px 0 0' } },
                    h('button', {
                      type: 'button',
                      onClick: copyRules,
                      style: { border: `1px solid ${T.borderStrong}`, background: T.layer1, color: T.text, borderRadius: 6, padding: '5px 12px', font: `11.5px ${FONT}`, cursor: 'pointer' },
                    }, '复制规则提示词')),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, font: `12px ${FONT}`, color: T.text, cursor: 'pointer', margin: '14px 0 4px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.showTaskList !== false,
                      onChange: (event) => setDraft({ ...draft, showTaskList: event.target.checked }),
                    }),
                    '每次对话都显示任务清单'),
                  h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: 0 } },
                    '开启后模型会先列出任务清单，并在执行过程中更新完成进度（默认开启）。')),
              ) : null,

              tab === 'workbench' ? h('div', { style: sectionBox },
                h('div', { style: { font: `11.5px ${FONT}`, color: T.dim, marginBottom: 10, lineHeight: 1.6 } },
                  '操作 WorkBuddy 应用：调试端口、工作步骤展示，以及重启/连接 WorkBuddy。'),
                h('label', { style: labelStyle() }, 'CDP 调试端口'),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  h('input', {
                    value: draft.port,
                    inputMode: 'numeric',
                    onChange: (event) => setDraft({ ...draft, port: event.target.value.replace(/[^0-9]/g, '') }),
                    style: { ...fieldStyle(), width: 110 },
                  }),
                  h('button', {
                    type: 'button',
                    onClick: () => setDraft({ ...draft, port: String((config && config.suggestedPort) || '') }),
                    style: { border: `1px solid ${T.border}`, background: T.layer1, color: T.text, borderRadius: 6, padding: '0 10px', font: `11.5px ${FONT}`, cursor: 'pointer', whiteSpace: 'nowrap' },
                  }, `本机建议 ${(config && config.suggestedPort) || '…'}`),
                  h('button', {
                    type: 'button',
                    onClick: relaunch,
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      border: `1px solid ${BLUE}`,
                      background: BLUE,
                      color: '#fff',
                      borderRadius: 6,
                      padding: '6px 12px',
                      font: `600 11.5px ${FONT}`,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      boxShadow: '0 1px 0 rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.2)',
                    },
                  },
                    h('svg', { viewBox: '0 0 16 16', width: 13, height: 13 },
                      h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
                      h('path', { d: 'M13 2.5V5.5H10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })),
                    '重启 WB 应用端口'),
                ),
                h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: '6px 0 12px' } }, '换端口后需要重启 WorkBuddy 才会生效。'),
                h('label', { style: labelStyle() }, '工作步骤展示'),
                h('select', {
                  value: draft.stepView,
                  onChange: (event) => setDraft({ ...draft, stepView: event.target.value }),
                  style: fieldStyle(),
                }, STEP_VIEWS.map(([value, label]) => h('option', { key: value, value }, label))),
                h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: '4px 0 4px' } },
                  (STEP_VIEWS.find(([value]) => value === draft.stepView) || STEP_VIEWS[0])[2]),
              ) : null,

              tab === 'model' ? h('div', { style: sectionBox },
                h('div', { style: { font: `11.5px ${FONT}`, color: T.dim, marginBottom: 10, lineHeight: 1.6 } },
                  '把 WorkBuddy 当成 DSH 的模型提供方：模型分类名称、令牌账号 / API Key 凭据。'),
                h('label', { style: labelStyle() }, '模型分类名称'),
                h('input', {
                  value: draft.category,
                  placeholder: 'WB 工作台',
                  onChange: (event) => setDraft({ ...draft, category: event.target.value }),
                  style: fieldStyle(),
                }),
                h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: '4px 0 4px' } },
                  'DSH 模型选择器里的分组标题，设置后立即生效。'),
              ) : null,

              tab === 'model' && modelTab === 'api' ? h('div', { style: sectionBox },
                h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
                  [['token', '令牌'], ['api', 'API']].map(([key, label]) => h('button', {
                    key,
                    type: 'button',
                    onClick: () => setModelTab(key),
                    style: {
                      border: `1px solid ${modelTab === key ? BLUE : 'transparent'}`,
                      background: modelTab === key ? BLUE : 'transparent',
                      color: modelTab === key ? '#fff' : T.dim,
                      borderRadius: 8,
                      padding: '4px 10px',
                      font: `11.5px ${FONT}`,
                      cursor: 'pointer',
                    },
                  }, label))),
                h('label', { style: labelStyle() }, 'WorkBuddy API Key'),
                h('input', {
                  type: 'password',
                  value: draft.apiKey,
                  placeholder: '可留空，改用令牌账号',
                  onChange: (event) => setDraft({ ...draft, apiKey: event.target.value }),
                  style: fieldStyle(),
                }),
                h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: '6px 0 10px' } },
                  '填了 API Key 就优先用它；留空时使用「令牌」页里选中的账号。'),
              ) : null,

              tab === 'model' && modelTab === 'token' ? h('div', { style: sectionBox },
                h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
                  [['token', '令牌'], ['api', 'API']].map(([key, label]) => h('button', {
                    key,
                    type: 'button',
                    onClick: () => setModelTab(key),
                    style: {
                      border: `1px solid ${modelTab === key ? BLUE : 'transparent'}`,
                      background: modelTab === key ? BLUE : 'transparent',
                      color: modelTab === key ? '#fff' : T.dim,
                      borderRadius: 8,
                      padding: '4px 10px',
                      font: `11.5px ${FONT}`,
                      cursor: 'pointer',
                    },
                  }, label))),
                h('label', { style: labelStyle() }, '令牌账号'),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('select', {
                    value: (config && config.activeAccountId) || '',
                    onChange: (event) => { if (event.target.value) setTokenActive(event.target.value); },
                    style: { ...fieldStyle(), flex: 1 },
                  },
                    ((config && config.accounts) || []).length === 0
                      ? h('option', { value: '' }, '（还没有账号）')
                      : null,
                    ((config && config.accounts) || []).map((account) => h('option', { key: account.id, value: account.id }, `${account.label} · ${account.preview}`))),
                  h('button', {
                    type: 'button',
                    disabled: !(config && config.activeAccountId),
                    onClick: () => { if (config && config.activeAccountId) removeToken(config.activeAccountId); },
                    style: { border: `1px solid ${T.border}`, background: T.layer1, color: T.error, borderRadius: 6, padding: '0 10px', font: `11.5px ${FONT}`, cursor: 'pointer' },
                  }, '删除账号')),
                h('div', { style: { font: `11px ${FONT}`, color: T.dim, margin: '6px 0 10px' } },
                  '下拉框切换当前使用的令牌；添加账号会打开浏览器登录，登录后把令牌粘贴进来。'),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', {
                    type: 'button',
                    onClick: startLogin,
                    disabled: Boolean(loginPending),
                    style: { border: `1px solid ${T.border}`, background: T.layer1, color: T.text, borderRadius: 6, padding: '5px 12px', font: `11.5px ${FONT}`, cursor: loginPending ? 'not-allowed' : 'pointer', opacity: loginPending ? 0.6 : 1 },
                  }, loginPending ? '等待登录…' : '添加账号'),
                  h('button', {
                    type: 'button',
                    onClick: () => setTokenForm((value) => !value),
                    style: { border: `1px solid ${T.border}`, background: T.layer1, color: T.text, borderRadius: 6, padding: '5px 12px', font: `11.5px ${FONT}`, cursor: 'pointer' },
                  }, '手动粘贴令牌')),
                loginPending
                  ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, font: `11.5px ${FONT}`, color: T.dim } },
                    h('span', null, '已在浏览器打开登录页，扫码完成后这里会自动出现新账号'),
                    h('button', {
                      type: 'button',
                      onClick: () => setLoginPending(null),
                      style: { border: 0, background: 'transparent', color: T.dim, font: `11.5px ${FONT}`, cursor: 'pointer' },
                    }, '取消'))
                  : null,
                tokenForm ? h('div', { style: { marginTop: 10 } },
                  h('label', { style: labelStyle() }, '账号备注'),
                  h('input', {
                    value: tokenLabel,
                    onChange: (event) => setTokenLabel(event.target.value),
                    style: fieldStyle(),
                  }),
                  h('label', { style: { ...labelStyle(), marginTop: 8 } }, '令牌'),
                  h('textarea', {
                    value: tokenValue,
                    rows: 3,
                    onChange: (event) => setTokenValue(event.target.value),
                    placeholder: '粘贴 WorkBuddy 令牌（eyJ...）',
                    style: { ...fieldStyle(), resize: 'vertical', font: `11px ${FONT}` },
                  }),
                  h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 } },
                    h('button', {
                      type: 'button',
                      onClick: () => setTokenForm(false),
                      style: { border: `1px solid ${T.border}`, background: T.layer1, color: T.text, borderRadius: 6, padding: '5px 12px', font: `11.5px ${FONT}`, cursor: 'pointer' },
                    }, '取消'),
                    h('button', {
                      type: 'button',
                      disabled: tokenBusy,
                      onClick: addToken,
                      style: { border: `1px solid ${T.accent}`, background: T.accent, color: '#fff', borderRadius: 6, padding: '5px 12px', font: `11.5px ${FONT}`, cursor: tokenBusy ? 'not-allowed' : 'pointer', opacity: tokenBusy ? 0.6 : 1 },
                    }, tokenBusy ? '添加中…' : '添加')),
                ) : null,
              ) : null,
                ),
                h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderStrong}` } },
                h('button', {
                  key: 'apply',
                  type: 'button',
                  disabled: saving,
                  onClick: () => saveSettings(false),
                  style: { border: `1px solid ${BLUE}`, background: 'transparent', color: BLUE, borderRadius: 8, padding: '7px 16px', font: `12.5px ${FONT}`, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 },
                }, saving ? '应用中…' : '应用'),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  onClick: () => setSettingsOpen(false),
                  style: { border: `1px solid ${T.borderStrong}`, background: T.layer1, color: T.text, borderRadius: 8, padding: '7px 16px', font: `12.5px ${FONT}`, cursor: 'pointer' },
                }, '取消'),
                h('button', {
                  key: 'save',
                  type: 'button',
                  disabled: saving,
                  onClick: () => saveSettings(true),
                  style: { border: `1px solid ${BLUE}`, background: BLUE, color: '#fff', borderRadius: 8, padding: '7px 16px', font: `12.5px ${FONT}`, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 },
                }, saving ? '保存中…' : '保存'),
              ),
                ),
              ),
            ),
          )
          : null,

      );
    }

    /* ---------------------------- credits badge ---------------------------- */

    function CreditsBadge() {
      const [info, setInfo] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const response = await fetch(API + '/credits');
            const data = await response.json();
            if (alive) setInfo(data);
          } catch { /* 忽略轮询失败 */ }
        };
        tick();
        const timer = setInterval(tick, 30000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      if (!info || info.ok !== true || info.active !== true) return null;
      const fmt = (value) => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          font: `11.5px ${FONT}`,
          color: T.dim,
          padding: '1px 6px',
          whiteSpace: 'nowrap',
        },
      },
        h('span', null, `WB 积分 剩余 ${fmt(info.remaining)}`),
        h('span', { style: { color: T.border } }, '·'),
        h('span', null, `本期已用 ${fmt(info.used)}`));
    }

    /* ---------------------------- sidebar icon ---------------------------- */

    function SidebarIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2.5, y: 7, width: 19, height: 12.5, rx: 2.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M2.5 12h19', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M8 14.5h8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }));
    }

    /* ---------------------------- registration ---------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧边栏标签在注册那一刻就被 DSH 取走，异步 fetch 来不及；这里用同步 XHR
        // 先拿到配置里的名字，再注册，保证首次渲染就是用户设置的名字。
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', API + '/config', false);
          xhr.send(null);
          const data = JSON.parse(xhr.responseText);
          if (data && typeof data.sidebarName === 'string' && data.sidebarName !== '') panelLabel = data.sidebarName;
        } catch { /* 拿不到就沿用默认名 */ }
        // 模型选择器里的倍率由 CSS 追加，先按当前目录装一次。
        refreshMultiplierStyles();
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dhs-wb-work-credits',
          order: 9,
        }, CreditsBadge)));
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.inject('sidebar.panellist', () => {
              const stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, Workbench);
              let stopIcon;
              try {
                stopIcon = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: () => panelLabel }, SidebarIcon);
              } catch (error) {
                stopMain();
                throw error;
              }
              // 侧边栏标签在注册时生成，配置里的名称晚于注册到达，需要重新注册一次才能换名。
              fetch(API + '/config')
                .then((response) => response.json())
                .then((data) => {
                  if (!data || typeof data.sidebarName !== 'string' || data.sidebarName === '' || data.sidebarName === panelLabel) return;
                  panelLabel = data.sidebarName;
                  try {
                    if (stopIcon) stopIcon();
                    stopIcon = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: () => panelLabel }, SidebarIcon);
                  } catch { /* 重新注册失败就保持原名 */ }
                })
                .catch(() => {});
              return () => {
                if (stopIcon) stopIcon();
                stopMain();
              };
            }),
          ),
        );
      },
    };
  },
});
