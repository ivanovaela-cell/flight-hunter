import type { FlightDataProvider, ProviderSearchParams, RawFlightResult } from "./provider-interface.ts";

export interface AviaSeekFlightItem {
  id: string;
  airline_code: string;
  airline_name: string;
  flight_number: string;
  origin: string;
  destination: string;
  departure_at: string;
  arrival_at: string;
  price: number;
  currency: string;
  transfers: number;
  duration_minutes: number;
  is_round_trip: boolean;
  baggage?: {
    handbag?: number;
    baggage?: number;
    change?: boolean;
    return?: boolean;
  };
  booking_url: string;
  agent_name: string;
  title: string;
  summary: string;
  display_markdown: string;
}

export class AviaSeekProvider implements FlightDataProvider {
  public readonly name = "AviaSeek (Aviasales Live Meta)";
  public readonly isLive = true;

  private isEnabled = true;
  private totalRequestsToday = 0;
  private totalErrorsToday = 0;

  // Approximate USD to RUB conversion rate for USD queries
  private static readonly RUB_TO_USD_RATE = 100.0;

  constructor(enabled = true) {
    this.isEnabled = enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public getIsEnabled(): boolean {
    return this.isEnabled;
  }

  public hasCredentials(): boolean {
    return true; // Public API, no key required
  }

  public getStats() {
    return {
      requests: this.totalRequestsToday,
      errors: this.totalErrorsToday,
      costUsd: 0.00,
      isEnabled: this.isEnabled
    };
  }

  /**
   * Generates a persistent live search URL that re-queries prices on demand.
   * Format: https://aviaseek.com/results?flightSearch=AAAMMDDCCC[ycf][adults][children][infants]
   */
  public generateFreshSearchUrl(origin: string, destination: string, date: string, cabin: string, adults: number): string {
    const d = new Date(date);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const cabinChar = cabin.toLowerCase().startsWith("b") ? "c" : (cabin.toLowerCase().startsWith("f") ? "f" : "y");
    const searchCode = `${origin.toUpperCase()}${mm}${dd}${destination.toUpperCase()}${cabinChar}${adults}00`;
    return `https://aviaseek.com/results?flightSearch=${searchCode}`;
  }

  public async searchFlights(params: ProviderSearchParams): Promise<{
    results: RawFlightResult[];
    requestsCount: number;
    estimatedCostUsd: number;
  }> {
    if (!this.isEnabled) {
      return { results: [], requestsCount: 0, estimatedCostUsd: 0 };
    }

    const from = params.origin.trim().toUpperCase();
    const to = params.destination.trim().toUpperCase();
    const date = params.departureDate || new Date().toISOString().slice(0, 10);
    const adults = Math.max(1, params.passengers || 2);
    const cabin = params.cabinClass === "business" ? "business" : (params.cabinClass === "first" ? "first" : "economy");
    const direct = params.directOnly ? "1" : "0";

    const queryUrl = `https://aviaseek.com/api/flights?from=${from}&to=${to}&date=${date}&adults=${adults}&cabin=${cabin}&direct=${direct}&limit=30`;

    this.totalRequestsToday++;
    const foundAt = new Date().toISOString();

    try {
      const response = await fetch(queryUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "FlightHunter/1.0"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        this.totalErrorsToday++;
        const errText = await response.text();
        throw new Error(`AviaSeek HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const rawResults: AviaSeekFlightItem[] = data.results || [];

      // Persistent dynamic refresh URL
      const freshSearchUrl = data.view_all_url || this.generateFreshSearchUrl(from, to, date, cabin, adults);

      const results: RawFlightResult[] = [];

      for (const item of rawResults) {
        if (params.directOnly && item.transfers !== 0) {
          continue;
        }

        // Price formatting
        let priceTotal = item.price;
        let currency: "USD" | "EUR" | "RUB" = "RUB";

        // Convert to USD if requested
        if (params.currency === "USD" && item.currency === "RUB") {
          priceTotal = Math.round(item.price / AviaSeekProvider.RUB_TO_USD_RATE);
          currency = "USD";
        } else if (item.currency === "USD") {
          currency = "USD";
        }

        const pricePerPassenger = adults > 0 ? Math.round((priceTotal / adults) * 100) / 100 : priceTotal;
        const departureIso = item.departure_at || `${date}T00:00:00.000Z`;
        const realDepartureDate = departureIso.slice(0, 10);
        const departureTime = departureIso.includes("T") ? departureIso.split("T")[1]?.slice(0, 5) : undefined;

        // Specific booking link to this exact proposal
        const specificBookingUrl = item.booking_url || freshSearchUrl;

        results.push({
          origin: item.origin || from,
          destination: item.destination || to,
          departureDate: realDepartureDate,
          departureTime,
          departureIso,
          airline: `${item.airline_name} (${item.airline_code})`,
          flightNumber: item.flight_number,
          gate: item.agent_name ? `${item.agent_name} (Aviasales Partner)` : "Aviasales Live Partner",
          priceStatus: "SEARCH_PRICE",
          transfers: item.transfers,
          cabinClass: params.cabinClass,
          pricePerPassenger,
          priceTotal,
          currency,
          foundAt,
          isActual: true,
          deepLink: specificBookingUrl // Exact proposal booking URL (e.g. https://aviaseek.com/r/...)
        });
      }

      // Sort by price ascending
      results.sort((a, b) => a.priceTotal - b.priceTotal);

      return {
        results,
        requestsCount: 1,
        estimatedCostUsd: 0.00
      };
    } catch (err: any) {
      this.totalErrorsToday++;
      throw err;
    }
  }

  /**
   * Resolves proposal link into deep status:
   * Returns BOOKING_VERIFIED only if a concrete seller redirect (e.g. kupibilet / onetwotrip)
   * is present AND matches flight parameters.
   * If it redirects to /search or general results, returns OFFER_EXPIRED with isGeneralSearch: true.
   */
  public async resolveProposal(
    deepLink: string,
    offer: {
      airline: string;
      flightNumber?: string | number;
      departureDate: string;
      cabinClass: string;
      passengers: number;
    }
  ): Promise<{
    status: PriceStatus;
    isVerifiedSeller: boolean;
    isGeneralSearch: boolean;
    sellerName: string;
    finalBookingUrl: string;
    sellerRedirectUrl?: string;
    message: string;
  }> {
    if (!deepLink || !deepLink.startsWith("http")) {
      return {
        status: "OFFER_EXPIRED",
        isVerifiedSeller: false,
        isGeneralSearch: false,
        sellerName: "Не указан",
        finalBookingUrl: deepLink || "",
        message: "Ссылка предложения отсутствует"
      };
    }

    try {
      const res = await fetch(deepLink, {
        redirect: "manual",
        headers: { "User-Agent": "FlightHunter/1.0" },
        signal: AbortSignal.timeout(3500)
      });

      // Status 301/302: Check location header
      if (res.status === 301 || res.status === 302) {
        const loc = res.headers.get("location") || "";
        if (loc.startsWith("/search") || loc.includes("aviaseek.com/search") || loc.includes("aviaseek.com/results")) {
          return {
            status: "OFFER_EXPIRED",
            isVerifiedSeller: false,
            isGeneralSearch: true,
            sellerName: "AviaSeek (Общий поиск)",
            finalBookingUrl: loc.startsWith("http") ? loc : `https://aviaseek.com${loc}`,
            message: "Ссылка устарела: продавец перенаправляет на общий поиск"
          };
        }
        // Direct redirect to seller
        const parsed = new URL(loc);
        let sellerName = parsed.host.includes("kupibilet") ? "Купибилет" : (parsed.host.includes("onetwotrip") ? "OneTwoTrip" : parsed.host);
        return {
          status: "BOOKING_VERIFIED",
          isVerifiedSeller: true,
          isGeneralSearch: false,
          sellerName,
          finalBookingUrl: deepLink,
          sellerRedirectUrl: loc,
          message: `Тариф проверен у продавца ${sellerName}`
        };
      }

      if (res.status === 200) {
        const text = await res.text();
        const m = text.match(/window\.location\.replace\(["']([^"']+)["']\)/);
        if (m) {
          const sellerUrl = m[1].replace(/\\u0026/g, "&");
          const parsed = new URL(sellerUrl);
          let sellerName = "Продавец";
          if (parsed.host.includes("kupibilet.ru")) sellerName = "Купибилет";
          else if (parsed.host.includes("onetwotrip.com")) sellerName = "OneTwoTrip";
          else if (parsed.host.includes("aeroflot.ru")) sellerName = "Аэрофлот";
          else sellerName = parsed.host;

          // Verify flight match in Kupibilet step0 URL
          let matched = true;
          if (parsed.host.includes("kupibilet.ru")) {
            const path = parsed.pathname;
            const cabinChar = offer.cabinClass === "business" ? "C" : "Y";
            const expPrefix = `${cabinChar}${offer.passengers}00`;
            if (!path.includes(expPrefix)) {
              matched = false;
            }
          }

          if (matched) {
            return {
              status: "BOOKING_VERIFIED",
              isVerifiedSeller: true,
              isGeneralSearch: false,
              sellerName,
              finalBookingUrl: deepLink,
              sellerRedirectUrl: sellerUrl,
              message: `Тариф и параметры бронирования подтверждены (${sellerName})`
            };
          }
        }

        // Generic search shell
        if (text.includes("Flight search results") || text.includes("/results")) {
          return {
            status: "OFFER_EXPIRED",
            isVerifiedSeller: false,
            isGeneralSearch: true,
            sellerName: "AviaSeek (Общий поиск)",
            finalBookingUrl: "https://aviaseek.com/results",
            message: "Ссылка устарела: открывается общая поисковая выдача"
          };
        }

        if (text.includes("Предложение недоступно") || text.includes("устарели")) {
          return {
            status: "OFFER_EXPIRED",
            isVerifiedSeller: false,
            isGeneralSearch: false,
            sellerName: "Недоступно",
            finalBookingUrl: deepLink,
            message: "Срок действия предложения истек (15 минут)"
          };
        }
      }

      if (res.status === 410) {
        return {
          status: "OFFER_EXPIRED",
          isVerifiedSeller: false,
          isGeneralSearch: false,
          sellerName: "Недоступно",
          finalBookingUrl: deepLink,
          message: "Ссылка на бронирование устарела (HTTP 410 Gone)"
        };
      }

      if (res.status === 403) {
        return {
          status: "ACCESS_DENIED",
          isVerifiedSeller: false,
          isGeneralSearch: false,
          sellerName: "Неизвестно",
          finalBookingUrl: deepLink,
          message: "Сервер ограничил автоматическую проверку (HTTP 403)"
        };
      }

      return {
        status: "OFFER_EXPIRED",
        isVerifiedSeller: false,
        isGeneralSearch: false,
        sellerName: "Недоступно",
        finalBookingUrl: deepLink,
        message: `Сервер вернул статус HTTP ${res.status}`
      };
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("timed out") || err.name === "AbortError") {
        return {
          status: "TIMEOUT",
          isVerifiedSeller: false,
          isGeneralSearch: false,
          sellerName: "Неизвестно",
          finalBookingUrl: deepLink,
          message: "Тайм-аут при проверке ссылки (3.5 с)"
        };
      }
      return {
        status: "TIMEOUT",
        isVerifiedSeller: false,
        isGeneralSearch: false,
        sellerName: "Неизвестно",
        finalBookingUrl: deepLink,
        message: `Сетевая ошибка: ${err.message}`
      };
    }
  }

  /**
   * Fast check of booking link validity (< 3.5s).
   * Distinguishes VALID, OFFER_EXPIRED, ACCESS_DENIED, TIMEOUT.
   */
  public async checkBookingLink(deepLink: string, offer?: { airline: string; flightNumber?: string | number; departureDate: string; cabinClass: string; passengers: number }): Promise<{
    status: PriceStatus;
    httpStatus?: number;
    isGeneralSearch?: boolean;
    sellerName?: string;
    message: string;
  }> {
    const res = await this.resolveProposal(deepLink, offer || { airline: "", departureDate: "", cabinClass: "business", passengers: 2 });
    return {
      status: res.status,
      isGeneralSearch: res.isGeneralSearch,
      sellerName: res.sellerName,
      message: res.message
    };
  }

  /**
   * Performs an on-demand fresh search to find THE EXACT SAME FLIGHT.
   * Never substitutes other flights or carriers.
   */
  public async refreshSpecificFlight(offer: {
    origin: string;
    destination: string;
    departureDate: string;
    cabinClass: "economy" | "business" | "first";
    passengers: number;
    transfers: number;
    airline: string;
    flightNumber?: string | number;
    currency: "USD" | "EUR" | "RUB";
    priceTotal: number;
  }): Promise<{
    status: PriceStatus;
    isVerifiedSeller: boolean;
    isGeneralSearch: boolean;
    newBookingUrl?: string;
    newPriceTotal?: number;
    oldPriceTotal?: number;
    sellerName?: string;
    message: string;
  }> {
    const from = offer.origin.trim().toUpperCase();
    const to = offer.destination.trim().toUpperCase();
    const date = offer.departureDate;
    const adults = Math.max(1, offer.passengers || 2);
    const cabin = offer.cabinClass === "business" ? "business" : (offer.cabinClass === "first" ? "first" : "economy");
    const direct = "1"; // Strictly direct flight!

    const queryUrl = `https://aviaseek.com/api/flights?from=${from}&to=${to}&date=${date}&adults=${adults}&cabin=${cabin}&direct=${direct}&limit=30`;

    try {
      const response = await fetch(queryUrl, {
        headers: { Accept: "application/json", "User-Agent": "FlightHunter/1.0" },
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        if (response.status === 403) {
          return { status: "ACCESS_DENIED", isVerifiedSeller: false, isGeneralSearch: false, message: "Сервер поставщика ограничил доступ (HTTP 403 Forbidden)" };
        }
        return { status: "TIMEOUT", isVerifiedSeller: false, isGeneralSearch: false, message: `Ошибка API поставщика: HTTP ${response.status}` };
      }

      const data = await response.json();
      const rawResults: AviaSeekFlightItem[] = data.results || [];

      // Match the EXACT SAME FLIGHT
      const targetFlightNum = String(offer.flightNumber || "").replace(/\D/g, "");
      const targetAirline = offer.airline.toUpperCase();

      const matchedItem = rawResults.find((item) => {
        if (item.transfers !== 0) return false;
        const itemNum = String(item.flight_number || "").replace(/\D/g, "");
        const numMatches = targetFlightNum ? (itemNum === targetFlightNum) : true;
        const codeMatches = targetAirline.includes(item.airline_code?.toUpperCase()) ||
                            targetAirline.includes(item.airline_name?.toUpperCase());
        return codeMatches && numMatches;
      });

      if (!matchedItem) {
        return {
          status: "NOT_AVAILABLE",
          isVerifiedSeller: false,
          isGeneralSearch: false,
          message: `Рейс ${offer.airline} ${offer.flightNumber || ""} на ${offer.departureDate} (класс ${offer.cabinClass.toUpperCase()}, ${adults} взр.) более не найден у продавцов.`
        };
      }

      let priceTotal = matchedItem.price;
      if (offer.currency === "USD" && matchedItem.currency === "RUB") {
        priceTotal = Math.round(matchedItem.price / AviaSeekProvider.RUB_TO_USD_RATE);
      }

      // Check whether the fresh booking URL actually resolves to a verified seller
      const resolved = await this.resolveProposal(matchedItem.booking_url, offer);

      if (resolved.isGeneralSearch) {
        return {
          status: "OFFER_EXPIRED",
          isVerifiedSeller: false,
          isGeneralSearch: true,
          newBookingUrl: matchedItem.booking_url,
          newPriceTotal: priceTotal,
          sellerName: "AviaSeek (Общий поиск)",
          message: "Рейс найден в выдаче, но ссылка ведет на общий поиск источника"
        };
      }

      if (priceTotal !== offer.priceTotal) {
        return {
          status: "PRICE_CHANGED",
          isVerifiedSeller: resolved.isVerifiedSeller,
          isGeneralSearch: false,
          newBookingUrl: matchedItem.booking_url,
          newPriceTotal: priceTotal,
          oldPriceTotal: offer.priceTotal,
          sellerName: resolved.sellerName || matchedItem.agent_name,
          message: `Цена изменилась: $${priceTotal} (ранее: $${offer.priceTotal})`
        };
      }

      return {
        status: resolved.status === "BOOKING_VERIFIED" ? "BOOKING_VERIFIED" : "RECHECKED_PRICE",
        isVerifiedSeller: resolved.isVerifiedSeller,
        isGeneralSearch: false,
        newBookingUrl: matchedItem.booking_url,
        newPriceTotal: priceTotal,
        sellerName: resolved.sellerName || matchedItem.agent_name,
        message: `Рейс подтвержден у продавца ${resolved.sellerName || matchedItem.agent_name || "Купибилет"}`
      };
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("timed out") || err.name === "AbortError") {
        return { status: "TIMEOUT", isVerifiedSeller: false, isGeneralSearch: false, message: "Тайм-аут при обращении к API поставщика (сервер не ответил вовремя)" };
      }
      return { status: "TIMEOUT", isVerifiedSeller: false, isGeneralSearch: false, message: `Сетевая ошибка: ${err.message}` };
    }
  }

  /**
   * Verify and get booking URL with strict rules
   */
  public async verifyAndGetBookingUrl(offer: {
    origin: string;
    destination: string;
    departureDate: string;
    cabinClass: "economy" | "business" | "first";
    passengers: number;
    transfers: number;
    airline: string;
    flightNumber?: string | number;
    currency: "USD" | "EUR" | "RUB";
    priceTotal?: number;
    deepLink?: string;
  }): Promise<{
    status: PriceStatus;
    isVerifiedSeller: boolean;
    isGeneralSearch: boolean;
    bookingUrl?: string;
    sellerName?: string;
    priceTotal?: number;
    currency?: string;
    message: string;
  }> {
    // 1. Resolve existing link
    if (offer.deepLink) {
      const resolved = await this.resolveProposal(offer.deepLink, offer);
      if (resolved.status === "BOOKING_VERIFIED") {
        return {
          status: "BOOKING_VERIFIED",
          isVerifiedSeller: true,
          isGeneralSearch: false,
          bookingUrl: offer.deepLink,
          sellerName: resolved.sellerName,
          priceTotal: offer.priceTotal,
          currency: offer.currency,
          message: resolved.message
        };
      }
      if (resolved.status === "ACCESS_DENIED") {
        return {
          status: "ACCESS_DENIED",
          isVerifiedSeller: false,
          isGeneralSearch: false,
          bookingUrl: offer.deepLink,
          sellerName: resolved.sellerName,
          message: resolved.message
        };
      }
      if (resolved.status === "TIMEOUT") {
        return {
          status: "TIMEOUT",
          isVerifiedSeller: false,
          isGeneralSearch: false,
          bookingUrl: offer.deepLink,
          sellerName: resolved.sellerName,
          message: resolved.message
        };
      }
    }

    // 2. Link is expired or leads to general search: attempt fresh live search for the EXACT SAME flight
    const refresh = await this.refreshSpecificFlight({
      origin: offer.origin,
      destination: offer.destination,
      departureDate: offer.departureDate,
      cabinClass: offer.cabinClass,
      passengers: offer.passengers,
      transfers: offer.transfers,
      airline: offer.airline,
      flightNumber: offer.flightNumber,
      currency: offer.currency,
      priceTotal: offer.priceTotal || 0
    });

    return {
      status: refresh.status,
      isVerifiedSeller: refresh.isVerifiedSeller,
      isGeneralSearch: refresh.isGeneralSearch,
      bookingUrl: refresh.newBookingUrl,
      sellerName: refresh.sellerName,
      priceTotal: refresh.newPriceTotal,
      currency: offer.currency,
      message: refresh.message
    };
  }
}
