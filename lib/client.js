/* 设置页（客户端半边）：设置 → 插件 → 复读拦截。
 *
 * 走 dsh 0.2 的 settingsScope 服务：
 *   const cfg = ctx.get('configForms'); const scope = cfg.get('dsh-mmy-knight')
 *   scope.getSnapshot() → { value, user, revision, ... }；scope.set(k,v) / scope.unset(k)
 *
 * 注册姿势照抄能跑的 dsh-whale-persona / dsh-mmy-tools：
 *   ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Comp))
 *   —— inject 的回调必须**返回 register 的 dispose**，且只注册一次。
 *
 * 字段表在这里硬编码一份（浏览器侧 require 不到宿主 lib/config.js）；
 * 加配置项时同步改 lib/config.js 和这里的 FIELDS。
 *
 * 交互：**显式保存**。输入只写本地草稿，点「保存」才逐项写回并回读校验。
 *
 * 这个文件不能抛：客户端插件一崩，整个 web UI 会白屏。所有注册都包在 try 里。 */
window.__ModuleLoader__.load({
  id: 'dsh-mmy-knight',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-mmy-knight';
    const SECTION_SLOT = 'settings.section';
    /** getSnapshot 的稳定兜底对象（每次返回新对象会触发 React 无限重渲染告警）。 */
    const EMPTY_SNAP = Object.freeze({ value: Object.freeze({}), user: Object.freeze({}) });

    /** 与宿主 lib/config.js 的字段保持一致（只放插件真的会读的项）。 */
    const FIELDS = [
      // —— 复读拦截 · 基础判据 ——
      { group: '复读拦截', key: 'repeatGuardEnabled', label: '总开关（1 开 / 0 关）', type: 'number', def: 0, hint: '挂在 llm/stream 上拦思考段与正文复读；0 = 完全不干涉生成' },
      { group: '复读拦截', key: 'repeatGuardEchoMin', label: '碎嘴短句连续几次算复读', type: 'number', def: 2, hint: '默认 2；单字项（写。查。看。做。）固定要连续 3 次，避免列清单误伤' },
      { group: '复读拦截', key: 'repeatGuardParaMin', label: '整段重复：连续几行全等', type: 'number', def: 3, hint: '0 = 关掉这类' },
      { group: '复读拦截', key: 'repeatGuardSentMin', label: '句子复读：同句出现几次', type: 'number', def: 5, hint: '只看最近 20 句、8 字以上的句子；0 = 关掉这类。2026-11-09 默认 3→5：正常复述报告结论会被判复读' },
      { group: '复读拦截', key: 'repeatGuardLoopMin', label: '原地打转：短行重复多少次算复读', type: 'number', def: 4, hint: '专治每行都略有不同的循环（「做，好。」那一类）；0 = 关掉这类' },
      { group: '复读拦截', key: 'repeatGuardBody', label: '也查正文（1 开 / 0 关）', type: 'number', def: 1, hint: '正文重复是真实事故，只查思考段会漏；已有去重率门槛，误伤低' },
      { group: '复读拦截', key: 'repeatGuardShortRepeat', label: '口头禅：同一极短句出现几次算打转', type: 'number', def: 8, hint: '专治长句里夹着「做。」「好。」的夹心式重复，只看次数不看占比；0 = 关掉这类。2026-11-09 默认 5→8：口头禅本身不是复读' },
      { group: '复读拦截', key: 'repeatGuardNudgeRun', label: '系统提醒复读：连续几行算复读', type: 'number', def: 3, hint: '模型把注入的「（过程纪律提醒）」当正文刷；只认连续相邻行，单行内重复 ≥5 次也直接命中' },

      // —— 过程纪律 ——
      { group: '过程纪律', key: 'progressNudgeSteps', label: '连续几步沉默就催一次正文（0 = 关）', type: 'number', def: 0, hint: '上一步只有工具调用、没有正文，连续攒够这么多步就在下一步注入一条「先说 1–3 句再继续」；2026-11-09 从 mmy-life 迁来，默认关（实测注入 546 次把输出切碎）' },

      // —— 思考语言 ——
      { group: '思考语言', key: 'thinkingLangGuard', label: '思考语言守卫（1 开 / 0 关）', type: 'number', def: 1, hint: '每轮在最后一条消息后注入中文思考约束；0 = 完全不注入' },
      { group: '思考语言', key: 'thinkingLangStyle', label: '每轮注入交流习惯（1 开 / 0 关）', type: 'number', def: 1, hint: '语音播报 / 表情包 / 重启方式三条；与语言约束分开，不想被提醒就关这个' },
      { group: '思考语言', key: 'thinkingLangStrict', label: '检测到英文思考就强制中文重来（1 开 / 0 关）', type: 'number', def: 1, hint: 'strict 会多花一次生成的 token；只对整段英文思考触发，每会话 10 分钟最多纠正一次' },

      // —— 熔断与恢复 ——
      { group: '熔断与恢复', key: 'repeatGuardFuse', label: '熔断窗口内最多拦几次', type: 'number', def: 2, hint: '超了就进冷却；按时间窗口累计，不再每轮清零' },
      { group: '熔断与恢复', key: 'repeatGuardFuseWindow', label: '熔断统计窗口（分钟）', type: 'number', def: 15, hint: '窗口内累计命中次数超过上限就进冷却；窗口过了自动清零' },
      { group: '熔断与恢复', key: 'repeatGuardCooldownMin', label: '熔断后静默冷却（分钟）', type: 'number', def: 10, hint: '冷却期内仍截断、但不再 steer；结束后重新计数' },
      { group: '熔断与恢复', key: 'repeatGuardMaxRecoveries', label: '熔断后自动恢复几次', type: 'number', def: 1, hint: '第一次熔断 steer 一条恢复提示，超过这个次数就转强制交接' },
      { group: '熔断与恢复', key: 'repeatGuardHandoff', label: '恢复后仍熔断就强制交接（1 开 / 0 关）', type: 'number', def: 1, hint: '交接指令让模型写 memory/交接.md 并调 mmy_new_chat；关掉则只截断不交接' },

      // —— 折叠与工具循环 ——
      { group: '折叠与工具循环', key: 'repeatGuardFold', label: '退化步折叠（1 开 / 0 关，默认关）', type: 'number', def: 0, hint: '把已判成复读的那一步连同工具结果，从模型可见历史里换成一句说明；会话日志不变' },
      { group: '折叠与工具循环', key: 'repeatGuardFoldDryRun', label: '折叠先只观察（1 = 只记日志）', type: 'number', def: 1, hint: '先看日志里哪些步会被折，确认没问题再改成 0 让折叠真正生效' },
      { group: '折叠与工具循环', key: 'repeatGuardFoldMinChars', label: '折叠：思考段最短多少字才处理', type: 'number', def: 300, hint: '太短的块不值得动，也更容易误判' },
      { group: '折叠与工具循环', key: 'repeatGuardToolLoop', label: '工具调用重复：同参数重复几次算打转', type: 'number', def: 3, hint: '同一工具 + 同一组参数在最近若干步内出现这么多次，就追加一条提示（不阻断、不改工具结果）；0 = 关掉这类' },
      { group: '折叠与工具循环', key: 'repeatGuardToolWindow', label: '工具调用重复：看最近多少步', type: 'number', def: 20, hint: '只看最近这么多个 assistant 步里的工具调用；太小容易误判、太大会把陈年调用算进来' },

      // —— 调度重试 ——
      { group: '调度重试', key: 'scheduleRetryEnabled', label: '投递失败自动重试（1 开 / 0 关）', type: 'number', def: 1, hint: '调度器投递失败时按心跳重试；0 = 不装心跳' },
      { group: '调度重试', key: 'scheduleRetryIntervalSec', label: '重试心跳间隔（秒，最小 5）', type: 'number', def: 60, hint: '每隔这么久检查一次待重试的投递' },

      // —— 公共 ——
      { group: '公共', key: 'cacheDir', label: '日志与状态目录', type: 'text', def: '', hint: '留空 = DSH_HOME/cache；宿主侧 startup-catchup 与 mmy_repeat_guard 会同时读工作区 .cache 和这里' },
    ];

    // ── 焦点框压制：宿主会给可聚焦元素画黑框，容器内全覆盖 ──
    const FOCUS_CSS = [
      '[data-knight-root], [data-knight-root] *{-webkit-tap-highlight-color:transparent!important;}',
      '[data-knight-root]:focus,[data-knight-root]:focus-visible,',
      '[data-knight-root] *:focus,[data-knight-root] *:focus-visible{',
      'outline:none!important;outline-offset:0!important;box-shadow:none!important;}',
      '[data-knight-root] *::-moz-focus-inner{border:0!important;}',
      '[data-knight-root] *:focus::before,[data-knight-root] *:focus::after,',
      '[data-knight-root] *:focus-visible::before,[data-knight-root] *:focus-visible::after{',
      'content:none!important;display:none!important;}',
      '[data-knight-root] button[data-knight-btn="1"]{',
      'border:1px solid rgba(var(--knight-line-rgb),.18)!important;}',
      '[data-knight-root] .knight-card{transition:border-color .16s ease,background-color .16s ease,box-shadow .16s ease;}',
      '[data-knight-root] .knight-card:hover{',
      'border-color:rgba(var(--knight-accent-rgb),.5)!important;',
      'background:rgba(var(--knight-accent-rgb),.045)!important;',
      'box-shadow:0 2px 10px -4px rgba(var(--knight-accent-rgb),.22)!important;}',
      '[data-knight-root] .knight-card-toggle{border:0!important;outline:0!important;border-radius:0;box-shadow:none!important;background:transparent!important;transition:color .14s ease;}',
      '[data-knight-root] .knight-card-toggle:hover{color:rgba(var(--knight-accent-rgb),1)!important;}',
      // 绫波丽冷调：浅色走 EVA 浅色板，深色回落到中性亮灰；改风格只改这一处。
      '[data-knight-root]{--knight-line-rgb:40,105,138;--knight-accent-rgb:23,107,145;--knight-accent-strong-rgb:17,87,119;--knight-danger-rgb:173,61,87;--knight-ok-rgb:38,114,99;--knight-warn-rgb:146,96,8;--knight-surface:#f7fbfd;--knight-surface-2:#eff6fa;--knight-mincho:"Yu Mincho","游明朝","YuMincho","BIZ UD Mincho","MS PMincho","Noto Serif SC","Songti SC","SimSun",serif;}',
      '[data-ds-dark-theme] [data-knight-root]{--knight-line-rgb:150,170,180;--knight-accent-rgb:35,121,157;--knight-accent-strong-rgb:47,113,144;--knight-danger-rgb:224,96,118;--knight-ok-rgb:80,160,140;--knight-warn-rgb:229,162,79;--knight-surface:#181c23;--knight-surface-2:#14171c;--knight-mincho:"Yu Mincho","游明朝","YuMincho","BIZ UD Mincho","MS PMincho","Noto Serif SC","Songti SC","SimSun",serif;}',
    ].join('\n');

    // ── 设计令牌（绫波丽冷调：NB=青蓝发丝线、AC=主色青蓝、DG=暗玫红危险色）──
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const NB = (a) => `rgba(var(--knight-line-rgb),${a})`;
    const AC = (a) => `rgba(var(--knight-accent-rgb),${a})`;
    const AC2 = (a) => `rgba(var(--knight-accent-strong-rgb),${a})`;
    const DG = (a) => `rgba(var(--knight-danger-rgb),${a})`;
    const OK = (a) => `rgba(var(--knight-ok-rgb),${a})`;

    const S = {
      wrap: { fontSize: 13, lineHeight: 1.6, maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 10, color: 'inherit' },
      hero: { display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 14, border: `1px solid ${NB(0.16)}`, background: 'var(--knight-surface)', boxShadow: `inset 3px 0 0 ${AC(0.85)}`, margin: 0 },
      heroAvatar: { width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: AC(0.16), color: AC(1), fontSize: 19, flexShrink: 0 },
      heroText: { minWidth: 0, flex: 1 },
      heroTitle: { fontFamily: 'var(--knight-mincho)', fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '.04em', color: AC(1) },
      heroSub: { fontSize: 12, opacity: 0.6, marginTop: 3 },
      pill: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 500, border: `1px solid ${OK(0.32)}`, background: OK(0.12), color: OK(0.95), whiteSpace: 'nowrap', flexShrink: 0 },
      blockTitle: { fontFamily: 'var(--knight-mincho)', fontSize: 13, fontWeight: 700, letterSpacing: '.18em', opacity: 0.62, color: AC(0.9), margin: '14px 2px 2px' },

      card: { position: 'relative', border: `1px solid ${NB(0.14)}`, borderLeft: `3px solid ${AC(0.62)}`, borderRadius: 14, padding: '16px 16px 18px', background: 'var(--knight-surface)', marginBottom: 0, boxShadow: `0 1px 2px ${NB(0.05)}` },
      cardPlain: { borderLeftColor: NB(0.28) },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
      cardToggle: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
      cardCaret: { flexShrink: 0, display: 'inline-block', width: 12, fontFamily: 'Segoe UI Symbol, sans-serif', fontSize: 12, lineHeight: 1, opacity: 0.55, transition: 'transform .15s', transform: 'rotate(0deg)' },
      cardTitle: { fontFamily: 'var(--knight-mincho)', fontSize: 14.5, fontWeight: 700, letterSpacing: '.03em', color: AC(0.95), flex: 1, minWidth: 0 },
      cardDesc: { fontSize: 12, opacity: 0.55, lineHeight: 1.55, margin: '0 0 12px' },

      row: { display: 'grid', gridTemplateColumns: 'minmax(150px, 210px) minmax(0, 1fr)', gap: 16, alignItems: 'center', padding: '9px 0', borderTop: `1px solid ${NB(0.07)}` },
      rowFirst: { borderTop: 'none', paddingTop: 2 },
      labelBox: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
      label: { fontSize: 12.5, opacity: 0.92, lineHeight: 1.5, wordBreak: 'break-word' },
      hint: { fontSize: 11.5, opacity: 0.5, marginTop: 2, lineHeight: 1.55 },
      input: { padding: '8px 11px', borderRadius: 10, border: `1px solid ${NB(0.14)}`, background: 'var(--knight-surface-2)', color: 'inherit', fontSize: 13, lineHeight: 1.5, width: '100%', boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit', transition: 'border-color .12s, box-shadow .12s, background .12s' },
      inputDirty: { borderColor: AC(0.55), background: AC(0.07), boxShadow: `0 0 0 3px ${AC(0.1)}` },
      inputFocus: { borderColor: AC(0.6), background: 'transparent', boxShadow: `0 0 0 4px ${AC(0.16)}` },
      select: { padding: '8px 11px', borderRadius: 10, border: `1px solid ${NB(0.14)}`, background: 'var(--knight-surface-2)', color: 'inherit', fontSize: 13, lineHeight: 1.5, width: '100%', boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' },
      switch: { justifySelf: 'start', minWidth: 68, padding: '7px 16px', borderRadius: 999, border: `1px solid ${NB(0.18)}`, background: NB(0.05), color: 'inherit', fontSize: 12.5, lineHeight: 1.4, cursor: 'pointer', fontFamily: 'inherit', transition: 'background .12s, border-color .12s, color .12s' },
      switchOn: { borderColor: OK(0.5), background: OK(0.14), color: OK(0.98), fontWeight: 600 },

      bar: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 2, paddingTop: 14, borderTop: `1px solid ${NB(0.1)}`, flexWrap: 'wrap' },
      status: { fontSize: 12, opacity: 0.55, flex: 1, minWidth: 120, lineHeight: 1.5 },
      statusDirty: { color: AC(0.95), opacity: 0.95 },
      btnPrimary: { padding: '8px 20px', borderRadius: 10, border: `1px solid ${AC(1)}`, background: AC(1), color: '#fff', fontSize: 13, fontWeight: 600, lineHeight: 1.3, cursor: 'pointer', fontFamily: 'inherit', minWidth: 92, textAlign: 'center', boxShadow: `0 4px 12px -6px ${AC(0.7)}`, transition: 'background .12s, box-shadow .12s' },
      btnPrimaryHover: { background: AC2(1), borderColor: AC2(1), boxShadow: `0 6px 16px -6px ${AC2(0.85)}` },
      btnPrimaryOff: { opacity: 0.4, cursor: 'default' },
      btnGhost: { padding: '7px 13px', borderRadius: 10, border: `1px solid ${NB(0.14)}`, background: NB(0.045), color: 'inherit', fontSize: 12.5, lineHeight: 1.3, cursor: 'pointer', fontFamily: 'inherit', transition: 'background .12s, border-color .12s' },
      btnGhostHover: { background: NB(0.09), borderColor: NB(0.34) },
      btnGhostOff: { opacity: 0.4, cursor: 'default' },
      btnMini: { marginLeft: 6, padding: '1px 7px', borderRadius: 999, border: `1px solid ${NB(0.18)}`, background: 'transparent', color: 'inherit', fontSize: 11, lineHeight: 1.5, cursor: 'pointer', opacity: 0.7, fontFamily: 'inherit' },
      btnMiniHover: { opacity: 1, borderColor: AC(0.5), color: AC(0.95) },

      err: { marginTop: 10, padding: '10px 12px', borderRadius: 11, border: `1px solid ${DG(0.34)}`, background: DG(0.09), color: DG(0.96), fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      footer: { fontSize: 11.5, opacity: 0.5, marginTop: 2, lineHeight: 1.7 },
    };

    /** 内联 style 没有 :hover / :focus，小按钮在这里补反馈。 */
    function Btn(props) {
      const [on, setOn] = React.useState(false);
      let style = props.style;
      if (props.off && props.offStyle) style = { ...style, ...props.offStyle };
      if (on && !props.off && props.hoverStyle) style = { ...style, ...props.hoverStyle };
      return h('button', {
        type: 'button',
        style: { outline: 'none', ...style },
        'data-knight-btn': '1',
        title: props.title,
        onClick: props.off ? undefined : props.onClick,
        onMouseEnter: () => setOn(true),
        onMouseLeave: () => setOn(false),
        onFocus: () => setOn(true),
        onBlur: () => setOn(false),
      }, props.children);
    }

    /** 卡片外壳：cardHead + 可折叠正文（点标题收起 / 展开）。 */
    function Panel(props) {
      const [collapsed, setCollapsed] = React.useState(props.defaultCollapsed === true);
      const collapsible = props.collapsible !== false;
      const head = h('div', { key: 'head', style: S.cardHead }, [
        collapsible
          ? h('button', {
            key: 't',
            type: 'button',
            className: 'knight-card-toggle',
            style: S.cardToggle,
            onClick: () => setCollapsed((c) => !c),
            title: collapsed ? '展开' : '收起',
            'aria-expanded': !collapsed,
          }, [
            h('span', { key: 'c', style: collapsed ? S.cardCaret : { ...S.cardCaret, transform: 'rotate(90deg)' } }, '▸'),
            h('span', { key: 'n', style: S.cardTitle }, props.title),
          ])
          : h('div', { key: 't', style: S.cardTitle }, props.title),
        props.actions ? h('div', { key: 'a', style: S.cardActions }, props.actions) : null,
      ]);
      const baseStyle = props.plain ? { ...S.card, ...S.cardPlain } : S.card;
      const boxStyle = (collapsible && collapsed) ? { ...baseStyle, padding: '11px 16px', borderLeftColor: NB(0.2) } : baseStyle;
      return h('div', { className: 'knight-card', style: boxStyle }, [
        head,
        (collapsible && collapsed) ? null : h('div', { key: 'b' }, [
          props.desc ? h('div', { key: 'd', style: S.cardDesc }, props.desc) : null,
          props.children,
        ]),
      ].filter(Boolean));
    }

    function Section(props) {
      // scope 可能晚一点才就绪（configForms 是异步服务），所以做成 state + 轮询；
      // useSyncExternalStore 必须**无条件**调用——不能因为 scope 还空就跳过一次 hook。
      const [scope, setScope] = React.useState(() => (props && props.scope) || null);
      React.useEffect(() => {
        if (scope) return undefined;
        // 指数退避：configForms 永不就绪时别每 500ms 无限轮询。
        let delay = 500;
        let tries = 0;
        let timer;
        const tick = () => {
          let got = null;
          try { got = props && typeof props.getScope === 'function' ? props.getScope() : null; } catch { got = null; }
          if (got) { setScope(got); return; }
          tries += 1;
          if (tries >= 30) return;
          delay = Math.min(Math.round(delay * 1.6), 5000);
          timer = setTimeout(tick, delay);
        };
        timer = setTimeout(tick, delay);
        return () => clearTimeout(timer);
      }, [scope]);

      const subscribe = React.useCallback((cb) => {
        try {
          if (scope && typeof scope.subscribe === 'function') return scope.subscribe(cb) || (() => {});
          return () => {};
        } catch { return () => {}; }
      }, [scope]);
      // getSnapshot 必须返回**同一个对象引用**，否则 useSyncExternalStore 会一直认为
      // 「变了」→ 无限重渲染。所以这里用固定的 EMPTY 兜底；异常分支也按「scope + 错误文本」缓存同一个对象。
      const errorSnap = React.useRef({ scope: null, snap: { status: 'error', error: '' } });
      const getSnapshot = React.useCallback(() => {
        try {
          const v = scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : null;
          return v || EMPTY_SNAP;
        } catch (e) {
          const error = String((e && e.message) || e);
          if (errorSnap.current.scope !== scope || errorSnap.current.snap.error !== error) {
            errorSnap.current = { scope, snap: { status: 'error', error } };
          }
          return errorSnap.current.snap;
        }
      }, [scope]);
      const snap = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      const [draft, setDraft] = React.useState({});
      // 保存成功后宿主快照不一定立刻刷新（subscribe 不触发时 baseOf 会读到旧值，
      // 表现是「改成 1 保存、再改回 0 时保存按钮变灰」）。这里记一份本地已保存值兜底。
      const [saved, setSaved] = React.useState({});
      const [status, setStatus] = React.useState('');
      const flashTimer = React.useRef(null);
      React.useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
      const [failed, setFailed] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      /** 输入框焦点：内联 style 没有 :focus，用它叠 inputFocus。 */
      const [focusKey, setFocusKey] = React.useState('');

      const usable = !!(scope && typeof scope.getSnapshot === 'function');
      if (!usable) {
        return h('div', { style: { fontSize: 13, opacity: 0.78, lineHeight: 1.9 } }, [
          h('p', { key: 'a' }, props && props.why ? `设置页没接上：${props.why}` : '设置页没接上：configForms 作用域还没就绪，等几秒或重开这一页。'),
          h('p', { key: 'b' }, '这段时间仍然可以改用工具或配置文件。'),
        ]);
      }

      const stored = (snap && (snap.value || {})) || {};
      const user = (snap && (snap.user || {})) || {};
      const flash = (msg) => {
        setStatus(msg);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setStatus(''), 2600);
      };

      const baseOf = (f) => {
        if (Object.prototype.hasOwnProperty.call(saved, f.key)) return saved[f.key];
        if (Object.prototype.hasOwnProperty.call(user, f.key)) return user[f.key];
        return stored[f.key] === undefined ? f.def : stored[f.key];
      };
      const asText = (v) => (v === undefined || v === null ? '' : String(v));
      const shown = (f) => (Object.prototype.hasOwnProperty.call(draft, f.key) ? draft[f.key] : asText(baseOf(f)));
      const isDirty = (f) => Object.prototype.hasOwnProperty.call(draft, f.key) && String(draft[f.key]) !== asText(baseOf(f));
      const dirty = FIELDS.filter(isDirty);
      const overridden = (f) => Object.prototype.hasOwnProperty.call(user, f.key);

      /** 宿主只提供 set/unset（没有批量 mutate），所以逐字段写。 */
      const write = async (key, value) => {
        if (typeof scope.set !== 'function' || typeof scope.unset !== 'function') {
          throw new Error('这个设置作用域没有 set/unset，写不进去（宿主版本不对？）');
        }
        const accepted = value === undefined ? await scope.unset(key) : await scope.set(key, value);
        if (accepted === false) throw new Error('宿主拒绝了这次写入（字段不是 volatile，或值不合法）');
        return accepted;
      };

      const save = async () => {
        if (busy) return;
        if (!dirty.length) { flash('没有改动'); return; }
        setFailed(''); setBusy(true);
        const ok = []; const bad = [];
        const savedValues = {};
        for (const f of dirty) {
          const raw = draft[f.key];
          const empty = String(raw == null ? '' : raw).trim() === '';
          const v = f.type === 'number' ? (empty ? undefined : Number(raw)) : raw;
          if (f.type === 'number' && !empty && !Number.isFinite(v)) {
            bad.push(`${f.key}: 不是有效数字`);
            continue;
          }
          try { await write(f.key, v); ok.push(f.key); savedValues[f.key] = v; }
          catch (e) { bad.push(`${f.key}: ${(e && e.message) || e}`); }
        }
        setBusy(false);
        if (ok.length) setSaved((prev) => ({ ...prev, ...savedValues }));
        setDraft((prev) => {
          const next = { ...prev };
          for (const k of ok) delete next[k];
          return next;
        });
        if (bad.length) { setFailed(`保存失败：\n${bad.join('\n')}`); return; }
        flash(`已保存 ${ok.length} 项`);
      };

      const revert = () => { setDraft({}); setFailed(''); flash('已撤销未保存的改动'); };

      const resetOne = async (f) => {
        setFailed('');
        try {
          await write(f.key, undefined);
          setDraft((prev) => { const next = { ...prev }; delete next[f.key]; return next; });
          setSaved((prev) => { const next = { ...prev }; delete next[f.key]; return next; });
          flash(`${f.label} 已恢复默认`);
        } catch (e) { setFailed(`${f.key} 恢复失败：${(e && e.message) || e}`); }
      };

      const dirtyNote = dirty.length ? `${dirty.length} 项未保存` : (status || '改完点「保存」生效');

      /** 按 type 出控件：text/number 是输入框，switch 是胶囊开关。 */
      const control = (f, d, focused) => {
        const setVal = (v) => {
          setDraft((prev) => ({ ...prev, [f.key]: v }));
          if (failed) setFailed('');
        };
        const focusProps = {
          onFocus: () => setFocusKey(f.key),
          onBlur: () => setFocusKey((k) => (k === f.key ? '' : k)),
        };
        if (f.type === 'switch') {
          const on = String(shown(f)) !== '0' && String(shown(f)) !== '';
          return h('button', {
            key: 'i',
            type: 'button',
            'data-knight-switch': on ? '1' : '0',
            'aria-pressed': on ? 'true' : 'false',
            style: { ...S.switch, ...(on ? S.switchOn : null), ...(d ? S.inputDirty : null) },
            onClick: () => setVal(on ? '0' : '1'),
          }, on ? '开' : '关');
        }
        return h('input', {
          key: 'i',
          style: { ...S.input, ...(d ? S.inputDirty : null), ...(focused ? S.inputFocus : null) },
          type: f.type === 'number' ? 'number' : 'text',
          value: shown(f),
          ...focusProps,
          onChange: (e) => setVal(e.target.value),
        });
      };

      const groups = [];
      for (const f of FIELDS) if (!groups.includes(f.group)) groups.push(f.group);

      const cards = groups.map((g) => h(Panel, {
        key: `g-${g}`,
        title: `${g} · ${FIELDS.filter((f) => f.group === g).length} 项`,
        plain: true,
        collapsible: true,
        defaultCollapsed: true,
        children: FIELDS.filter((f) => f.group === g).map((f, idx) => {
          const d = isDirty(f);
          const focused = focusKey === f.key;
          return h('div', { key: f.key, style: idx === 0 ? { ...S.row, ...S.rowFirst } : S.row }, [
            h('div', { key: 'l', style: S.labelBox }, [
              h('div', { key: 'n', style: S.label },
                f.label,
                overridden(f) ? h(Btn, {
                  key: 'r',
                  style: S.btnMini,
                  hoverStyle: S.btnMiniHover,
                  title: '恢复默认值',
                  onClick: () => resetOne(f),
                }, '默认') : null),
              f.hint ? h('div', { key: 'h', style: S.hint }, f.hint) : null,
              d ? h('div', { key: 'd', style: { ...S.hint, color: AC(0.95), opacity: 0.9 } }, '未保存') : null,
            ]),
            control(f, d, focused),
          ]);
        }),
      }));

      return h('div', { style: S.wrap, 'data-knight-root': '1' }, [
        h('div', { key: 'hero', style: S.hero }, [
          h('div', { key: 'a', style: S.heroAvatar }, '🐋'),
          h('div', { key: 't', style: S.heroText }, [
            h('div', { key: 'ti', style: S.heroTitle }, '小伊的守护骑士'),
            h('div', { key: 's', style: S.heroSub }, `dsh-mmy-knight · ${FIELDS.length} 项配置 · ${groups.length} 个分组`),
          ]),
          h('span', { key: 'p', style: S.pill }, 'llm/stream'),
        ]),
        h('div', { key: 'bt-cfg', style: S.blockTitle }, '配置'),
        ...cards,
        h('div', { key: 'bar', style: S.bar }, [
          h('span', { key: 's', style: dirty.length ? { ...S.status, ...S.statusDirty } : S.status }, dirtyNote),
          h(Btn, {
            key: 'save',
            style: S.btnPrimary,
            offStyle: S.btnPrimaryOff,
            hoverStyle: S.btnPrimaryHover,
            off: !dirty.length || busy,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h(Btn, {
            key: 'revert',
            style: S.btnGhost,
            offStyle: S.btnGhostOff,
            hoverStyle: S.btnGhostHover,
            off: !dirty.length || busy,
            onClick: revert,
          }, '撤销'),
        ]),
        failed ? h('div', { key: 'err', style: S.err }, failed) : null,
        h('div', { key: 'note', style: S.footer },
          '这些是 dsh-mmy-knight 真会读的配置；改完点「保存」立即生效，不用重启。日志在 cacheDir/repeat-guard.jsonl。'),
      ].filter(Boolean));
    }

    function softService(ctx, name) {
      if (typeof ctx.get === 'function') { try { return ctx.get(name); } catch { return undefined; } }
      try { return ctx[name]; } catch { return undefined; }
    }

    /** 宿主全局的 :focus-visible 会给可点行画黑框；用一段样式表压在插件容器里。 */
    function injectFocusCss() {
      try {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById('dsh-mmy-knight-focus-css')) return;
        const el = document.createElement('style');
        el.id = 'dsh-mmy-knight-focus-css';
        el.textContent = FOCUS_CSS;
        // 放到 body 末尾：同特异性时后插入的规则胜，压住宿主靠后注入的样式
        (document.body || document.head).appendChild(el);
      } catch { /* ignore */ }
    }

    function applyInner(ctx) {
      injectFocusCss();
      const getScope = () => {
        try {
          const cfg = softService(ctx, 'configForms');
          if (!cfg || typeof cfg.get !== 'function') return null;
          return cfg.get(NS) || null;
        } catch { return null; }
      };

      // 照抄 dsh-whale-persona：inject 的回调返回 register 的 dispose，且只注册这一次。
      const scopeAtMount = getScope();
      ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register(
        {
          name: SECTION_SLOT,
          id: 'dsh-mmy-knight',
          order: 37,
          label: () => '小伊的守护骑士',
        },
        (props) => h(Section, { ...props, scope: (props && props.scope) || scopeAtMount, getScope }),
      ));
    }

    // 依赖注入：slots 必需；configForms 不写进 inject，缺了就由 Section 自己轮询补上。
    module.exports.inject = ['slots'];

    // 客户端入口绝不能把整页拖垮：任何意外都只降级成「设置页没接上」。
    module.exports.apply = function apply(ctx) {
      try { applyInner(ctx); } catch (e) {
        try { console.warn('[dsh-mmy-knight] 客户端注册失败：', e && e.message); } catch { /* ignore */ }
      }
    };

    return module.exports;
  },
});
