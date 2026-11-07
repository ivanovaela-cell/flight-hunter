import type { CabinClass } from "../types.ts";

export interface LiveLinkParams {
  origin: string; // e.g. "MOW" or "SVO"
  destination: string; // e.g. "PEK", "BJS", "BKK", "HAN"
  departureDate: string; // "YYYY-MM-DD" e.g. "2027-01-13"
  returnDate?: string; // "YYYY-MM-DD"
  cabinClass: CabinClass;
  passengers: number; // adults e.g. 2
  affiliateMarker?: string;
}

/**
 * Encodes cabin class into Aviasales standard URL letter:
 * - economy: "" (empty/omitted)
 * - premium_economy: "w"
 * - business: "c"
 * - first: "f"
 */
export function getAviasalesCabinCode(cabinClass: string): string {
  const c = (cabinClass || "").toLowerCase();
  switch (c) {
    case "business":
      return "c";
    case "premium_economy":
      return "w";
    case "first":
      return "f";
    case "economy":
    default:
      return "";
  }
}

/**
 * Formats YYYY-MM-DD into DDMM format for Aviasales route path.
 */
export function formatAviasalesDate(isoDate: string): string {
  const clean = (isoDate || "").trim().slice(0, 10);
  const parts = clean.split("-");
  if (parts.length < 3) return "";
  const day = parts[2].padStart(2, "0");
  const month = parts[1].padStart(2, "0");
  return `${day}${month}`;
}

/**
 * Generates an exact live search URL on Aviasales with pre-set passengers,
 * cabin class, dates, and origin/destination airports.
 *
 * Example output:
 * https://www.aviasales.ru/search/MOW1301BJSc2
 */
export function generateAviasalesLiveUrl(params: LiveLinkParams): string {
  const originCode = params.origin.toUpperCase().trim();
  // Map PEK or PKX to BJS (all Beijing airports) if desired or keep specific
  const destCode = params.destination.toUpperCase().trim();
  const departDateStr = formatAviasalesDate(params.departureDate);
  const cabinCode = getAviasalesCabinCode(params.cabinClass);
  const adults = Math.max(1, params.passengers || 1);

  let routePath = `${originCode}${departDateStr}${destCode}`;

  if (params.returnDate) {
    const returnDateStr = formatAviasalesDate(params.returnDate);
    routePath += `${returnDateStr}`;
  }

  // Trailing passenger & cabin code: e.g. "c2" for business + 2 adults
  const passengerCabinPart = `${cabinCode}${adults}`;
  const fullPath = `${routePath}${passengerCabinPart}`;

  let url = `https://www.aviasales.ru/search/${fullPath}`;
  if (params.affiliateMarker) {
    url += `?marker=${encodeURIComponent(params.affiliateMarker)}`;
  }

  return url;
}

/**
 * Generates an exact search URL for Google Flights.
 * Opens Google Flights in Russian with pre-filled route, dates, cabin class and passengers.
 */
export function generateGoogleFlightsUrl(params: LiveLinkParams): string {
  const origin = params.origin.toUpperCase().trim();
  const dest = params.destination.toUpperCase().trim();
  const date = params.departureDate.slice(0, 10);
  const cabin = (params.cabinClass || "").toLowerCase() === "business" ? "business" : "economy";
  const pax = params.passengers || 2;

  const query = `Flights to ${dest} from ${origin} on ${date} ${cabin} class for ${pax} adults`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}&hl=ru`;
}

/**
 * Generates a direct search URL for Google Hotels / отели.
 */
export function generateGoogleHotelsUrl(city: string): string {
  const query = `Hotels in ${city}`;
  return `https://www.google.com/travel/hotels?q=${encodeURIComponent(query)}&hl=ru`;
}
