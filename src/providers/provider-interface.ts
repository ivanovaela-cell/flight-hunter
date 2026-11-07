import type { CabinClass, PriceStatus } from "../types.ts";

export interface ProviderSearchParams {
  origin: string;
  destination: string;
  departureDate?: string; // YYYY-MM-DD
  month?: string; // YYYY-MM
  passengers: number;
  cabinClass: CabinClass;
  directOnly: boolean;
  currency: "USD" | "EUR" | "RUB";
}

export interface RawFlightResult {
  origin: string;
  destination: string;
  departureDate: string; // YYYY-MM-DD
  departureTime?: string;
  departureIso: string;
  airline: string;
  flightNumber?: string | number;
  gate?: string;
  plane?: string;
  priceStatus?: PriceStatus;
  transfers: number;
  cabinClass: CabinClass;
  pricePerPassenger: number;
  priceTotal: number;
  currency: "USD" | "EUR" | "RUB";
  foundAt: string;
  isActual: boolean;
  deepLink?: string;
}

export interface FlightDataProvider {
  readonly name: string;
  readonly isLive: boolean; // false = cached, true = live confirmed
  hasCredentials(): boolean;
  searchFlights(params: ProviderSearchParams): Promise<{
    results: RawFlightResult[];
    requestsCount: number;
    estimatedCostUsd: number;
  }>;
}
