import crypto from "node:crypto";
import { TravelpayoutsProvider } from "./providers/travelpayouts.ts";
import { GoogleFlightsProvider } from "./providers/google-flights.ts";
import { FlightApiProvider } from "./providers/flightapi.ts";
import { AviaSeekProvider } from "./providers/aviaseek.ts";
import { DatabaseManager } from "./db/database.ts";
import { TelegramBotService } from "./telegram/bot.ts";
import { generateAviasalesLiveUrl } from "./utils/link-generator.ts";
import type { AppConfig } from "./config.ts";
import type { SearchProfile, FlightOffer, ScanRunSummary } from "./types.ts";

function resolveOperatingAirline(dest: string, flightNumber?: string, airline?: string): string {
  if (flightNumber) {
    if (flightNumber.startsWith("CA")) return "Air China";
    if (flightNumber.startsWith("3U")) return "Sichuan Airlines";
    if (flightNumber.startsWith("MU")) return "China Eastern";
    if (flightNumber.startsWith("CZ")) return "China Southern";
    if (flightNumber.startsWith("SU")) return "Аэрофлот";
  }
  if (airline && !airline.includes("Агентство") && airline.length > 2) return airline;
  const d = (dest || "").toUpperCase();
  if (d === "PEK" || d === "PKX") return "Air China / Аэрофлот";
  if (d === "TFU") return "Sichuan Airlines";
  if (d === "CAN") return "China Southern / Аэрофлот";
  if (d === "PVG") return "China Eastern / Аэрофлот";
  if (d === "SZX") return "China Southern";
  return "Регулярные авиалинии";
}

function getAirlineOfficialUrl(dest: string, flightNumber?: string): string {
  const d = (dest || "").toUpperCase();
  if (d === "TFU" || flightNumber?.startsWith("3U")) return "https://global.sichuanair.com";
  if (d === "CAN" || d === "SZX" || flightNumber?.startsWith("CZ")) return "https://www.csair.com";
  if (d === "PVG" || flightNumber?.startsWith("MU")) return "https://www.ceair.com";
  if (d === "PEK" || d === "PKX" || flightNumber?.startsWith("CA")) return "https://www.airchina.ru";
  return "https://www.aeroflot.ru";
}

export interface ScanExecutionOptions {
  includeGoogleFlights?: boolean;
  forceFlightApi?: boolean;
  includeAviaSeek?: boolean;
  provider?: "aviaseek" | "flightapi" | "travelpayouts" | "all";
}

export const AIRPORT_METADATA: Record<string, { name: string; country: string }> = {
  // China
  PEK: { name: "Пекин (Шоуду)", country: "Китай" },
  PKX: { name: "Пекин (Дасин)", country: "Китай" },
  BJS: { name: "Пекин (Все аэропорты)", country: "Китай" },
  PVG: { name: "Шанхай (Пудун)", country: "Китай" },
  SHA: { name: "Шанхай (Все аэропорты)", country: "Китай" },
  CAN: { name: "Гуанчжоу (Байюнь)", country: "Китай" },
  TFU: { name: "Чэнду (Тяньфу)", country: "Китай" },
  CTU: { name: "Чэнду (Все аэропорты)", country: "Китай" },
  SZX: { name: "Шэньчжэнь", country: "Китай" },
  XIY: { name: "Сиань", country: "Китай" },
  SYX: { name: "Санья (Хайнань)", country: "Китай" },
  HAK: { name: "Хайкоу", country: "Китай" },

  // Thailand
  BKK: { name: "Бангкок (Суварнабхуми)", country: "Таиланд" },
  DMK: { name: "Бангкок (Донмыанг)", country: "Таиланд" },
  HKT: { name: "Пхукет", country: "Таиланд" },
  CNX: { name: "Чиангмай", country: "Таиланд" },
  USM: { name: "Самуи", country: "Таиланд" },

  // Vietnam
  HAN: { name: "Ханой (Нойбай)", country: "Вьетнам" },
  SGN: { name: "Хошимин (Таншоннят)", country: "Вьетнам" },
  DAD: { name: "Дананг", country: "Вьетнам" },
  PQC: { name: "Фукуок", country: "Вьетнам" },
  CXR: { name: "Нячанг (Камрань)", country: "Вьетнам" },

  // Other Common Global Hubs
  MOW: { name: "Москва (Все аэропорты)", country: "Россия" },
  SVO: { name: "Москва (Шереметьево)", country: "Россия" },
  DME: { name: "Москва (Домодедово)", country: "Россия" },
  VKO: { name: "Москва (Внуково)", country: "Россия" },
  LED: { name: "Санкт-Петербург", country: "Россия" },
  DXB: { name: "Дубай", country: "ОАЭ" },
  DOH: { name: "Доха", country: "Катар" },
  IST: { name: "Стамбул", country: "Турция" },
  SIN: { name: "Сингапур", country: "Сингапур" },
  KUL: { name: "Куала-Лумпур", country: "Малайзия" },
  NRT: { name: "Токио (Нарита)", country: "Япония" },
  HND: { name: "Токио (Ханеда)", country: "Япония" },
  ICN: { name: "Сеул (Инчхон)", country: "Южная Корея" }
};

export class FlightScanner {
  private config: AppConfig;
  private provider: TravelpayoutsProvider;
  private googleProvider: GoogleFlightsProvider;
  private flightApiProvider: FlightApiProvider;
  private aviaSeekProvider: AviaSeekProvider;
  private db: DatabaseManager;
  private bot: TelegramBotService;
  private isScanning = false;

  constructor(config: AppConfig, db: DatabaseManager, bot: TelegramBotService) {
    this.config = config;
    this.provider = new TravelpayoutsProvider(config.travelpayoutsToken);
    this.googleProvider = new GoogleFlightsProvider();
    this.flightApiProvider = new FlightApiProvider(
      config.flightApiKey,
      config.flightApiMaxCredits,
      config.flightApiPlan,
      db
    );
    this.aviaSeekProvider = new AviaSeekProvider(true);
    this.db = db;
    this.bot = bot;
  }

  public getAviaSeekProvider(): AviaSeekProvider {
    return this.aviaSeekProvider;
  }

  public getFlightApiProvider(): FlightApiProvider {
    return this.flightApiProvider;
  }

  public getProvider(): TravelpayoutsProvider {
    return this.provider;
  }

  public getGoogleProvider(): GoogleFlightsProvider {
    return this.googleProvider;
  }

  public isBusy(): boolean {
    return this.isScanning;
  }

  public async scanAllActiveProfiles(options: ScanExecutionOptions = {}): Promise<ScanRunSummary[]> {
    if (this.isScanning) {
      throw new Error("Сканирование уже выполняется в другом процессе.");
    }

    const profiles = this.db.getActiveProfiles();
    const summaries: ScanRunSummary[] = [];

    this.isScanning = true;
    try {
      for (const profile of profiles) {
        const summary = await this.executeProfileScan(profile, options);
        summaries.push(summary);
      }
    } finally {
      this.isScanning = false;
    }

    return summaries;
  }

  public async scanProfileById(profileId: number, options: ScanExecutionOptions = {}): Promise<ScanRunSummary> {
    const profile = this.db.getProfileById(profileId);
    if (!profile) {
      throw new Error(`Профиль с ID ${profileId} не найден.`);
    }

    if (this.isScanning) {
      throw new Error("Сканирование уже выполняется в другом процессе.");
    }

    this.isScanning = true;
    try {
      return await this.executeProfileScan(profile, options);
    } finally {
      this.isScanning = false;
    }
  }

  private executeProfileScan(profile: SearchProfile, options: ScanExecutionOptions = {}): Promise<ScanRunSummary> {
    return new Promise(async (resolve) => {
      const startedAt = new Date().toISOString();
      const startTimeMs = Date.now();
      let requestsMade = 0;
      let offersFound = 0;
      let targetDateOffers = 0;
      let targetBudgetOffers = 0;
      let notificationsSent = 0;
      const errors: string[] = [];

      console.log(`\n================================================================================`);
      console.log(` [TASK] "${profile.name}" (ID: ${profile.id})`);
      console.log(` Маршрут: ${profile.originDisplay} (${profile.origin}) ➔ ${profile.destinationDisplay}`);
      console.log(` Даты: ${profile.dateStart} .. ${profile.dateEnd} | Класс: ${profile.cabinClass.toUpperCase()}`);
      console.log(` Пассажиры: ${profile.passengers} взр | Бюджет: $${profile.budget} ${profile.currency}`);
      console.log(`================================================================================`);

      const originCodes = profile.origin.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      const destCodes = profile.destination.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

      const excludedList = (profile.excludedAirlines || "")
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(Boolean);

      const isSpecific = Boolean(options.provider);
      const useFlightApi = options.provider === "flightapi" || (!isSpecific && Boolean(options.forceFlightApi || (this.config.primaryProvider === "flightapi" && this.flightApiProvider.hasCredentials())));
      const useTravelpayouts = options.provider === "travelpayouts" || (!isSpecific && !useFlightApi);
      const useAviaSeek = options.provider === "aviaseek" || (!isSpecific && options.includeAviaSeek && this.aviaSeekProvider.getIsEnabled());

      if (useFlightApi) {
        // ==============================================================
        // PRIMARY ENGINE: FlightAPI.io LIVE SEARCH
        // ==============================================================
        console.log(`>>> [FLIGHTAPI.IO] Использование живого API как основного провайдера...`);
        const stats = this.flightApiProvider.getStats();
        console.log(`    [КРЕДИТЫ] Использовано: ${stats.creditsUsed} / Лимит: ${stats.maxCredits} | Осталось: ${stats.creditsRemaining}`);

        // Expand dates to scan (target date or range)
        const dateList: string[] = [];
        if (profile.dateStart === profile.dateEnd) {
          dateList.push(profile.dateStart);
        } else {
          const dStart = new Date(profile.dateStart);
          const dEnd = new Date(profile.dateEnd);
          let cur = new Date(dStart);
          let dayLimit = 0;
          while (cur <= dEnd && dayLimit < 7) {
            dateList.push(cur.toISOString().slice(0, 10));
            cur.setDate(cur.getDate() + 1);
            dayLimit++;
          }
        }

        for (const originCode of originCodes) {
          for (const destCode of destCodes) {
            for (const sDate of dateList) {
              const currentStats = this.flightApiProvider.getStats();
              if (currentStats.creditsRemaining < 2) {
                const warnMsg = `[FLIGHTAPI ЗАЩИТА] Остаток кредитов (${currentStats.creditsRemaining}) недостаточен. Остановка опроса.`;
                console.warn(`    ${warnMsg}`);
                errors.push(warnMsg);
                break;
              }

              const destMeta = AIRPORT_METADATA[destCode] || { name: destCode, country: "Международный" };
              const originMeta = AIRPORT_METADATA[originCode] || { name: originCode, country: "Отправление" };

              try {
                requestsMade++;
                console.log(`>>> [FLIGHTAPI REQ] ${originMeta.name} [${originCode}] ➔ ${destMeta.name} [${destCode}] (${sDate})...`);

                const res = await this.flightApiProvider.searchFlights({
                  origin: originCode,
                  destination: destCode,
                  departureDate: sDate,
                  passengers: profile.passengers,
                  cabinClass: profile.cabinClass,
                  directOnly: profile.transfers === 0,
                  currency: profile.currency
                });

                if (res.results.length === 0) {
                  console.log(`    [FLIGHTAPI NO_RESULTS] Для ${destCode} на ${sDate} рейсов не найдено.`);
                  continue;
                }

                console.log(`    [FLIGHTAPI FOUND] Найдено предложений продавцов: ${res.results.length}`);

                for (const raw of res.results) {
                  if (profile.transfers === 0 && raw.transfers !== 0) continue;
                  const rawCarrier = (raw.airline || "").toUpperCase();
                  if (excludedList.some(ex => rawCarrier.includes(ex))) continue;

                  const isTargetDate = raw.departureDate >= profile.dateStart && raw.departureDate <= profile.dateEnd;
                  const isTargetBudget = raw.priceTotal <= profile.budget;

                  const hashInput = `${profile.id}-FLIGHTAPI-${raw.origin}-${raw.destination}-${raw.departureDate}-${raw.airline}-${raw.flightNumber || ""}-${raw.cabinClass}`;
                  const offerHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

                  const offer: Omit<FlightOffer, "id"> = {
                    profileId: profile.id,
                    offerHash,
                    provider: "FlightAPI.io",
                    origin: raw.origin,
                    destination: raw.destination,
                    destinationName: `${destMeta.name} (${destMeta.country})`,
                    country: destMeta.country,
                    departureDate: raw.departureDate,
                    departureTime: raw.departureTime,
                    departureIso: raw.departureIso,
                    airline: raw.airline,
                    flightNumber: raw.flightNumber,
                    gate: raw.gate || "Online OTA / Carrier",
                    cabinClass: raw.cabinClass,
                    transfers: raw.transfers,
                    isDirect: raw.transfers === 0,
                    passengers: profile.passengers,
                    pricePerPassenger: raw.pricePerPassenger,
                    priceTotal: raw.priceTotal,
                    currency: raw.currency,
                    isEstimated: false,
                    estimatedNote: `SEARCH_PRICE — живая котировка FlightAPI.io (${profile.passengers} взр., продавец: ${raw.gate}).`,
                    priceStatus: "SEARCH_PRICE",
                    baggageStatus: "BAGGAGE_UNKNOWN",
                    baggageDetails: "Норма багажа зависит от выбранного тарифа продавца.",
                    taxesIncluded: true,
                    isConfirmed: false,
                    foundAt: raw.foundAt,
                    checkedAt: startedAt,
                    dataAgeMinutes: 0,
                    isActual: true,
                    isTargetDate,
                    isTargetBudget,
                    liveSearchUrl: raw.deepLink || generateAviasalesLiveUrl({
                      origin: raw.origin,
                      destination: raw.destination,
                      departureDate: raw.departureDate,
                      cabinClass: raw.cabinClass,
                      passengers: profile.passengers
                    }),
                    deepLink: raw.deepLink
                  };

                  this.db.saveOffer(offer);
                  offersFound++;

                  const routeKey = `${offer.origin}:${offer.destination}`;
                  this.db.recordPriceHistory({
                    profileId: profile.id,
                    routeKey,
                    departureDate: offer.departureDate,
                    priceTotal: offer.priceTotal,
                    currency: offer.currency,
                    recordedAt: startedAt
                  });

                  if (isTargetDate) {
                    targetDateOffers++;
                    if (isTargetBudget) targetBudgetOffers++;
                  }

                  // Notification check
                  if (profile.notificationsEnabled && this.bot.isConfigured()) {
                    if (!this.db.wasNotificationSent(offer.offerHash)) {
                      let shouldNotify = false;
                      let triggerReason: "SUB_BUDGET" | "NEW_MINIMUM" | "DROP_15_PERCENT" = "SUB_BUDGET";

                      const prevMin = this.db.getHistoricalMinimum(routeKey, offer.departureDate);
                      const lastPrice = this.db.getLastPrice(routeKey, offer.departureDate);

                      if (!isTargetDate) {
                        shouldNotify = false;
                      } else if (isTargetBudget) {
                        shouldNotify = true;
                        triggerReason = "SUB_BUDGET";
                      } else if (prevMin !== null && offer.priceTotal < prevMin) {
                        shouldNotify = true;
                        triggerReason = "NEW_MINIMUM";
                      } else if (lastPrice !== null && lastPrice > 0 && ((lastPrice - offer.priceTotal) / lastPrice) >= 0.15) {
                        shouldNotify = true;
                        triggerReason = "DROP_15_PERCENT";
                      }

                      if (shouldNotify && notificationsSent < 2) {
                        const savings = prevMin && prevMin > offer.priceTotal ? prevMin - offer.priceTotal : undefined;
                        const messageHtml = this.formatTelegramMessage(offer, profile, prevMin, savings, triggerReason);
                        const buyUrl = offer.deepLink || offer.liveSearchUrl;
                        const airlineUrl = getAirlineOfficialUrl(offer.destination, offer.flightNumber);
                        const inlineKeyboard = [
                          [
                            { text: "✈️ Сайт авиакомпании", url: airlineUrl },
                            { text: "🔍 Aviasales", url: buyUrl }
                          ],
                          [
                            { text: "🧹 Очистить поиск", callback_data: "clear_system" }
                          ]
                        ];
                        const sentOk = await this.bot.sendAlert(messageHtml, inlineKeyboard);
                        if (sentOk) {
                          notificationsSent++;
                          this.db.recordNotification({
                            profileId: profile.id,
                            offerHash: offer.offerHash,
                            routeKey,
                            priceTotal: offer.priceTotal,
                            previousMinPrice: prevMin || undefined,
                            savings,
                            triggerReason,
                            sentAt: new Date().toISOString(),
                            messageText: messageHtml
                          });
                          console.log(`    [ALERT DISPATCHED] Уведомление отправлено: ${offer.destinationName} (${offer.departureDate}) за $${offer.priceTotal}`);
                        }
                      }
                    }
                  }
                }

                // Polite delay between calls (300ms)
                await new Promise(r => setTimeout(r, 300));
              } catch (err: any) {
                const errorMsg = `Ошибка FlightAPI ${destCode} (${sDate}): ${err.message}`;
                console.error(`    [ERROR] ${errorMsg}`);
                errors.push(errorMsg);
              }
            }
          }
        }
      }

      if (useTravelpayouts) {
        // ==============================================================
        // FALLBACK ENGINE: Travelpayouts Cached Data
        // ==============================================================
        console.log(`>>> [TRAVELPAYOUTS] Запуск поиска через Travelpayouts Cache...`);
        for (const originCode of originCodes) {
          for (const destCode of destCodes) {
            const destMeta = AIRPORT_METADATA[destCode] || { name: destCode, country: "Международный" };
            const originMeta = AIRPORT_METADATA[originCode] || { name: originCode, country: "Отправление" };

            try {
              console.log(`>>> Проверка: ${originMeta.name} [${originCode}] ➔ ${destMeta.name} [${destCode}]...`);
              requestsMade++;

              const response = await this.provider.searchFlights({
                origin: originCode,
                destination: destCode,
                departureDate: profile.dateStart,
                passengers: profile.passengers,
                cabinClass: profile.cabinClass,
                directOnly: profile.transfers === 0,
                currency: profile.currency
              });

              if (response.results.length === 0) {
                console.log(`    [NO_CACHE_DATA] Для ${destCode} билетов в кэше 48ч сейчас нет.`);
                continue;
              }

              console.log(`    [DATA_FOUND] Найдено вариантов: ${response.results.length}`);

              for (const raw of response.results) {
                if (profile.transfers === 0 && raw.transfers !== 0) continue;
                if (profile.transfers === 1 && raw.transfers > 1) continue;

                const rawCarrier = (raw.airline || "").toUpperCase();
                if (excludedList.some(ex => rawCarrier.includes(ex))) continue;

                const isTargetDate = raw.departureDate >= profile.dateStart && raw.departureDate <= profile.dateEnd;
                const isTargetBudget = raw.priceTotal <= profile.budget;

                const liveSearchUrl = generateAviasalesLiveUrl({
                  origin: raw.origin,
                  destination: raw.destination,
                  departureDate: raw.departureDate,
                  cabinClass: raw.cabinClass,
                  passengers: profile.passengers
                });

                const hashInput = `${profile.id}-TRAVELPAYOUTS-${raw.origin}-${raw.destination}-${raw.departureDate}-${raw.airline}-${raw.flightNumber || ""}-${raw.cabinClass}`;
                const offerHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

                const offer: Omit<FlightOffer, "id"> = {
                  profileId: profile.id,
                  offerHash,
                  provider: this.provider.name,
                  origin: raw.origin,
                  destination: raw.destination,
                  destinationName: `${destMeta.name} (${destMeta.country})`,
                  country: destMeta.country,
                  departureDate: raw.departureDate,
                  departureTime: raw.departureTime,
                  departureIso: raw.departureIso,
                  airline: raw.airline,
                  flightNumber: raw.flightNumber,
                  gate: raw.gate,
                  cabinClass: raw.cabinClass,
                  transfers: raw.transfers,
                  isDirect: raw.transfers === 0,
                  passengers: profile.passengers,
                  pricePerPassenger: raw.pricePerPassenger,
                  priceTotal: raw.priceTotal,
                  currency: raw.currency,
                  isEstimated: true,
                  estimatedNote: `ESTIMATED — цена рассчитана по кешу (${profile.passengers} чел.), наличие мест и итоговая стоимость не подтверждены.`,
                  baggageStatus: "BAGGAGE_UNKNOWN",
                  baggageDetails: "BAGGAGE_UNKNOWN — норма багажа в кэше отсутствует, требует уточнения перед покупкой.",
                  taxesIncluded: true,
                  isConfirmed: false,
                  foundAt: raw.foundAt,
                  checkedAt: startedAt,
                  dataAgeMinutes: 0,
                  isActual: true,
                  isTargetDate,
                  isTargetBudget,
                  liveSearchUrl,
                  deepLink: raw.deepLink
                };

                this.db.saveOffer(offer);
                offersFound++;

                const routeKey = `${offer.origin}:${offer.destination}`;
                this.db.recordPriceHistory({
                  profileId: profile.id,
                  routeKey,
                  departureDate: offer.departureDate,
                  priceTotal: offer.priceTotal,
                  currency: offer.currency,
                  recordedAt: startedAt
                });

                if (isTargetDate) {
                  targetDateOffers++;
                  if (isTargetBudget) targetBudgetOffers++;
                }

                if (profile.notificationsEnabled && this.bot.isConfigured()) {
                  if (!this.db.wasNotificationSent(offer.offerHash)) {
                    let shouldNotify = false;
                    let triggerReason: "SUB_BUDGET" | "NEW_MINIMUM" | "DROP_15_PERCENT" = "SUB_BUDGET";

                    const prevMin = this.db.getHistoricalMinimum(routeKey, offer.departureDate);
                    const lastPrice = this.db.getLastPrice(routeKey, offer.departureDate);

                    if (!isTargetDate) {
                      shouldNotify = false;
                    } else if (isTargetBudget) {
                      shouldNotify = true;
                      triggerReason = "SUB_BUDGET";
                    } else if (prevMin !== null && offer.priceTotal < prevMin) {
                      shouldNotify = true;
                      triggerReason = "NEW_MINIMUM";
                    } else if (lastPrice !== null && lastPrice > 0 && ((lastPrice - offer.priceTotal) / lastPrice) >= 0.15) {
                      shouldNotify = true;
                      triggerReason = "DROP_15_PERCENT";
                    }

                    if (shouldNotify && notificationsSent < 2) {
                      const savings = prevMin && prevMin > offer.priceTotal ? prevMin - offer.priceTotal : undefined;
                      const messageHtml = this.formatTelegramMessage(offer, profile, prevMin, savings, triggerReason);
                      const buyUrl = offer.deepLink || offer.liveSearchUrl;
                      const airlineUrl = getAirlineOfficialUrl(offer.destination, offer.flightNumber);
                      const inlineKeyboard = [
                        [
                          { text: "✈️ Сайт авиакомпании", url: airlineUrl },
                          { text: "🔍 Aviasales", url: buyUrl }
                        ],
                        [
                          { text: "🧹 Очистить поиск", callback_data: "clear_system" }
                        ]
                      ];
                      const sentOk = await this.bot.sendAlert(messageHtml, inlineKeyboard);
                      if (sentOk) {
                        notificationsSent++;
                        this.db.recordNotification({
                          profileId: profile.id,
                          offerHash: offer.offerHash,
                          routeKey,
                          priceTotal: offer.priceTotal,
                          previousMinPrice: prevMin || undefined,
                          savings,
                          triggerReason,
                          sentAt: new Date().toISOString(),
                          messageText: messageHtml
                        });
                        console.log(`    [ALERT DISPATCHED] Уведомление отправлено: ${offer.destinationName} (${offer.departureDate}) за $${offer.priceTotal}`);
                      }
                    }
                  }
                }
              }

              await new Promise(r => setTimeout(r, 350));
            } catch (err: any) {
              const errorMsg = `Ошибка при сканировании ${destCode}: ${err.message}`;
              console.error(`    [ERROR] ${errorMsg}`);
              errors.push(errorMsg);
            }
          }
        }
      }

      // Optional AviaSeek Live Meta Search
      if (useAviaSeek && this.aviaSeekProvider.getIsEnabled()) {
        console.log(`\n>>> [AVIASEEK] Запуск живого поиска через AviaSeek (Aviasales Live Meta)...`);
        
        // Generate list of dates to scan (up to 2 primary target dates to avoid HTTP client timeouts)
        const aviaDates: string[] = [];
        if (profile.dateStart === profile.dateEnd) {
          aviaDates.push(profile.dateStart);
        } else {
          // Add profile start date
          aviaDates.push(profile.dateStart);
          // Ensure key target date (2027-01-13) is checked if in range
          const keyTarget = "2027-01-13";
          if (keyTarget >= profile.dateStart && keyTarget <= profile.dateEnd && !aviaDates.includes(keyTarget)) {
            aviaDates.push(keyTarget);
          }
        }

        for (const originCode of originCodes) {
          for (const destCode of destCodes) {
            for (const sDate of aviaDates) {
              const destMeta = AIRPORT_METADATA[destCode] || { name: destCode, country: "Международный" };
              const originMeta = AIRPORT_METADATA[originCode] || { name: originCode, country: "Отправление" };

              try {
                requestsMade++;
                console.log(`>>> [AVIASEEK REQ] ${originMeta.name} [${originCode}] ➔ ${destMeta.name} [${destCode}] (${sDate})...`);
                const res = await this.aviaSeekProvider.searchFlights({
                  origin: originCode,
                  destination: destCode,
                  departureDate: sDate,
                  passengers: profile.passengers,
                  cabinClass: profile.cabinClass,
                  directOnly: profile.transfers === 0,
                  currency: profile.currency
                });

                for (const raw of res.results) {
                  if (profile.transfers === 0 && raw.transfers !== 0) continue;
                  const rawCarrier = (raw.airline || "").toUpperCase();
                  if (excludedList.some(ex => rawCarrier.includes(ex))) continue;

                  const isTargetDate = raw.departureDate >= profile.dateStart && raw.departureDate <= profile.dateEnd;
                  const isTargetBudget = raw.priceTotal <= profile.budget;

                  const hashInput = `${profile.id}-AVIASEEK-${raw.origin}-${raw.destination}-${raw.departureDate}-${raw.airline}-${raw.flightNumber || ""}-${raw.cabinClass}`;
                  const offerHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

                  const offer: Omit<FlightOffer, "id"> = {
                    profileId: profile.id,
                    offerHash,
                    provider: this.aviaSeekProvider.name,
                    origin: raw.origin,
                    destination: raw.destination,
                    destinationName: `${destMeta.name} (${destMeta.country})`,
                    country: destMeta.country,
                    departureDate: raw.departureDate,
                    departureTime: raw.departureTime,
                    departureIso: raw.departureIso,
                    airline: raw.airline,
                    flightNumber: raw.flightNumber,
                    gate: raw.gate,
                    cabinClass: raw.cabinClass,
                    transfers: raw.transfers,
                    isDirect: raw.transfers === 0,
                    passengers: profile.passengers,
                    pricePerPassenger: raw.pricePerPassenger,
                    priceTotal: raw.priceTotal,
                    currency: raw.currency,
                    isEstimated: false,
                    estimatedNote: `SEARCH_PRICE — живой тариф AviaSeek / Aviasales (${profile.passengers} взр., продавец: ${raw.gate}). Требует подтверждения при переходе к покупке.`,
                    priceStatus: "SEARCH_PRICE",
                    baggageStatus: "INCLUDED",
                    baggageDetails: "Багаж и ручная кладь включены (согласно данным AviaSeek).",
                    taxesIncluded: true,
                    isConfirmed: false,
                    foundAt: raw.foundAt,
                    checkedAt: startedAt,
                    dataAgeMinutes: 0,
                    isActual: true,
                    isTargetDate,
                    isTargetBudget,
                    liveSearchUrl: raw.deepLink || generateAviasalesLiveUrl({
                      origin: raw.origin,
                      destination: raw.destination,
                      departureDate: raw.departureDate,
                      cabinClass: raw.cabinClass,
                      passengers: profile.passengers
                    }),
                    deepLink: raw.deepLink
                  };

                  this.db.saveOffer(offer);
                  offersFound++;

                  const routeKey = `${offer.origin}:${offer.destination}`;
                this.db.recordPriceHistory({
                  profileId: profile.id,
                  routeKey,
                  departureDate: offer.departureDate,
                  priceTotal: offer.priceTotal,
                  currency: offer.currency,
                  recordedAt: startedAt
                });

                if (isTargetDate) {
                  targetDateOffers++;
                  if (isTargetBudget) targetBudgetOffers++;
                }
              }
              await new Promise(r => setTimeout(r, 300));
            } catch (err: any) {
              const errorMsg = `Ошибка AviaSeek ${destCode}: ${err.message}`;
              console.error(`    [ERROR] ${errorMsg}`);
              errors.push(errorMsg);
            }
          }
        }
      }
    }

      const finishedAt = new Date().toISOString();
      const durationSeconds = Math.round((Date.now() - startTimeMs) / 1000);

      this.db.updateProfileLastRun(profile.id, finishedAt);

      // Record provider health status
      if (useFlightApi) {
        const fStats = this.flightApiProvider.getStats();
        this.db.updateProviderStatus({
          providerName: this.flightApiProvider.name,
          isHealthy: errors.length === 0,
          lastCheckedAt: finishedAt,
          totalRequestsToday: fStats.requests,
          totalErrorsToday: fStats.errors,
          estimatedCostTodayUsd: fStats.costUsd,
          lastErrorMessage: errors.length > 0 ? errors[errors.length - 1] : undefined
        });
      } else {
        const stats = this.provider.getStats();
        this.db.updateProviderStatus({
          providerName: this.provider.name,
          isHealthy: errors.length === 0,
          lastCheckedAt: finishedAt,
          totalRequestsToday: stats.requests,
          totalErrorsToday: stats.errors,
          estimatedCostTodayUsd: stats.costUsd,
          lastErrorMessage: errors.length > 0 ? errors[errors.length - 1] : undefined
        });
      }

      console.log(`\n--------------------------------------------------------------------------------`);
      console.log(` Итоги задачи "${profile.name}":`);
      console.log(` Длительность: ${durationSeconds} сек | Запросов к API: ${requestsMade}`);
      console.log(` Всего тарифов: ${offersFound} | В целевые даты: ${targetDateOffers} | В бюджет: ${targetBudgetOffers}`);
      console.log(` Отправлено алертов в Telegram: ${notificationsSent} | Ошибок: ${errors.length}`);
      console.log(`--------------------------------------------------------------------------------\n`);

      resolve({
        profileId: profile.id,
        profileName: profile.name,
        startedAt,
        finishedAt,
        durationSeconds,
        requestsMade,
        offersFound,
        targetDateOffers,
        targetBudgetOffers,
        notificationsSent,
        errors
      });
    });
  }

  private formatTelegramMessage(
    offer: Omit<FlightOffer, "id">,
    profile: SearchProfile,
    prevMin: number | null,
    savings: number | undefined,
    reason: "SUB_BUDGET" | "NEW_MINIMUM" | "DROP_15_PERCENT"
  ): string {
    const reasonHeader = reason === "SUB_BUDGET"
      ? `🎯 <b>ЦЕНА В ПРЕДЕЛАХ БЮДЖЕТА $${profile.budget} ${profile.currency}!</b>`
      : reason === "DROP_15_PERCENT"
      ? "📉 <b>СНИЖЕНИЕ СТОИМОСТИ БОЛЕЕ ЧЕМ НА 15%!</b>"
      : "⚡ <b>НОВЫЙ ИСТОРИЧЕСКИЙ МИНИМУМ ТАРИФА!</b>";

    const prevMinLine = prevMin ? `\nПредыдущий минимум: $${prevMin.toLocaleString()} ${offer.currency}` : "";
    const savingsLine = savings ? `\nЭкономия: $${savings.toLocaleString()} ${offer.currency}` : "";
    const operatingAirline = resolveOperatingAirline(offer.destination, offer.flightNumber, offer.airline);
    const sellerLine = offer.gate ? ` (Продавец: ${offer.gate})` : "";
    const flightNum = offer.flightNumber ? ` (Рейс ${offer.flightNumber})` : "";
    const transfersText = offer.transfers === 0 ? "Прямой рейс (без пересадок)" : `С пересадками: ${offer.transfers}`;
    const buyUrl = offer.deepLink || offer.liveSearchUrl;
    const providerTag = offer.provider === "FlightAPI.io" ? "Живой тариф FlightAPI.io" : "Кэш Aviasales (Travelpayouts)";

    return `
<b>FLIGHT HUNTER — NEW DEAL</b>
${reasonHeader}

<b>${profile.name}</b>
<b>Маршрут:</b> ${offer.origin} ➔ ${offer.destinationName}
<b>Дата вылета:</b> ${offer.departureDate} ${offer.departureTime || "(по расписанию)"}
<b>Авиакомпания:</b> ${operatingAirline}${flightNum}
<b>Продавец тарифа:</b> ${offer.gate || "Авиакомпания / Агентство"}${sellerLine ? "" : ""}
<b>Пересадки:</b> ${transfersText}
<b>Класс:</b> ${offer.cabinClass.toUpperCase()} (180° кровать)
<b>Пассажиры:</b> ${offer.passengers} взрослых

💰 <b>Цена за одного:</b> $${offer.pricePerPassenger.toLocaleString()} ${offer.currency}
💵 <b>ИТОГО ЗА ВСЕХ:</b> <b>$${offer.priceTotal.toLocaleString()} ${offer.currency}</b> (включая сборы)
<i>⚠️ ${offer.estimatedNote}</i>${prevMinLine}${savingsLine}

🧳 <b>Норма багажа:</b> [BAGGAGE_UNKNOWN] Норма зависит от выбранного тарифа продавца
🧾 <b>Налоги и сборы:</b> Включены в тариф
📌 <b>Источник данных:</b> ${providerTag}
⏰ <b>Обновлено:</b> ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК
    `.trim();
  }
}
