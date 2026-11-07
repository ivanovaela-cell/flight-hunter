import { loadConfig } from "./config.ts";
import { DatabaseManager } from "./db/database.ts";
import { TelegramBotService } from "./telegram/bot.ts";
import { FlightScanner } from "./scanner.ts";
import { FlightScheduler } from "./scheduler.ts";
import { WebServer } from "./server/web-server.ts";

async function main() {
  console.log("================================================================================");
  console.log(" ✈️  FLIGHT HUNTER v1.0 — АВТОНОМНЫЙ МОНИТОРИНГ И ПОИСК АВИАБИЛЕТОВ");
  console.log(" Универсальная система поиска: Бизнес, Эконом | Любая география | Live-верификация");
  console.log("================================================================================\n");

  const config = loadConfig();

  if (!config.travelpayoutsToken) {
    console.error("[FATAL] TRAVELPAYOUTS_TOKEN не задан в .env! Проверьте файл конфигурации.");
    process.exit(1);
  }

  // 1. Initialize SQLite Database
  console.log(`[DB] Инициализация базы данных SQLite: ${config.databasePath}`);
  const db = new DatabaseManager(config.databasePath);

  // 2. Initialize Telegram Bot Service
  const bot = new TelegramBotService(config.telegramBotToken, config.telegramChatId);

  // 3. Initialize Core Scanner
  const scanner = new FlightScanner(config, db, bot);

  // 4. Initialize Scheduler
  const scheduler = new FlightScheduler(config, scanner, db, bot);

  // 5. Connect Telegram Bot Handlers
  bot.setHandlers({
    onManualSearch: async () => {
      const summaries = await scanner.scanAllActiveProfiles();
      let text = `✅ <b>Ручное сканирование завершено!</b>\n\n`;

      summaries.forEach(s => {
        text += `🔹 <b>${s.profileName}</b>:\n`;
        text += `   • Запросов: <b>${s.requestsMade}</b> | Тарифов: <b>${s.offersFound}</b>\n`;
        text += `   • В целевых датах: <b>${s.targetDateOffers}</b> (в бюджете: <b>${s.targetBudgetOffers}</b>)\n\n`;
      });

      const topOffers = db.getOffers({ targetDatesOnly: true, limit: 3 });
      if (topOffers.length > 0) {
        text += `<b>Лучшие найденные варианты на целевые даты:</b>\n`;
        topOffers.forEach((o, i) => {
          text += `${i + 1}. <b>${o.destinationName}</b> (${o.departureDate})\n`;
          text += `   💰 <b>$${o.priceTotal.toLocaleString()} ${o.currency}</b> за всех (1 чел: $${o.pricePerPassenger})\n`;
          text += `   ✈️ ${o.airline} | Прямой | Багаж: [Не подтвержден]\n`;
          text += `   👉 <a href="${o.liveSearchUrl}">Проверить цену и купить</a>\n`;
        });
      }
      return text.trim();
    },

    onGetTopDeals: async () => {
      const deals = db.getOffers({ limit: 10 });
      if (deals.length === 0) {
        return "В базе пока нет предложений. Запустите /search для обновления.";
      }

      let text = "🏆 <b>ТОП-10 ПРЕДЛОЖЕНИЙ ИЗ БАЗЫ ДАННЫХ</b>\n";
      text += "<i>Цены рассчитаны по кэшу, наличие мест и итоговая цена не подтверждены</i>\n\n";

      deals.forEach((d, i) => {
        const star = d.isTargetDate ? " ⭐" : "";
        text += `<b>${i + 1}. ${d.origin} ➔ ${d.destinationName}</b>${star}\n`;
        text += `   📅 Дата: <b>${d.departureDate}</b> (${d.departureTime || "по расписанию"})\n`;
        text += `   💰 Цена за всех: <b>$${d.priceTotal.toLocaleString()} ${d.currency}</b> ($${d.pricePerPassenger}/чел)\n`;
        text += `   ✈️ Авиакомпания: ${d.airline} | Класс: ${d.cabinClass.toUpperCase()}\n`;
        text += `   🧳 Багаж: [BAGGAGE_UNKNOWN] Не подтвержден провайдером\n`;
        text += `   👉 <a href="${d.liveSearchUrl}">Проверить цену и купить</a>\n\n`;
      });

      return text.trim();
    },

    onGetDailySummary: async () => {
      await scheduler.sendDailySummary();
      return "Ежедневная сводка сформирована и отправлена.";
    },

    onGetStatus: async () => {
      const sched = scheduler.getStatus();
      const prov = db.getProviderStatus();
      const activeProfiles = db.getActiveProfiles();
      const offersCount = db.getOffers().length;

      return `
⚙️ <b>СТАТУС МОНИТОРИНГА FLIGHT HUNTER v1.0</b>

• Планировщик: <b>${sched.isRunning ? "АКТИВЕН ✅" : "ОСТАНОВЛЕН ⏸️"}</b>
• Интервал проверки: <b>каждые ${sched.intervalHours} ч</b>
• Активных поисковых заданий: <b>${activeProfiles.length}</b>
• Всего тарифов в базе: <b>${offersCount}</b>
• Провайдер: <b>${prov?.providerName || "Travelpayouts Data API v3"}</b>
• Веб-интерфейс: <b>http://localhost:${config.webPort}</b>
• База данных: SQLite (${config.databasePath})
      `.trim();
    },

    onClearSystem: async () => {
      const res = db.clearOffersAndAlerts();
      return `🧹 <b>Поисковая система очищена!</b>\n\n• Удалено устаревших тарифов: <b>${res.offersCleared}</b>\n• Сброшено отправленных алертов: <b>${res.alertsCleared}</b>\n\nБаза готова к свежему поиску. Нажмите <b>🔍 Найти билеты сейчас</b>, чтобы запустить поиск с чистого листа!`;
    }
  });

  // 6. Start Telegram Bot if configured
  if (bot.isConfigured()) {
    bot.startPolling();
    console.log("[TELEGRAM] Бот успешно подключен к Telegram API.");
  } else {
    console.log("[TELEGRAM] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы в .env.");
    console.log("             (Бот работает в автономном режиме без отправки уведомлений в мессенджер).");
  }

  // 7. Start Web Server
  const webServer = new WebServer(config.webPort, db, scanner, scheduler, bot, config);
  await webServer.start();

  // 8. Start Background Scheduler (if enabled)
  if (config.enableScheduler) {
    scheduler.start();
  } else {
    console.log("[SCHEDULER] ⏸️ Почасовой фоновый мониторинг отключен по запросу пользователя (ENABLE_SCHEDULER=false).");
  }

  // 9. Graceful shutdown
  const shutdown = async () => {
    console.log("\n[SYSTEM] Остановка службы Flight Hunter...");
    scheduler.stop();
    bot.stopPolling();
    await webServer.stop();
    console.log("[SYSTEM] Служба успешно остановлена. До свидания!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(err => {
  console.error("[CRITICAL ERROR]", err);
  process.exit(1);
});
