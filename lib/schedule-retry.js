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
  let diag = false;
  const tick = () => {
    try {
      const schedule = typeof ctx.root?.get === 'function' ? ctx.root.get('schedule') : undefined;
      if (!diag) {
        diag = true;
        log(`schedule=${typeof schedule} runtime=${typeof schedule?.runtime} requestDrive=${typeof schedule?.runtime?.requestDrive}`);
      }
      schedule?.runtime?.requestDrive?.();
    } catch (e) {
      if (!diag) {
        diag = true;
        log(`失败：${e?.message ?? e}`);
      }
    }
  };
  const timer = setInterval(tick, sec * 1000);
  timer.unref?.();
  ctx.effect?.(() => () => clearInterval(timer), 'dsh-mmy-knight: schedule retry timer');
  return timer;
}
