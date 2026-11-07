import { FlightScanner } from "./scanner.ts";
import { DatabaseManager } from "./db/database.ts";
import { TelegramBotService } from "./telegram/bot.ts";
import type { AppConfig } from "./config.ts";

export class FlightScheduler {
  private config: AppConfig;
  private scanner: FlightScanner;
  private db: DatabaseManager;
  private bot: TelegramBotService;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRunAt: Date | null = null;
  private lastDailySummaryDate: string | null = null;

  constructor(
    config: AppConfig,
    scanner: FlightScanner,
    db: DatabaseManager,
    bot: TelegramBotService
  ) {
    this.config = config;
    this.scanner = scanner;
    this.db = db;
    this.bot = bot;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const intervalMs = this.config.pollIntervalHours * 60 * 60 * 1000;
    console.log(`[SCHEDULER] Планировщик активен. Интервал проверок: каждые ${this.config.pollIntervalHours} ч.`);

    // Run first cycle
    this.executeCycle();

    this.timer = setInterval(() => {
      this.executeCycle();
    }, intervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[SCHEDULER] Планировщик остановлен.");
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      intervalHours: this.config.pollIntervalHours,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null
    };
  }

  public async executeCycle(): Promise<void> {
    try {
      this.lastRunAt = new Date();
      console.log(`\n[SCHEDULER TICK] Выполнение планового цикла сканирования (${this.lastRunAt.toISOString()})...`);

      // Scheduled monitoring uses the primary provider (FlightAPI if configured, or cache fallback)
      await this.scanner.scanAllActiveProfiles();

      // Check daily summary trigger
      const todayDate = new Date().toISOString().slice(0, 10);
      if (this.lastDailySummaryDate !== todayDate) {
        this.lastDailySummaryDate = todayDate;
        await this.sendDailySummary();
      }
    } catch (err: any) {
      console.error(`[SCHEDULER ERROR] Сбой цикла мониторинга: ${err.message}`);
    }
  }

  public async sendDailySummary(): Promise<boolean> {
    const activeProfiles = this.db.getActiveProfiles();
    if (activeProfiles.length === 0) return false;

    let body = `📊 <b>FLIGHT HUNTER — ЕЖЕДНЕВНАЯ СВОДКА</b>\n`;
    body += `⏰ <b>Время отчета:</b> ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК\n\n`;

    for (const p of activeProfiles) {
      const topOffers = this.db.getOffers({ profileId: p.id, targetDatesOnly: true, limit: 3 });
      body += `🔹 <b>${p.name}</b> (${p.cabinClass.toUpperCase()}, ${p.passengers} взр.):\n`;

      if (topOffers.length === 0) {
        body += `   <i>На целевые даты (${p.dateStart} .. ${p.dateEnd}) прямых билетов в кэше пока нет.</i>\n`;
      } else {
        topOffers.forEach((o, i) => {
          body += `   ${i + 1}. <b>${o.destinationName}</b> (${o.departureDate}): <b>$${o.priceTotal.toLocaleString()} ${o.currency}</b> (1 взр: $${o.pricePerPassenger})\n`;
          body += `      ✈️ ${o.airline} | Прямой | Багаж: [Не подтвержден]\n`;
          body += `      👉 <a href="${o.liveSearchUrl}">Проверить цену и купить</a>\n`;
        });
      }
      body += `\n`;
    }

    return await this.bot.sendAlert(body.trim());
  }
}
