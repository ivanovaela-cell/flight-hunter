import type { FlightDataProvider, ProviderSearchParams, RawFlightResult } from "./provider-interface.ts";
import type { CabinClass } from "../types.ts";

export class TravelpayoutsProvider implements FlightDataProvider {
  public readonly name = "Travelpayouts Data API v3";
  public readonly isLive = false; // Cached data from Aviasales users

  private token: string;
  private totalRequestsToday = 0;
  private totalErrorsToday = 0;

  constructor(token?: string) {
    this.token = token || process.env.TRAVELPAYOUTS_TOKEN || "";
  }

  public hasCredentials(): boolean {
    return Boolean(this.token && this.token.trim().length > 0);
  }

  public getStats() {
    return {
      requests: this.totalRequestsToday,
      errors: this.totalErrorsToday,
      costUsd: 0.00 // Free tier
    };
  }

  private mapCabinToTripClass(cabin: string): number {
    const c = (cabin || "").toLowerCase();
    switch (c) {
      case "business":
        return 1;
      case "first":
        return 2;
      case "premium_economy":
      case "economy":
      default:
        return 0;
    }
  }

  public async searchFlights(params: ProviderSearchParams): Promise<{
    results: RawFlightResult[];
    requestsCount: number;
    estimatedCostUsd: number;
  }> {
    if (!this.hasCredentials()) {
      throw new Error("Travelpayouts API token is missing. Please set TRAVELPAYOUTS_TOKEN in .env");
    }

    // If cabin is "any", query both economy (0) and business (1) and combine
    if (params.cabinClass === "any") {
      const ecoRes = await this.querySingleCabin({ ...params, cabinClass: "economy" });
      // polite delay
      await new Promise(r => setTimeout(r, 200));
      const bizRes = await this.querySingleCabin({ ...params, cabinClass: "business" });
      return {
        results: [...ecoRes.results, ...bizRes.results],
        requestsCount: ecoRes.requestsCount + bizRes.requestsCount,
        estimatedCostUsd: 0.00
      };
    }

    return await this.querySingleCabin(params);
  }

  private async querySingleCabin(params: ProviderSearchParams): Promise<{
    results: RawFlightResult[];
    requestsCount: number;
    estimatedCostUsd: number;
  }> {
    const url = new URL("https://api.travelpayouts.com/aviasales/v3/get_latest_prices");
    url.searchParams.set("currency", (params.currency || "usd").toLowerCase());
    url.searchParams.set("origin", params.origin.toUpperCase());
    url.searchParams.set("destination", params.destination.toUpperCase());
    url.searchParams.set("trip_class", String(this.mapCabinToTripClass(params.cabinClass)));
    url.searchParams.set("one_way", "true");
    url.searchParams.set("show_to_affiliates", "true");
    url.searchParams.set("limit", "30");

    if (params.month) {
      url.searchParams.set("period_type", "month");
      url.searchParams.set("beginning_of_period", `${params.month}-01`);
    } else if (params.departureDate) {
      const monthPrefix = params.departureDate.slice(0, 7);
      url.searchParams.set("period_type", "month");
      url.searchParams.set("beginning_of_period", `${monthPrefix}-01`);
    }

    this.totalRequestsToday++;

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-Access-Token": this.token,
          "User-Agent": "FlightHunter/1.0"
        }
      });
    } catch (err: any) {
      this.totalErrorsToday++;
      throw new Error(`Сетевая ошибка обращения к Travelpayouts API: ${err.message}`);
    }

    if (!res.ok) {
      this.totalErrorsToday++;
      const errText = await res.text();
      throw new Error(`Travelpayouts API error (${res.status} ${res.statusText}): ${errText}`);
    }

    const json = await res.json();
    const rawItems: any[] = json.data || [];
    const results: RawFlightResult[] = [];
    const passengers = Math.max(1, params.passengers || 1);

    for (const item of rawItems) {
      const transfers = item.number_of_changes ?? item.transfers ?? 0;

      // Filter transfers: 0 = direct only, 1 = max 1 transfer
      if (params.directOnly && transfers !== 0) {
        continue;
      }

      const departureIso = item.depart_date || item.departure_at || "";
      const departureDate = departureIso.slice(0, 10);
      const departureTime = departureIso.length >= 19 ? departureIso.slice(11, 19) : undefined;
      const singlePrice = item.value || item.price || 0;
      const totalPrice = singlePrice * passengers;

      results.push({
        origin: item.origin || params.origin,
        destination: item.destination || params.destination,
        departureDate,
        departureTime,
        departureIso,
        airline: item.airline || "",
        flightNumber: item.flight_number,
        gate: item.gate,
        transfers,
        cabinClass: params.cabinClass,
        pricePerPassenger: singlePrice,
        priceTotal: totalPrice,
        currency: params.currency || "USD",
        foundAt: item.found_at || new Date().toISOString(),
        isActual: item.actual !== false,
        deepLink: item.link ? `https://www.aviasales.ru${item.link}` : undefined
      });
    }

    return {
      results,
      requestsCount: 1,
      estimatedCostUsd: 0.00
    };
  }
}
