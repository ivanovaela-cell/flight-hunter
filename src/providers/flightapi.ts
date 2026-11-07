import type { FlightDataProvider, ProviderSearchParams, RawFlightResult } from "./provider-interface.ts";
import type { CabinClass } from "../types.ts";
import type { DatabaseManager } from "../db/database.ts";

export interface FlightApiStats {
  requests: number;
  errors: number;
  creditsUsed: number;
  creditsRemaining?: number;
  maxCredits: number;
  plan: string;
  costUsd: number;
}

export class FlightApiProvider implements FlightDataProvider {
  public readonly name = "FlightAPI.io";
  public readonly isLive = true;

  private apiKey: string;
  private maxCredits: number;
  private plan: string;
  private db?: DatabaseManager;

  private totalRequestsToday = 0;
  private totalErrorsToday = 0;
  private totalCreditsUsed = 0;

  // Metro-to-airport mapping
  private static readonly METRO_MAP: Record<string, string> = {
    MOW: "SVO",
    BJS: "PEK",
    SHA: "PVG",
    TYO: "NRT",
    SEL: "ICN",
    BKK: "BKK",
    HAN: "HAN"
  };

  constructor(apiKey?: string, maxCredits = 50, plan = "free_trial", db?: DatabaseManager) {
    this.apiKey = apiKey || process.env.FLIGHTAPI_KEY || "";
    this.maxCredits = maxCredits;
    this.plan = plan;
    this.db = db;

    if (this.db) {
      const summary = this.db.getCreditUsageSummary("flightapi");
      this.totalCreditsUsed = summary.totalUsed;
    }
  }

  public setApiKey(key: string): void {
    this.apiKey = key.trim();
  }

  public hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public setCreditLimit(limit: number): void {
    this.maxCredits = limit;
  }

  public setPlan(plan: string, maxCredits: number): void {
    this.plan = plan;
    this.maxCredits = maxCredits;
  }

  public getStats(): FlightApiStats {
    return {
      requests: this.totalRequestsToday,
      errors: this.totalErrorsToday,
      creditsUsed: this.totalCreditsUsed,
      creditsRemaining: Math.max(0, this.maxCredits - this.totalCreditsUsed),
      maxCredits: this.maxCredits,
      plan: this.plan,
      costUsd: 0.00
    };
  }

  private mapCabin(cabin: CabinClass): "Economy" | "Premium_Economy" | "Business" | "First" {
    switch (cabin) {
      case "business":
        return "Business";
      case "first":
        return "First";
      case "premium_economy":
        return "Premium_Economy";
      case "economy":
      default:
        return "Economy";
    }
  }

  public resolveAirportCode(code: string): string {
    const upper = code.trim().toUpperCase();
    return FlightApiProvider.METRO_MAP[upper] || upper;
  }

  public async searchFlights(params: ProviderSearchParams): Promise<{
    results: RawFlightResult[];
    requestsCount: number;
    estimatedCostUsd: number;
  }> {
    if (!this.hasCredentials()) {
      throw new Error("FlightAPI.io API-ключ не настроен. Укажите FLIGHTAPI_KEY в .env");
    }

    // Safety credit check: each search consumes 2 credits
    const costPerCall = 2;
    if (this.totalCreditsUsed + costPerCall > this.maxCredits) {
      const msg = `[FLIGHTAPI ЗАЩИТА] Лимит кредитов (${this.maxCredits}) исчерпан (использовано: ${this.totalCreditsUsed}). Запрос отменен для защиты от перерасхода.`;
      console.warn(msg);
      throw new Error(msg);
    }

    const dep = this.resolveAirportCode(params.origin);
    const arr = this.resolveAirportCode(params.destination);
    const date = params.departureDate || new Date().toISOString().slice(0, 10);
    const adults = Math.max(1, params.passengers || 2);
    const cabin = this.mapCabin(params.cabinClass);
    const currency = params.currency || "USD";

    const url = `https://api.flightapi.io/onewaytrip/${this.apiKey}/${dep}/${arr}/${date}/${adults}/0/0/${cabin}/${currency}`;

    this.totalRequestsToday++;
    this.totalCreditsUsed += costPerCall;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "FlightHunter/1.0"
        }
      });

      if (this.db) {
        this.db.recordCreditUsage("flightapi", costPerCall, Math.max(0, this.maxCredits - this.totalCreditsUsed), `search_${dep}_${arr}`);
      }

      if (!response.ok) {
        this.totalErrorsToday++;
        const errText = await response.text();
        throw new Error(`FlightAPI.io HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const results = this.parseResponse(data, params, dep, arr, date, adults, cabin, currency);

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

  private parseResponse(
    data: any,
    params: ProviderSearchParams,
    dep: string,
    arr: string,
    date: string,
    adults: number,
    cabin: string,
    currency: string
  ): RawFlightResult[] {
    const itineraries = data.itineraries || [];
    const legs = data.legs || [];
    const carriers = data.carriers || {};
    const agents = data.agents || {};

    const legMap = new Map<string, any>();
    if (Array.isArray(legs)) {
      for (const leg of legs) legMap.set(leg.id, leg);
    }

    const carrierMap = new Map<any, any>();
    if (Array.isArray(carriers)) {
      for (const c of carriers) carrierMap.set(c.id, c);
    } else if (typeof carriers === "object" && carriers !== null) {
      for (const [k, v] of Object.entries(carriers)) carrierMap.set(k, v);
    }

    const agentMap = new Map<any, any>();
    if (Array.isArray(agents)) {
      for (const a of agents) agentMap.set(a.id, a);
    } else if (typeof agents === "object" && agents !== null) {
      for (const [k, v] of Object.entries(agents)) agentMap.set(k, v);
    }

    const results: RawFlightResult[] = [];
    const foundAt = new Date().toISOString();

    for (const it of itineraries) {
      const legIds = it.leg_ids || [];
      const itLegs = legIds.map((id: string) => legMap.get(id)).filter(Boolean);

      if (itLegs.length === 0) continue;

      // Filter direct flights if required
      const isDirect = itLegs.length === 1 && (itLegs[0].stop_count === 0 || itLegs[0].segments?.length === 1);
      if (params.directOnly && !isDirect) {
        continue;
      }

      const firstLeg = itLegs[0];
      const carrierId = firstLeg.operating_carrier_ids?.[0] || firstLeg.marketing_carrier_ids?.[0];
      const carrierInfo = carrierMap.get(carrierId) || {};
      const carrierName = carrierInfo.name || carrierInfo.code || "Airlines";
      const flightNum = firstLeg.flight_number || (firstLeg.segment_ids?.[0] ? `FL-${firstLeg.id.slice(0, 6)}` : undefined);

      const departureIso = firstLeg.departure || `${date}T00:00:00`;
      const departureTime = departureIso.includes("T") ? departureIso.split("T")[1]?.slice(0, 5) : undefined;
      const transfers = Math.max(0, itLegs.length - 1 + (firstLeg.stop_count || 0));

      const pricingOptions = it.pricing_options || [];
      for (const opt of pricingOptions) {
        const agentId = opt.agent_ids?.[0] || opt.agent_id;
        const agent = agentMap.get(agentId) || {};
        const agentName = agent.name || agentId || "OTA Seller";

        const priceTotal = typeof opt.price === "number" ? opt.price : opt.price?.amount || 0;
        if (priceTotal <= 0) continue;

        const pricePerPassenger = adults > 0 ? Math.round((priceTotal / adults) * 100) / 100 : priceTotal;
        const deepLink = opt.deepLink || opt.url || opt.link;

        results.push({
          origin: dep,
          destination: arr,
          departureDate: date,
          departureTime,
          departureIso,
          airline: `${carrierName} [${agentName}]`,
          flightNumber: flightNum,
          gate: agentName, // store seller name in gate field for easy UI display
          priceStatus: "SEARCH_PRICE",
          transfers,
          cabinClass: params.cabinClass,
          pricePerPassenger,
          priceTotal,
          currency: currency as any,
          foundAt,
          isActual: true,
          deepLink
        });
      }
    }

    // Sort by total price ascending
    results.sort((a, b) => a.priceTotal - b.priceTotal);
    return results;
  }
}
