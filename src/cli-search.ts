import { loadConfig } from "./config.ts";
import { DatabaseManager } from "./db/database.ts";
import { TelegramBotService } from "./telegram/bot.ts";
import { FlightScanner } from "./scanner.ts";

async function main() {
  console.log("================================================================================");
  console.log(" FLIGHT HUNTER v1.0 - РУЧНОЕ СКАНИРОВАНИЕ НАПРАВЛЕНИЙ");
  console.log(" Поиск по всем активным заданиям | Сохранение в SQLite");
  console.log("================================================================================\n");

  const config = loadConfig();
  if (!config.travelpayoutsToken) {
    console.error("ОШИБКА: TRAVELPAYOUTS_TOKEN отсутствует в .env");
    process.exit(1);
  }

  const db = new DatabaseManager(config.databasePath);
  const bot = new TelegramBotService(config.telegramBotToken, config.telegramChatId);
  const scanner = new FlightScanner(config, db, bot);

  try {
    const summaries = await scanner.scanAllActiveProfiles();

    console.log("\n================================================================================");
    console.log(" РЕЗУЛЬТАТЫ СКАНИРОВАНИЯ И СОХРАНЕНИЯ В SQLITE");
    console.log("================================================================================");
    summaries.forEach(s => {
      console.log(`Задание: "${s.profileName}" (ID: ${s.profileId})`);
      console.log(`  • Запросов к API:      ${s.requestsMade}`);
      console.log(`  • Найдено тарифов:     ${s.offersFound}`);
      console.log(`  • В целевых датах:     ${s.targetDateOffers} (в бюджете: ${s.targetBudgetOffers})`);
      console.log(`  • Уведомлений:         ${s.notificationsSent}`);
      console.log(`  • Время выполнения:    ${s.durationSeconds} сек.`);
      console.log("");
    });

    console.log("--------------------------------------------------------------------------------");
    console.log(" ТОП НАЙДЕННЫХ БИЛЕТОВ ИЗ БАЗЫ SQLITE:");
    console.log("--------------------------------------------------------------------------------");
    const topOffers = db.getOffers({ limit: 10 });
    if (topOffers.length === 0) {
      console.log("В базе данных пока нет предложений.");
    } else {
      topOffers.forEach((o, i) => {
        const targetMark = o.isTargetDate ? " ⭐ [ЦЕЛЕВЫЕ ДАТЫ]" : "";
        console.log(`${i + 1}. ${o.origin} ➔ ${o.destinationName} (${o.departureDate})${targetMark}`);
        console.log(`   Цена за всех: $${o.priceTotal.toLocaleString()} ${o.currency} (1 взр: $${o.pricePerPassenger.toLocaleString()})`);
        console.log(`   Авиакомпания: ${o.airline} (Gate: ${o.gate || "N/A"}) | Класс: ${o.cabinClass.toUpperCase()}`);
        console.log(`   Багаж: [${o.baggageStatus}] ${o.baggageDetails}`);
        console.log(`   Ссылка на покупку: ${o.liveSearchUrl}`);
        console.log("");
      });
    }

  } catch (err: any) {
    console.error("Сбой сканирования:", err.message);
  }
}

main();
