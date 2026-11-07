/**
 * 调度器投递失败自动重试。
 *
 * 背景：dsh-schedule 的 drive() 在「全部到点任务都失败」时不再设下一次 timer
 * （next=undefined），任务会永久休眠。每 N 秒调一次 requestDrive() 让它重新扫描，
 * 失败任务下一轮会重试。
 *
 * 取服务的方式：schedule 注册在根域，插件隔离域里 ctx.get('schedule') 拿不到，
 * 必须走 ctx.root.get('schedule')。
 */
export function registerScheduleRetry(ctx, cfg = {}, log = () => {}) {
  if (Number(cfg.scheduleRetryEnabled ?? 1) === 0) return null;
  const sec = Math.max(5, Number(cfg.scheduleRetryIntervalSec ?? 60) || 60);
  let probed = false;
  let lastErrorAt = 0;
  const tick = () => {
    try {
      const schedule = typeof ctx.root?.get === 'function' ? ctx.root.get('schedule') : undefined;
      if (!probed) {
        probed = true;
        log(`schedule=${typeof schedule} runtime=${typeof schedule?.runtime} requestDrive=${typeof schedule?.runtime?.requestDrive}`);
      }
      // 服务不存在时不再空转调用（以前可选链静默吞掉，日志也看不出）。
      if (typeof schedule?.runtime?.requestDrive !== 'function') return;
      schedule.runtime.requestDrive();
    } catch (e) {
      // 以前只在首次失败时记日志，后续失败全丢（P1）。改成限流记录：同一类错误 5 分钟一条。
      const now = Date.now();
      if (now - lastErrorAt > 5 * 60 * 1000) {
        lastErrorAt = now;
        log(`requestDrive 失败：${e?.message ?? e}`);
      }
    }
  };
  const timer = setInterval(tick, sec * 1000);
  timer.unref?.();
  // ctx.effect 不存在时也要有兜底清理，否则 timer 泄漏（P2）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => clearInterval(timer), 'dsh-mmy-knight: schedule retry timer');
  } else {
    process.once('exit', () => clearInterval(timer));
  }
  return timer;
}
