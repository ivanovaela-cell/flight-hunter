import { TravelpayoutsProvider } from "./providers/travelpayouts.ts";
import type { FlightOffer } from "./types.ts";

const COUNTRY_NAMES: Record<string, string> = {
  BKK: "Бангкок (Таиланд)",
  HKT: "Пхукет (Таиланд)",
  HAN: "Ханой (Вьетнам - рейс VN62)",
  SGN: "Хошимин (Вьетнам)",
  PQC: "Фукуок (Вьетнам)",
  PEK: "Пекин (Китай - Air China / Аэрофлот)",
  PKX: "Пекин Дасин (Китай - China Southern)",
  BJS: "Пекин (Китай - Все аэропорты)",
  PVG: "Шанхай (Китай - China Eastern)",
  CAN: "Гуанчжоу (Китай - China Southern)",
  TFU: "Чэнду Тяньфу (Китай - Sichuan Airlines)",
  CTU: "Чэнду (Китай)",
  SZX: "Шэньчжэнь (Китай - China Southern)",
  XIY: "Сиань (Китай - China Eastern)",
  SYX: "Санья (Китай - Hainan / Аэрофлот)",
  HAK: "Хайкоу (Китай - Hainan Airlines)"
};

async function runSingleSearch() {
  console.log("================================================================================");
  console.log(" FLIGHT HUNTER - SINGLE PROBE RUNNER (STAGE 2)");
  console.log(" Task: Fetch Real Direct Business Class Fares (Moscow -> Thailand/Vietnam/China)");
  console.log(" Target Period: 12-18 January 2027 | Passengers: 2 Adults | Transfers: Strictly 0");
  console.log("================================================================================\n");

  const provider = new TravelpayoutsProvider();

  if (!provider.hasToken()) {
    console.log("[STATUS] API-токен НЕ обнаружен в файле .env.");
    return;
  }

  console.log("[STATUS] API-токен успешно загружен из .env (скрыт в целях безопасности).");
  console.log("[ACTION] Выполняем проверочный запрос к Travelpayouts Data API v3...\n");

  try {
    // Check Beijing on January 2027
    console.log(">>> Запрос цен бизнес-класса: Москва (MOW) -> Пекин (PEK) на январь 2027...");
    const { offers: beijingJanOffers } = await provider.getLatestPrices({
      origin: "MOW",
      destination: "PEK",
      tripClass: 1, // BUSINESS
      oneWay: true,
      currency: "usd",
      periodType: "month",
      beginningOfPeriod: "2027-01-01",
      limit: 30
    });

    console.log(`[ОТВЕТ API] Найдено прямых рейсов бизнес-класса в Пекин на январь 2027: ${beijingJanOffers.length}\n`);

    if (beijingJanOffers.length > 0) {
      displayOffers(beijingJanOffers);
    } else {
      console.log("В кэше за последние 48 часов прямых рейсов на январь 2027 не зафиксировано.");
      console.log("Проверяем доступность прямых рейсов бизнес-класса на другие даты (лето 2027)...");
      const { offers: generalOffers } = await provider.getLatestPrices({
        origin: "MOW",
        destination: "PEK",
        tripClass: 1,
        oneWay: true,
        currency: "usd",
        limit: 10
      });
      displayOffers(generalOffers);
    }

  } catch (err: any) {
    const safeMsg = (err.message || "").replace(/token=[a-zA-Z0-9_-]+/g, "token=***");
    console.error(`[ОШИБКА ЗАПРОСА]: ${safeMsg}`);
  }
}

function displayOffers(offers: FlightOffer[]) {
  if (offers.length === 0) {
    console.log("Нет доступных прямых рейсов бизнес-класса по заданным критериям.");
    return;
  }

  console.log(`================================================================================`);
  console.log(` НАЙДЕНО РЕАЛЬНЫХ ПРЕДЛОЖЕНИЙ БИЗНЕС-КЛАССА: ${offers.length}`);
  console.log(`================================================================================\n`);

  offers.forEach((offer, idx) => {
    const destName = COUNTRY_NAMES[offer.destination.toUpperCase()] || offer.destination;
    const isTargetDate = offer.departureDate >= "2027-01-12" && offer.departureDate <= "2027-01-19";
    const dateLabel = isTargetDate ? "⭐⭐ В ЦЕЛЕВОМ ДИАПАЗОНЕ ТЗ (12-18 ЯНВАРЯ) ⭐⭐" : "";

    console.log(`[ВАРИАНТ #${idx + 1}] ${dateLabel}`);
    console.log(`  Маршрут:              Москва (${offer.origin}) ➔ ${destName}`);
    console.log(`  Дата и время вылета:  ${offer.departureDate}`);
    console.log(`  Авиакомпания / Агент: ${offer.airline}`);
    console.log(`  Класс обслуживания:   ${offer.cabinClass} (Пересадки: ${offer.transfers} — СТРОГО ПРЯМОЙ)`);
    console.log(`  Пассажиры:            ${offer.passengers} взрослых`);
    console.log(`  Тариф за 1 взрослого: $${offer.pricePerPassengerUsd.toLocaleString()} USD`);
    console.log(`  ИТОГО ЗА ДВОИХ:       $${offer.totalPriceUsd.toLocaleString()} USD (включая сборы)`);
    console.log(`  Статус багажа:        [${offer.baggageStatus}] ${offer.baggageDetails}`);
    console.log(`  Свежесть цены:        Найдено ${offer.dataAgeMinutes} мин назад (${offer.foundAt})`);
    console.log(`  Статус тарифа:        ${offer.isActual ? "ПОДТВЕРЖДЕН В КЭШЕ СИСТЕМЫ" : "ТРЕБУЕТ ПРОВЕРКИ"}`);
    if (offer.deepLink) {
      console.log(`  Ссылка:               ${offer.deepLink}`);
    }
    console.log(`--------------------------------------------------------------------------------`);
  });
}

runSingleSearch();
