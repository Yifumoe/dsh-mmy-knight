/** 会话健康巡检（2026-11-16 从 dsh-mmy-tools 迁入 dsh-mmy-knight）。
 * 主人定：健康巡检是「复读退化的事后观测」，跟拦截同源，判据不该分两处。
 *
 * 会话健康巡检（2026-11-12 主人定：隔几分钟自动查，状态挂到输入框底部）。
 *
 * 做什么：宿主这边零 token 地读会话事件流，按轮统计 reasoning 里「短行（≤2 字）占比」，
 * 叠加复读拦截日志的命中次数，产出每个会话的健康档位，写 .cache/session-health.json，
 * 并通过 /api/mmy-knight/session-health 给前端两个槽位供数。
 *
 * 为什么不每轮全量解：会话文件是 zstd 多帧，活跃会话几分钟就长一点。
 * 这里记住「已解到哪个字节偏移」，下一轮只解新帧（帧未写完就留到下次），
 * 所以 5 分钟一轮的 CPU 基本只花在真正新增的几十 KB 上。
 *
 * 阈值口径与 tools/session-health.mjs 一致（那边是 CLI 版，别各调各的）：
 *   MIN_LINES=50、连续两轮 >0.15、单轮 >0.25@100 行。
 * 先「只记录不告警」：档位只是标签，不拦截、不停轮、不发通知。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 工作区根：lib/health.js → dsh-mmy-knight → 上一层（profile 里是 symlink，路径即源码位置）。 */
export function defaultWsDir() {
  return path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
}

export const MIN_LINES = 50;
export const RATIO_WARN = 0.15;
export const RATIO_HARD = 0.25;
const STATE_NAME = 'knight-health.json';
const GUARD_LOG = 'repeat-guard.jsonl';

/** 会话目录：$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd */
function sessionRoot(home) {
  return path.join(home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
}

/** 找最近活跃的会话文件；超过 maxAgeDays 或排不进 limit 的不看（全库 200+ 会话，别每轮都啃）。 */
export function listSessionFiles(home, { maxAgeDays = 3, limit = 60 } = {}) {
  const root = sessionRoot(home);
  if (!fs.existsSync(root)) return [];
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const out = [];
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws);
    try {
      if (!fs.statSync(wsDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const sid of fs.readdirSync(wsDir)) {
      const file = path.join(wsDir, sid, 'session.v4.jsonl.zstd');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      out.push({ id: sid, file, size: st.size, mtimeMs: st.mtimeMs, ws });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** 从 buf 的 from 位置起，按魔数切 zstd 帧→解压→拼文本；返回 { text, next }。 */
function decodeFrames(buf, from) {
  const starts = [];
  for (let i = from; i < buf.length; ) {
    const idx = buf.indexOf(MAGIC, i);
    if (idx < 0) break;
    starts.push(idx);
    i = idx + 4;
  }
  if (!starts.length) return { text: '', next: buf.length };
  const parts = [];
  let next = buf.length;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      if (k === starts.length - 1) {
        // 最后一帧还没写完：停在这一帧头，下次从这儿重来
        next = start;
        break;
      }
      // 中间坏帧：跳过，别让一个坏帧挡住后面全部
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), next };
}

function blankStat() {
  return { turns: new Map(), tail: '', lastTurn: 0 };
}

/** 把一段 JSONL 文本按轮累积到 stat（跨调用的半行先存 tail，下次拼上）。 */
function ingest(text, st) {
  if (!text) return;
  const all = (st.tail || '') + text;
  const lines = all.split('\n');
  // 末段没有换行符 = 可能被切了一半，留着下次
  st.tail = lines.pop() ?? '';
  let cur = st.lastTurn || 0;
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const type = e?.type;
    if (type === 'turn/start') {
      const t = e?.data?.turn;
      if (typeof t === 'number') cur = t;
      continue;
    }
    if (type !== 'assistant/message') continue;
    const blocks = e?.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const t = typeof e?.data?.turn === 'number' ? e.data.turn : cur;
    // 空答复计数（2026-11-13 加）：把 [] / {} 当正文输出、同时还挂着工具调用 = 自认「已结束」却继续跑的死循环
    let empty = 0;
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        const s = b.text.trim().replace(/\s+/g, '');
        if (!s || s === '[]' || s === '{}' || s === 'null') empty += 1;
      }
    }
    if (empty) {
      const re = st.turns.get(t) ?? { lines: 0, short: 0, total: 0, cnt: new Map() };
      re.empty = (re.empty || 0) + empty;
      st.turns.set(t, re);
    }
    let rtxt = '';
    for (const b of blocks) {
      if (b && b.type === 'reasoning' && typeof b.text === 'string') rtxt += b.text + '\n';
    }
    if (!rtxt.trim()) continue;
    const row = st.turns.get(t) ?? { lines: 0, short: 0, total: 0, cnt: new Map() };
    for (const ln of rtxt.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      row.lines += 1;
      if (s.length <= 2) row.short += 1;
      // 分句级计数：整行复读时短行占比可能很低，但同一句会反复出现上百次
      for (const raw of s.split(/[。！？!?；;]/)) {
        const n = raw.replace(/[\s，。、！？,.!?"'“”‘’《》()（）:：;；\-—…]/g, '');
        if (n.length < 2) continue;
        row.total += 1;
        row.cnt.set(n, (row.cnt.get(n) || 0) + 1);
      }
    }
    st.turns.set(t, row);
  }
  st.lastTurn = cur;
}

/** 对一组轮次行做判定（全量与最近窗口共用同一套口径）。 */
function judgeRows(rows) {
  let firstConsecutive = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.lines >= MIN_LINES && b.lines >= MIN_LINES && a.ratio > RATIO_WARN && b.ratio > RATIO_WARN) {
      firstConsecutive = b.turn;
      break;
    }
  }
  const hard = rows.find((r) => r.lines >= 100 && r.ratio > RATIO_HARD) ?? null;
  const peak = rows.reduce((m, r) => (r.ratio > m.ratio ? r : m), { turn: 0, ratio: 0, lines: 0 });
  // 分句重复信号（2026-11-13 加）：整句复读时短行占比可能只有 0.05，但 dedup 会掉到 0.5-0.75。
  // 基线取自最近 12 个会话：正常 ≥0.90，轻度 0.78-0.88，明显退化 0.54-0.71。
  // maxRepeatLen≥8 是防误报：改代码/整理记忆时 reasoning 里会大量重复同一个短符号
  // （`const`、`);`、字段名），dedup 会被压到 0.6 左右，但重复片段的长度只有 3-5 字，
  // 那不是复读。真复读重复的是整句（≥10 字）。
  const repHard = rows.find((r) => (r.segs >= 300 && r.dedup < 0.75 && r.maxRepeatLen >= 8) || (r.maxRepeat >= 50 && r.maxRepeatLen >= 10)) ?? null;
  const repWatch = rows.find((r) => r.segs >= 300 && r.dedup < 0.88 && r.maxRepeatLen >= 8) ?? null;
  const rep = repHard ?? repWatch ?? null;
  // 空答复（基线：8 个会话除故障那个外全部为 0，故障会话单轮 37 次）
  const emptyHard = rows.find((r) => r.empty >= 3) ?? null;
  let level = 'ok';
  if (hard || firstConsecutive !== null || repHard || emptyHard) level = 'warn';
  else if ((peak.lines >= MIN_LINES && peak.ratio > 0.1) || repWatch) level = 'watch';
  return {
    level,
    firstConsecutive,
    hard,
    peak,
    rep: rep ? { turn: rep.turn, dedup: Number(rep.dedup.toFixed(2)), maxRepeat: rep.maxRepeat, maxRepeatLen: rep.maxRepeatLen, hard: rep === repHard } : null,
    emptyTurn: emptyHard ? emptyHard.turn : null,
    emptyCount: emptyHard ? emptyHard.empty : 0,
  };
}

/** 把累积的 turns 表折成判定结果（口径同 tools/session-health.mjs）；recentTurns 只取最近 N 轮另算一档。 */
export function summarize(st, { recentTurns = 10 } = {}) {
  const rows = [...st.turns.entries()]
    .map(([turn, r]) => {
      let maxc = 0;
      let maxlen = 0;
      if (r.cnt) {
        for (const [k, v] of r.cnt) {
          if (v > maxc) {
            maxc = v;
            maxlen = k.length;
          }
        }
      }
      const total = r.total || 0;
      const uniq = r.cnt ? r.cnt.size : 0;
      return {
        turn,
        ratio: r.lines ? r.short / r.lines : 0,
        lines: r.lines,
        empty: r.empty || 0,
        segs: total,
        dedup: total ? uniq / total : 1,
        maxRepeat: maxc,
        maxRepeatLen: maxlen,
      };
    })
    .sort((a, b) => a.turn - b.turn);
  const all = judgeRows(rows);
  const recentRows = rows.slice(-Math.max(1, recentTurns));
  const recent = judgeRows(recentRows);
  const last = rows[rows.length - 1] || null;
  return {
    turns: rows.length,
    ...all,
    last,
    recent: { turns: recentRows.length, ...recent },
  };
}

/** 复读拦截日志按会话聚合（缺文件就空表；这信号只做辅证，不单独定档）。 */
export function readGuardHits(wsDir, { days = 3 } = {}) {
  const file = path.join(wsDir, '.cache', GUARD_LOG);
  const hits = new Map();
  let raw = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 8 * 1024 * 1024) {
      // 太大只读尾部 2MB，够覆盖最近几轮
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(2 * 1024 * 1024);
      fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch {
    return hits;
  }
  const cutoff = Date.now() - days * 86400000;
  for (const line of raw.split('\n')) {
    if (!line.includes('sessionId')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const sid = e?.sessionId;
    if (!sid) continue;
    const at = Date.parse(e?.at ?? '');
    if (Number.isFinite(at) && at < cutoff) continue;
    const h = hits.get(sid) ?? { loop: 0, sent: 0, cooldownPass: 0, lastAt: 0 };
    if (e.kind === 'loop') h.loop += 1;
    else if (e.kind === 'sent') h.sent += 1;
    if (e.recover === 'cooldown-pass') h.cooldownPass += 1;
    if (Number.isFinite(at) && at > h.lastAt) h.lastAt = at;
    hits.set(sid, h);
  }
  return hits;
}

/**
 * 建一个常驻巡检器。scan() 做增量、写状态文件；build() 只读结果（给路由/checkup）。
 */
function safeService(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * 会话标题解析器：冷会话走 sessionProjectionCache（零 IO），活会话走投影快照；
 * 60 秒内复用一份 id→title 表，避免每次 scan 重扫磁盘。
 */
export async function loadSessionTitles(ctx, home) {
  const next = new Map();
  const base = path.resolve(home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
    try {
      const query = safeService(ctx, 'sessionQuery');
      const cache = safeService(ctx, 'sessionProjectionCache');
      const raw = await query?.listSessions?.();
      const list = Array.isArray(raw) ? raw : [];
      for (const it of list) {
        const h = it?.header || it;
        if (!h?.id) continue;
        let t = '';
        try {
          const block = cache?.cachedSnapshot?.(h, ['title']);
          if (block?.values?.title) t = String(block.values.title);
        } catch {
          /* 落到 header */
        }
        if (!t) t = String(h?.title ?? h?.meta?.title ?? h?.projection?.title ?? '');
        if (t) next.set(String(h.id), t);
      }
    } catch {
      /* 取不到就保持空表，面板还会退化成短 id */
    }
  if (next.size === 0) {
    // 服务取不到时直接读投影缓存：record.rows.title.val 就是标题，文件名是去掉 session- 的 id
    try {
      const dir = path.join(base, 'storages', 'session_projcache', 'sessions');
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const uuid = name.slice(0, -5);
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          const t = j?.record?.rows?.title?.val;
          if (typeof t === 'string' && t) {
            next.set(uuid, t);
            next.set('session-' + uuid, t);
          }
        } catch {
          /* 坏文件跳过 */
        }
      }
    } catch {
      /* 缓存目录不存在就算了 */
    }
  }
  return next;
}

export function createSessionHealth({ wsDir, home, log = () => {}, maxAgeDays = 3, limit = 60, loadTitles = async () => new Map() }) {
  const statePath = path.join(wsDir, '.cache', STATE_NAME);
  const files = new Map(); // sessionId -> { size, offset, stat }
  let titles = new Map();
  let lastResult = null;

  /** 拉一次 id→标题表（失败保持上一份，判档不依赖它）。 */
  async function refreshTitles() {
    try {
      const next = await loadTitles();
      if (next instanceof Map) titles = next;
    } catch {
      /* 保持旧表 */
    }
  }

  function loadState() {
    try {
      const j = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      lastResult = j && typeof j === 'object' ? j : null;
    } catch {
      lastResult = null;
    }
  }

  function scan() {
    const t0 = Date.now();
    const list = listSessionFiles(home, { maxAgeDays, limit });
    const guard = readGuardHits(wsDir, { days: maxAgeDays });
    const sessions = [];
    let changed = 0;
    for (const item of list) {
      const prev = files.get(item.id);
      let st = prev?.stat;
      if (prev && prev.size === item.size) {
        // 文件没长：直接复用，零解压
      } else {
        let buf;
        try {
          buf = fs.readFileSync(item.file);
        } catch (e) {
          log('读会话失败 ' + item.id.slice(0, 8) + '：' + ((e && e.message) || e));
          continue;
        }
        const from = prev && prev.size < item.size && prev.offset <= buf.length ? prev.offset : 0;
        if (!st || from === 0) st = blankStat();
        const { text, next } = decodeFrames(buf, from);
        ingest(text, st);
        files.set(item.id, { size: item.size, offset: next, stat: st });
        changed += 1;
      }
      const r = summarize(st);
      const h = guard.get(item.id) ?? { loop: 0, sent: 0, cooldownPass: 0, lastAt: 0 };
      if (r.turns < 1) continue;
      const title = titles.get(item.id) || '';
      sessions.push({
        id: item.id,
        title,
        ws: item.ws,
        size: item.size,
        mtime: item.mtimeMs,
        turns: r.turns,
        level: r.level,
        peak: Number(r.peak.ratio.toFixed(3)),
        peakTurn: r.peak.turn,
        lastRatio: r.last ? Number(r.last.ratio.toFixed(3)) : 0,
        firstConsecutive: r.firstConsecutive,
        hardTurn: r.hard ? r.hard.turn : null,
        rep: r.rep,
        emptyTurn: r.emptyTurn,
        recentTurns: r.recent.turns,
        recentLevel: r.recent.level,
        recentPeak: Number(r.recent.peak.ratio.toFixed(3)),
        recentPeakTurn: r.recent.peak.turn,
        recentRep: r.recent.rep,
        recentEmptyTurn: r.recent.emptyTurn,
        loop: h.loop,
        sent: h.sent,
        cooldownPass: h.cooldownPass,
      });
    }
    sessions.sort((a, b) => (a.level === b.level ? b.mtime - a.mtime : (a.level === 'warn' ? -1 : b.level === 'warn' ? 1 : 0)));
    const summary = {
      total: sessions.length,
      warn: sessions.filter((s) => s.level === 'warn').length,
      watch: sessions.filter((s) => s.level === 'watch').length,
      ok: sessions.filter((s) => s.level === 'ok').length,
      recentWarn: sessions.filter((s) => s.recentLevel === 'warn').length,
      recentWatch: sessions.filter((s) => s.recentLevel === 'watch').length,
      recentOk: sessions.filter((s) => s.recentLevel === 'ok').length,
    };
    const result = { ok: true, at: Date.now(), tookMs: Date.now() - t0, scanned: list.length, changed, summary, sessions };
    lastResult = result;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(result), 'utf8');
      fs.renameSync(tmp, statePath);
    } catch (e) {
      log('写状态文件失败：' + ((e && e.message) || e));
    }
    return result;
  }

  loadState();
  return { scan, build: () => lastResult, statePath, refreshTitles, titleCount: () => titles.size };
}

/**
 * 挂进插件：启动 90 秒后扫一次（别跟开机抢），之后每 N 分钟一次；定时器 unref。
 * 同时注册 /api/mmy-knight/session-health（webServer 是可选能力，缺就跳过）。
 */
export function registerSessionHealth(ctx, cfg, wsDir) {
  const engine = createSessionHealth({
    wsDir,
    log: (m) => console.log('[mmy-knight] 会话健康：' + m),
    maxAgeDays: Number(cfg?.sessionHealthDays ?? 3) || 3,
    limit: 60,
    loadTitles: () => loadSessionTitles(ctx, process.env.DSH_HOME || path.join(os.homedir(), '.dsh')),
  });
  const enabled = () => Number(cfg?.sessionHealthEnabled ?? 1) !== 0;
  const intervalMs = () => Math.max(60, Number(cfg?.sessionHealthMinutes ?? 5) || 5) * 60_000;

  let ticks = 0;
  let lastTickError = '';
  const tick = async () => {
    if (!enabled()) return;
    ticks += 1;
    try {
      fs.appendFileSync(path.join(wsDir, '.cache', 'knight-health-tick.log'), new Date().toISOString() + ' tick=' + ticks + '\n');
    } catch {
      /* 日志写不进不影响巡检 */
    }
    try {
      await engine.refreshTitles();
    } catch (e) {
      lastTickError = 'titles: ' + ((e && e.message) || e);
    }
    try {
      const r = engine.scan();
      if (r.summary.warn || r.summary.watch) {
        console.log('[mmy-knight] 会话健康：扫描 ' + r.scanned + ' 个（解 ' + r.changed + ' 个）→ warn ' + r.summary.warn + ' / watch ' + r.summary.watch);
      }
    } catch (e) {
      lastTickError = String((e && e.message) || e);
      console.log('[mmy-knight] 会话健康：巡检失败 ' + lastTickError);
    }
  };
  // 注册后立刻跑一次：重启后马上有一份新数据，也绕开「定时器在某些宿主里不触发」的死角
  void tick();
  const first = setTimeout(tick, 10_000);
  first.unref?.();
  let timer = setInterval(tick, intervalMs());
  timer.unref?.();
  // 注意：ctx.effect(fn) 传入的回调会被当成「装配函数」立刻执行一次（2026-11-13 实测：
  // cleanup 紧跟 tick=1 出现），所以这里**不能**把 clearTimeout 放进 effect，否则定时器
  // 刚设好就被清掉。定时器本身 unref，进程退出自然没了。

  try {
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(() => {
        const handler = async (req, res) => {
          const send = (code, body) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
          };
          if (req.method !== 'GET') return send(405, { ok: false, error: 'method-not-allowed' });
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const want = url.searchParams.get('sessionId');
            const dbg = {
              enabled: enabled(),
              maxAgeDays: Number(cfg?.sessionHealthDays ?? 3) || 3,
              home: String(process.env.DSH_HOME || ''),
              ticks,
              lastTickError,
              titles: engine.titleCount(),
            };
            let result = engine.build();
            // 前端轮询就是我们的心跳：数据超过 60 秒就现扫一次，不指望后台定时器
            if (enabled() && (!result || Date.now() - Number(result.at || 0) > 60_000)) result = engine.scan();
            if (!result) return send(200, { ok: true, at: 0, summary: { total: 0, warn: 0, watch: 0, ok: 0 }, sessions: [], debug: dbg });
            if (want) {
              const hit = result.sessions.find((s) => s.id === want) ?? null;
              return send(200, { ok: true, at: result.at, summary: result.summary, session: hit, debug: dbg });
            }
            return send(200, { ...result, debug: dbg });
          } catch (e) {
            return send(500, { ok: false, error: String((e && e.message) || e) });
          }
        };
        const disposer = httpCtx.webServer.register({ kind: 'exact', path: '/api/mmy-knight/session-health', handler });
        return () => {
          try {
            disposer?.();
          } catch {
            /* 卸载期报错不影响别的插件 */
          }
        };
      });
    });
  } catch (e) {
    console.log('[mmy-knight] 会话健康：路由注册跳过（' + ((e && e.message) || e) + '）');
  }

  console.log('[mmy-knight] 会话健康巡检已装备（启动 90s 后扫一次，之后每 ' + Math.round(intervalMs() / 60000) + ' 分钟；只记录不拦截）');
  return engine;
}
