import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FlightDataProvider, ProviderSearchParams, RawFlightResult } from "./provider-interface.ts";

const execFileAsync = promisify(execFile);

export class GoogleFlightsProvider implements FlightDataProvider {
  public readonly name = "Google Flights Engine (Experimental Live)";
  public readonly isLive = true;

  private totalRequestsToday = 0;
  private totalErrorsToday = 0;
  private scriptPath: string;

  constructor() {
    this.scriptPath = path.resolve(process.cwd(), "scripts", "google_flights_worker.py");
  }

  public hasCredentials(): boolean {
    // Open access via HTTP protocol
    return true;
  }

  public getStats() {
    return {
      requests: this.totalRequestsToday,
      errors: this.totalErrorsToday,
      costUsd: 0.00
    };
  }

  public async searchFlights(params: ProviderSearchParams): Promise<{
    results: RawFlightResult[];
    requestsCount: number;
    estimatedCostUsd: number;
  }> {
    const origin = params.origin.toUpperCase();
    const dest = params.destination.toUpperCase();
    const date = params.departureDate || new Date().toISOString().slice(0, 10);
    const seat = params.cabinClass === "any" ? "business" : params.cabinClass;
    const pax = String(params.passengers || 2);
    const curr = params.currency || "USD";
    const directOnly = String(Boolean(params.directOnly));

    this.totalRequestsToday++;

    try {
      const { stdout } = await execFileAsync("python", [
        this.scriptPath,
        origin,
        dest,
        date,
        seat,
        pax,
        curr,
        directOnly
      ], {
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024
      });

      const parsed = JSON.parse(stdout.trim());
      if (!parsed.success) {
        this.totalErrorsToday++;
        console.warn(`[GoogleFlightsProvider] Warning for ${origin}➔${dest} on ${date}: ${parsed.error}`);
        return { results: [], requestsCount: 1, estimatedCostUsd: 0.00 };
      }

      const results: RawFlightResult[] = (parsed.results || []).map((item: any) => ({
        origin: item.origin,
        destination: item.destination,
        departureDate: item.departureDate,
        departureTime: item.departureTime,
        departureIso: item.departureIso,
        airline: item.airline,
        flightNumber: item.flightNumber,
        gate: item.gate,
        plane: item.plane,
        transfers: item.transfers,
        cabinClass: item.cabinClass,
        pricePerPassenger: item.pricePerPassenger,
        priceTotal: item.priceTotal,
        currency: item.currency,
        foundAt: item.foundAt,
        isActual: true,
        deepLink: item.deepLink
      }));

      return {
        results,
        requestsCount: 1,
        estimatedCostUsd: 0.00
      };
    } catch (err: any) {
      this.totalErrorsToday++;
      console.warn(`[GoogleFlightsProvider] Execution error for ${origin}➔${dest}: ${err.message}`);
      return {
        results: [],
        requestsCount: 1,
        estimatedCostUsd: 0.00
      };
    }
  }
}
