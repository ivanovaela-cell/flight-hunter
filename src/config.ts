import path from "node:path";

export interface AppConfig {
  travelpayoutsToken: string;
  flightApiKey: string;
  flightApiMaxCredits: number;
  flightApiPlan: string;
  primaryProvider: "travelpayouts" | "flightapi";
  telegramBotToken?: string;
  telegramChatId?: string;
  pollIntervalHours: number;
  enableScheduler: boolean;
  databasePath: string;
  searchOrigin: string;
  searchCabin: "BUSINESS";
  searchPassengers: number;
  targetBudgetUsd: number;
  targetDatesStart: string; // "2027-01-12"
  targetDatesEnd: string;   // "2027-01-18"
  webPort: number;
}

export function loadConfig(): AppConfig {
  const travelpayoutsToken = process.env.TRAVELPAYOUTS_TOKEN || "";
  const flightApiKey = process.env.FLIGHTAPI_KEY?.trim() || "";
  const flightApiMaxCredits = parseInt(process.env.FLIGHTAPI_MAX_CREDITS || "50", 10);
  const flightApiPlan = process.env.FLIGHTAPI_PLAN || "free_trial";
  const primaryProvider = (process.env.PRIMARY_PROVIDER as any) === "flightapi" ? "flightapi" : "travelpayouts";
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim() || undefined;
  
  const pollIntervalHours = Math.max(1, parseInt(process.env.POLL_INTERVAL_HOURS || "1", 10));
  const enableScheduler = process.env.ENABLE_SCHEDULER !== "false" && process.env.ENABLE_SCHEDULER !== "0";
  const rawDbPath = process.env.DATABASE_PATH || "./data/flights.db";
  const databasePath = path.isAbsolute(rawDbPath)
    ? rawDbPath
    : path.resolve(process.cwd(), rawDbPath);

  const searchOrigin = process.env.SEARCH_ORIGIN || "MOW";
  const searchPassengers = parseInt(process.env.SEARCH_PASSENGERS || "2", 10);
  const targetBudgetUsd = parseFloat(process.env.TARGET_BUDGET_USD || "2000");
  const webPort = parseInt(process.env.WEB_PORT || "3000", 10);

  return {
    travelpayoutsToken,
    flightApiKey,
    flightApiMaxCredits,
    flightApiPlan,
    primaryProvider,
    telegramBotToken,
    telegramChatId,
    pollIntervalHours,
    enableScheduler,
    databasePath,
    searchOrigin,
    searchCabin: "BUSINESS",
    searchPassengers,
    targetBudgetUsd,
    targetDatesStart: "2027-01-12",
    targetDatesEnd: "2027-01-18",
    webPort
  };
}
