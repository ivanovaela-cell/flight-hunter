export type CabinClass = "economy" | "premium_economy" | "business" | "first" | "any";
export type TripType = "one_way" | "round_trip";
export type BaggagePreference = "none" | "1pc_23kg" | "2pc_32kg" | "any";

export type PriceStatus = 
  | "SEARCH_PRICE"       // Поисковая цена (исходный тариф из поиска)
  | "RECHECKED_PRICE"    // Перепроверено в API (наличие в выдаче подтверждено)
  | "BOOKING_VERIFIED"   // Проверено у продавца (рейс, дата, класс, пассажиры и цена совпали)
  | "OFFER_EXPIRED"      // Ссылка устарела (15 минут)
  | "NOT_AVAILABLE"      // Рейс недоступен / распродан у продавца
  | "PRICE_CHANGED"      // Цена изменилась при повторной проверке
  | "TIMEOUT"            // Сетевой тайм-аут при проверке
  | "ACCESS_DENIED"      // Доступ заблокирован WAF продавца (HTTP 403)
  | "ESTIMATED_CACHE";   // Оценочный расчет по кэшу Travelpayouts

export interface SearchProfile {
  id: number;
  name: string;
  origin: string; // e.g. "MOW", "CAN", "BKK", "JFK" or comma-separated
  originDisplay: string; // e.g. "Москва", "Гуанчжоу", "Бангкок"
  destination: string; // e.g. "PEK,BKK,HAN" or single code "BKK"
  destinationDisplay: string; // e.g. "Китай, Таиланд, Вьетнам" or "Бангкок"
  dateStart: string; // "YYYY-MM-DD"
  dateEnd: string;   // "YYYY-MM-DD"
  tripType: TripType;
  passengers: number; // adults e.g. 2
  cabinClass: CabinClass;
  transfers: number; // 0 = direct, 1 = max 1 transfer, -1 = any
  baggage: BaggagePreference;
  preferredAirlines?: string; // e.g. "SU,CA,CZ"
  excludedAirlines?: string; // e.g. "WZ,A4"
  budget: number; // total max price for all passengers
  currency: "USD" | "EUR" | "RUB";
  pollIntervalHours: number;
  notificationsEnabled: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface FlightOffer {
  id: number;
  profileId: number;
  offerHash: string;
  provider: string;
  origin: string;
  originAirport?: string;
  destination: string;
  destinationName: string;
  country: string;
  departureDate: string; // YYYY-MM-DD
  departureTime?: string; // HH:mm:ss
  departureIso: string;
  returnDate?: string;
  airline: string;
  flightNumber?: string | number;
  plane?: string;
  gate?: string;
  cabinClass: CabinClass;
  transfers: number;
  isDirect: boolean;
  passengers: number;
  pricePerPassenger: number;
  priceTotal: number;
  currency: "USD" | "EUR" | "RUB";
  isEstimated: boolean; // Always true for cached xN calculation
  estimatedNote: string;
  priceStatus?: PriceStatus;
  baggageStatus: "BAGGAGE_UNKNOWN" | "INCLUDED" | "EXTRA_FEE";
  baggageDetails: string;
  taxesIncluded: boolean;
  isConfirmed: boolean;
  foundAt: string;
  checkedAt: string;
  dataAgeMinutes: number;
  isActual: boolean;
  isTargetDate: boolean;
  isTargetBudget: boolean;
  liveSearchUrl: string; // Direct link to Aviasales live search
  deepLink?: string;
}

export interface PriceHistoryRecord {
  id: number;
  profileId: number;
  routeKey: string;
  departureDate: string;
  priceTotal: number;
  currency: string;
  recordedAt: string;
}

export interface NotificationRecord {
  id: number;
  profileId: number;
  offerHash: string;
  routeKey: string;
  priceTotal: number;
  previousMinPrice?: number;
  savings?: number;
  triggerReason: "SUB_BUDGET" | "NEW_MINIMUM" | "DROP_15_PERCENT";
  sentAt: string;
  messageText: string;
}

export interface ProviderStatus {
  providerName: string;
  isHealthy: boolean;
  lastCheckedAt: string;
  totalRequestsToday: number;
  totalErrorsToday: number;
  estimatedCostTodayUsd: number;
  lastErrorMessage?: string;
}

export interface ApplicationSettings {
  pollIntervalHours: number;
  defaultCurrency: "USD" | "EUR" | "RUB";
  webPort: number;
  telegramEnabled: boolean;
}

export interface ScanRunSummary {
  profileId: number;
  profileName: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  requestsMade: number;
  offersFound: number;
  targetDateOffers: number;
  targetBudgetOffers: number;
  notificationsSent: number;
  errors: string[];
}
