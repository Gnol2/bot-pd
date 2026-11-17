// Lớp nền cho mọi module (tương đương commands.Cog + tasks.loop của discord.py)
export class Cog {
  constructor(bot) {
    this.bot = bot;
    this.commands = {}; // { tenLenh: async (ctx, ...args) => {} }
    this._stopped = false;
    this._timers = new Set();
  }

  isSelf(message) {
    return !!this.bot.user && message.author.id === this.bot.user.id;
  }

  // Ngủ có thể huỷ khi unload module
  sleep(ms) {
    return new Promise((resolve) => {
      if (this._stopped) return;
      const t = setTimeout(() => {
        this._timers.delete(t);
        resolve();
      }, Math.max(0, ms));
      this._timers.add(t);
    });
  }

  // Tương đương @tasks.loop(...): chờ bot ready -> before() -> chạy ngay lần đầu -> lặp theo chu kỳ
  loop(label, intervalMs, fn, { before } = {}) {
    (async () => {
      await this.bot.readyPromise;
      if (this._stopped) return;
      if (before) await before();
      while (!this._stopped) {
        const started = Date.now();
        try {
          await fn();
        } catch (e) {
          console.error(`[${label}] LỖI vòng lặp:`, e);
        }
        if (this._stopped) break;
        await this.sleep(intervalMs - (Date.now() - started));
      }
    })();
  }

  // Tương đương @tasks.loop(time=datetime.time(hour, minute, tzinfo=UTC)): chạy mỗi ngày vào giờ UTC cố định
  dailyAtUTC(label, hour, minute, fn) {
    (async () => {
      await this.bot.readyPromise;
      while (!this._stopped) {
        const now = new Date();
        let next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0);
        if (next <= now.getTime()) next += 86400000;
        await this.sleep(next - now.getTime());
        if (this._stopped) break;
        try {
          await fn();
        } catch (e) {
          console.error(`[${label}] LỖI vòng lặp:`, e);
        }
      }
    })();
  }

  unload() {
    this._stopped = true;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }
}
