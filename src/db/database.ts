import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  SearchProfile,
  FlightOffer,
  PriceHistoryRecord,
  NotificationRecord,
  ProviderStatus,
  ApplicationSettings
} from "../types.ts";

export class DatabaseManager {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
    this.seedDefaultProfiles();
    this.cleanupLegacyStatuses();
  }

  private initSchema(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'MOW',
        origin_display TEXT NOT NULL DEFAULT 'Москва',
        destination TEXT NOT NULL,
        destination_display TEXT NOT NULL,
        date_start TEXT NOT NULL,
        date_end TEXT NOT NULL,
        trip_type TEXT NOT NULL DEFAULT 'one_way',
        passengers INTEGER NOT NULL DEFAULT 2,
        cabin_class TEXT NOT NULL DEFAULT 'business',
        transfers INTEGER NOT NULL DEFAULT 0,
        baggage TEXT NOT NULL DEFAULT 'preferred',
        preferred_airlines TEXT,
        excluded_airlines TEXT,
        budget REAL NOT NULL DEFAULT 2000,
        currency TEXT NOT NULL DEFAULT 'USD',
        poll_interval_hours INTEGER NOT NULL DEFAULT 2,
        notifications_enabled INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS flight_offers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        offer_hash TEXT UNIQUE NOT NULL,
        provider TEXT NOT NULL,
        origin TEXT NOT NULL,
        origin_airport TEXT,
        destination TEXT NOT NULL,
        destination_name TEXT NOT NULL,
        country TEXT NOT NULL,
        departure_date TEXT NOT NULL,
        departure_time TEXT,
        departure_iso TEXT NOT NULL,
        return_date TEXT,
        airline TEXT NOT NULL,
        flight_number TEXT,
        gate TEXT,
        cabin_class TEXT NOT NULL,
        transfers INTEGER NOT NULL DEFAULT 0,
        is_direct INTEGER NOT NULL DEFAULT 1,
        passengers INTEGER NOT NULL DEFAULT 2,
        price_per_passenger REAL NOT NULL,
        price_total REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        is_estimated INTEGER NOT NULL DEFAULT 1,
        estimated_note TEXT NOT NULL,
        baggage_status TEXT NOT NULL DEFAULT 'BAGGAGE_UNKNOWN',
        baggage_details TEXT NOT NULL,
        taxes_included INTEGER NOT NULL DEFAULT 1,
        is_confirmed INTEGER NOT NULL DEFAULT 0,
        plane TEXT,
        price_status TEXT DEFAULT 'SEARCH_PRICE',
        found_at TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        data_age_minutes INTEGER NOT NULL DEFAULT 0,
        is_actual INTEGER NOT NULL DEFAULT 1,
        is_target_date INTEGER NOT NULL DEFAULT 0,
        is_target_budget INTEGER NOT NULL DEFAULT 0,
        live_search_url TEXT NOT NULL,
        deep_link TEXT,
        FOREIGN KEY(profile_id) REFERENCES search_profiles(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_offers_profile ON flight_offers(profile_id);
      CREATE INDEX IF NOT EXISTS idx_offers_target_price ON flight_offers(is_target_date, is_target_budget, price_total);

      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        route_key TEXT NOT NULL,
        departure_date TEXT NOT NULL,
        price_total REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_history_route_date ON price_history(route_key, departure_date, recorded_at);

      CREATE TABLE IF NOT EXISTS provider_status (
        provider_name TEXT PRIMARY KEY,
        is_healthy INTEGER NOT NULL DEFAULT 1,
        last_checked_at TEXT NOT NULL,
        total_requests_today INTEGER NOT NULL DEFAULT 0,
        total_errors_today INTEGER NOT NULL DEFAULT 0,
        estimated_cost_today_usd REAL NOT NULL DEFAULT 0,
        last_error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS notification_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        offer_hash TEXT UNIQUE NOT NULL,
        route_key TEXT NOT NULL,
        price_total REAL NOT NULL,
        previous_min_price REAL,
        savings REAL,
        trigger_reason TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        message_text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS application_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_credit_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        credits_used INTEGER NOT NULL,
        credits_remaining INTEGER,
        operation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // Safe column migrations for experimental providers
    try { this.db.exec("ALTER TABLE flight_offers ADD COLUMN plane TEXT;"); } catch {}
    try { this.db.exec("ALTER TABLE flight_offers ADD COLUMN price_status TEXT DEFAULT 'SEARCH_PRICE';"); } catch {}
  }

  private seedDefaultProfiles(): void {
    const countRow = this.db.prepare("SELECT COUNT(*) as c FROM search_profiles;").get() as any;
    if (countRow && countRow.c > 0) return;

    const now = new Date().toISOString();

    // 1. Primary User Task: Moscow -> Asia Business
    this.createProfile({
      name: "Asia Business January 2027",
      origin: "MOW",
      originDisplay: "Москва",
      destination: "PEK,PKX,PVG,CAN,TFU,SZX,XIY,SYX,BKK,HKT,HAN,SGN,PQC",
      destinationDisplay: "Китай, Таиланд, Вьетнам",
      dateStart: "2027-01-12",
      dateEnd: "2027-01-18",
      tripType: "one_way",
      passengers: 2,
      cabinClass: "business",
      transfers: 0,
      baggage: "preferred",
      budget: 2000,
      currency: "USD",
      pollIntervalHours: 2,
      notificationsEnabled: true,
      isActive: true,
      createdAt: now,
      updatedAt: now
    });

    // 2. Intra-Asia Leg: China -> Thailand Eco
    this.createProfile({
      name: "Guangzhou to Bangkok Economy",
      origin: "CAN",
      originDisplay: "Гуанчжоу",
      destination: "BKK,DMK",
      destinationDisplay: "Бангкок (Таиланд)",
      dateStart: "2027-02-05",
      dateEnd: "2027-02-15",
      tripType: "one_way",
      passengers: 2,
      cabinClass: "economy",
      transfers: 0,
      baggage: "1pc_23kg",
      budget: 350,
      currency: "USD",
      pollIntervalHours: 4,
      notificationsEnabled: true,
      isActive: false, // inactive until user enables
      createdAt: now,
      updatedAt: now
    });

    // 3. Intra-Asia Leg: Thailand -> Vietnam Eco
    this.createProfile({
      name: "Bangkok to Hanoi Economy",
      origin: "BKK",
      originDisplay: "Бангкок",
      destination: "HAN,DAD,SGN",
      destinationDisplay: "Вьетнам (Ханой / Дананг)",
      dateStart: "2027-02-25",
      dateEnd: "2027-03-05",
      tripType: "one_way",
      passengers: 2,
      cabinClass: "economy",
      transfers: 0,
      baggage: "1pc_23kg",
      budget: 250,
      currency: "USD",
      pollIntervalHours: 4,
      notificationsEnabled: true,
      isActive: false,
      createdAt: now,
      updatedAt: now
    });

    console.log("[DB] Успешно созданы базовые профили (включая многосегментное путешествие по Азии).");
  }

  // ==========================================
  // SEARCH PROFILES CRUD
  // ==========================================

  public getProfiles(): SearchProfile[] {
    const rows = this.db.prepare("SELECT * FROM search_profiles ORDER BY id ASC;").all() as any[];
    return rows.map(r => this.mapProfile(r));
  }

  public getProfileById(id: number): SearchProfile | null {
    const row = this.db.prepare("SELECT * FROM search_profiles WHERE id = ?;").get(id) as any;
    return row ? this.mapProfile(row) : null;
  }

  public getActiveProfiles(): SearchProfile[] {
    const rows = this.db.prepare("SELECT * FROM search_profiles WHERE is_active = 1 ORDER BY id ASC;").all() as any[];
    return rows.map(r => this.mapProfile(r));
  }

  public createProfile(profile: Omit<SearchProfile, "id">): SearchProfile {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO search_profiles (
        name, origin, origin_display, destination, destination_display, date_start, date_end,
        trip_type, passengers, cabin_class, transfers, baggage, preferred_airlines, excluded_airlines,
        budget, currency, poll_interval_hours, notifications_enabled, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    const result = stmt.run(
      profile.name,
      profile.origin,
      profile.originDisplay || profile.origin,
      profile.destination,
      profile.destinationDisplay || profile.destination,
      profile.dateStart,
      profile.dateEnd,
      profile.tripType,
      profile.passengers,
      profile.cabinClass,
      profile.transfers,
      profile.baggage,
      profile.preferredAirlines || null,
      profile.excludedAirlines || null,
      profile.budget,
      profile.currency,
      profile.pollIntervalHours,
      profile.notificationsEnabled ? 1 : 0,
      profile.isActive ? 1 : 0,
      profile.createdAt || now,
      now
    );

    const newId = Number(result.lastInsertRowid);
    return this.getProfileById(newId)!;
  }

  public updateProfile(id: number, profile: Partial<SearchProfile>): SearchProfile | null {
    const existing = this.getProfileById(id);
    if (!existing) return null;

    const updated: SearchProfile = {
      ...existing,
      ...profile,
      updatedAt: new Date().toISOString()
    };

    const stmt = this.db.prepare(`
      UPDATE search_profiles SET
        name = ?, origin = ?, origin_display = ?, destination = ?, destination_display = ?,
        date_start = ?, date_end = ?, trip_type = ?, passengers = ?,
        cabin_class = ?, transfers = ?, baggage = ?, preferred_airlines = ?, excluded_airlines = ?,
        budget = ?, currency = ?, poll_interval_hours = ?, notifications_enabled = ?,
        is_active = ?, updated_at = ?
      WHERE id = ?;
    `);

    stmt.run(
      updated.name,
      updated.origin,
      updated.originDisplay,
      updated.destination,
      updated.destinationDisplay,
      updated.dateStart,
      updated.dateEnd,
      updated.tripType,
      updated.passengers,
      updated.cabinClass,
      updated.transfers,
      updated.baggage,
      updated.preferredAirlines || null,
      updated.excludedAirlines || null,
      updated.budget,
      updated.currency,
      updated.pollIntervalHours,
      updated.notificationsEnabled ? 1 : 0,
      updated.isActive ? 1 : 0,
      updated.updatedAt,
      id
    );

    return this.getProfileById(id);
  }

  public updateProfileLastRun(id: number, timestamp: string): void {
    this.db.prepare("UPDATE search_profiles SET last_run_at = ? WHERE id = ?;").run(timestamp, id);
  }

  public copyProfile(id: number): SearchProfile | null {
    const existing = this.getProfileById(id);
    if (!existing) return null;

    return this.createProfile({
      ...existing,
      name: `${existing.name} (Копия)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  public toggleProfile(id: number): SearchProfile | null {
    const existing = this.getProfileById(id);
    if (!existing) return null;
    return this.updateProfile(id, { isActive: !existing.isActive });
  }

  public deleteProfile(id: number): boolean {
    const stmt = this.db.prepare("DELETE FROM search_profiles WHERE id = ?;");
    const res = stmt.run(id);
    return res.changes > 0;
  }

  // ==========================================
  // FLIGHT OFFERS STORAGE & RETRIEVAL
  // ==========================================

  public saveOffer(offer: Omit<FlightOffer, "id">): void {
    const stmt = this.db.prepare(`
      INSERT INTO flight_offers (
        profile_id, offer_hash, provider, origin, origin_airport,
        destination, destination_name, country, departure_date, departure_time,
        departure_iso, return_date, airline, flight_number, gate,
        cabin_class, transfers, is_direct, passengers,
        price_per_passenger, price_total, currency,
        is_estimated, estimated_note, baggage_status, baggage_details,
        taxes_included, is_confirmed, found_at, checked_at, data_age_minutes,
        is_actual, is_target_date, is_target_budget, live_search_url, deep_link,
        plane, price_status
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(offer_hash) DO UPDATE SET
        price_per_passenger = excluded.price_per_passenger,
        price_total = excluded.price_total,
        gate = excluded.gate,
        checked_at = excluded.checked_at,
        found_at = excluded.found_at,
        data_age_minutes = excluded.data_age_minutes,
        is_actual = excluded.is_actual,
        live_search_url = excluded.live_search_url,
        is_target_budget = excluded.is_target_budget,
        plane = excluded.plane,
        price_status = excluded.price_status;
    `);

    stmt.run(
      offer.profileId,
      offer.offerHash,
      offer.provider,
      offer.origin,
      offer.originAirport || null,
      offer.destination,
      offer.destinationName,
      offer.country,
      offer.departureDate,
      offer.departureTime || null,
      offer.departureIso,
      offer.returnDate || null,
      offer.airline,
      offer.flightNumber ? String(offer.flightNumber) : null,
      offer.gate || null,
      offer.cabinClass,
      offer.transfers,
      offer.isDirect ? 1 : 0,
      offer.passengers,
      offer.pricePerPassenger,
      offer.priceTotal,
      offer.currency,
      offer.isEstimated ? 1 : 0,
      offer.estimatedNote,
      offer.baggageStatus,
      offer.baggageDetails,
      offer.taxesIncluded ? 1 : 0,
      offer.isConfirmed ? 1 : 0,
      offer.foundAt,
      offer.checkedAt,
      offer.dataAgeMinutes,
      offer.isActual ? 1 : 0,
      offer.isTargetDate ? 1 : 0,
      offer.isTargetBudget ? 1 : 0,
      offer.liveSearchUrl,
      offer.deepLink || null,
      offer.plane || null,
      offer.priceStatus || (offer.provider?.includes("Google") ? "SEARCH_PRICE" : "ESTIMATED_CACHE")
    );
  }

  public getOffers(options: {
    profileId?: number;
    provider?: string;
    targetDatesOnly?: boolean;
    targetBudgetOnly?: boolean;
    limit?: number;
  } = {}): FlightOffer[] {
    let query = "SELECT * FROM flight_offers WHERE 1=1";
    const params: any[] = [];

    if (options.profileId !== undefined) {
      query += " AND profile_id = ?";
      params.push(options.profileId);
    }
    if (options.provider) {
      query += " AND provider LIKE ?";
      params.push(`%${options.provider}%`);
    }
    if (options.targetDatesOnly) {
      query += " AND is_target_date = 1";
    }
    if (options.targetBudgetOnly) {
      query += " AND is_target_budget = 1";
    }

    query += " ORDER BY is_target_date DESC, price_total ASC";

    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(r => this.mapOffer(r));
  }

  public updateOfferStatus(id: number, updates: {
    priceStatus?: string;
    isActual?: boolean;
    deepLink?: string;
    priceTotal?: number;
    isConfirmed?: boolean;
    gate?: string;
  }): void {
    const fields: string[] = ["checked_at = ?"];
    const params: any[] = [new Date().toISOString()];

    if (updates.priceStatus !== undefined) {
      fields.push("price_status = ?");
      params.push(updates.priceStatus);
    }
    if (updates.isActual !== undefined) {
      fields.push("is_actual = ?");
      params.push(updates.isActual ? 1 : 0);
    }
    if (updates.deepLink !== undefined) {
      fields.push("deep_link = ?");
      params.push(updates.deepLink);
    }
    if (updates.priceTotal !== undefined) {
      fields.push("price_total = ?");
      params.push(updates.priceTotal);
    }
    if (updates.isConfirmed !== undefined) {
      fields.push("is_confirmed = ?");
      params.push(updates.isConfirmed ? 1 : 0);
    }
    if (updates.gate !== undefined) {
      fields.push("gate = ?");
      params.push(updates.gate);
    }

    params.push(id);
    const sql = `UPDATE flight_offers SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...params);
  }

  public clearOffersAndAlerts(): { offersCleared: number; alertsCleared: number } {
    const resOffers = this.db.prepare("DELETE FROM flight_offers;").run();
    const resAlerts = this.db.prepare("DELETE FROM notification_history;").run();
    return {
      offersCleared: resOffers.changes,
      alertsCleared: resAlerts.changes
    };
  }

  public deduplicateOffers(): number {
    const res = this.db.prepare(`
      DELETE FROM flight_offers
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM flight_offers
        GROUP BY origin, destination, departure_date, airline, COALESCE(flight_number, ''), cabin_class, transfers, provider
      );
    `).run();
    return res.changes;
  }

  public cleanupLegacyStatuses(): void {
    // 1. Deduplicate identical offers while keeping price history intact
    this.deduplicateOffers();

    // 2. Reset any false 'CONFIRMED' or 'BOOKING_VERIFIED' to 'SEARCH_PRICE' for AviaSeek
    this.db.prepare(`
      UPDATE flight_offers 
      SET price_status = 'SEARCH_PRICE', is_confirmed = 0 
      WHERE provider LIKE '%AviaSeek%'
    `).run();

    // 3. Set clear gate for AviaSeek offers
    this.db.prepare(`
      UPDATE flight_offers
      SET gate = 'Поиск AviaSeek (кэш)'
      WHERE provider LIKE '%AviaSeek%'
    `).run();
  }

  // ==========================================
  // PRICE HISTORY
  // ==========================================

  public recordPriceHistory(record: Omit<PriceHistoryRecord, "id">): void {
    const stmt = this.db.prepare(`
      INSERT INTO price_history (profile_id, route_key, departure_date, price_total, currency, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?);
    `);
    stmt.run(
      record.profileId,
      record.routeKey,
      record.departureDate,
      record.priceTotal,
      record.currency,
      record.recordedAt
    );
  }

  public getHistoricalMinimum(routeKey: string, departureDate: string): number | null {
    const stmt = this.db.prepare(`
      SELECT MIN(price_total) as min_price
      FROM price_history
      WHERE route_key = ? AND departure_date = ?;
    `);
    const row = stmt.get(routeKey, departureDate) as any;
    return row && row.min_price !== null ? row.min_price : null;
  }

  public getLastPrice(routeKey: string, departureDate: string): number | null {
    const stmt = this.db.prepare(`
      SELECT price_total
      FROM price_history
      WHERE route_key = ? AND departure_date = ?
      ORDER BY id DESC
      LIMIT 1;
    `);
    const row = stmt.get(routeKey, departureDate) as any;
    return row ? row.price_total : null;
  }

  public getPriceHistoryChartData(limit = 100): PriceHistoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM price_history
      ORDER BY recorded_at DESC
      LIMIT ?;
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map(r => ({
      id: r.id,
      profileId: r.profile_id,
      routeKey: r.route_key,
      departureDate: r.departure_date,
      priceTotal: r.price_total,
      currency: r.currency,
      recordedAt: r.recorded_at
    }));
  }

  // ==========================================
  // NOTIFICATIONS DEDUPLICATION
  // ==========================================

  public wasNotificationSent(offerHash: string): boolean {
    const stmt = this.db.prepare("SELECT id FROM notification_history WHERE offer_hash = ?;");
    const row = stmt.get(offerHash);
    return Boolean(row);
  }

  public recordNotification(record: Omit<NotificationRecord, "id">): void {
    const stmt = this.db.prepare(`
      INSERT INTO notification_history (
        profile_id, offer_hash, route_key, price_total,
        previous_min_price, savings, trigger_reason, sent_at, message_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    stmt.run(
      record.profileId,
      record.offerHash,
      record.routeKey,
      record.priceTotal,
      record.previousMinPrice || null,
      record.savings || null,
      record.triggerReason,
      record.sentAt,
      record.messageText
    );
  }

  // ==========================================
  // PROVIDER STATUS & SETTINGS
  // ==========================================

  public updateProviderStatus(status: ProviderStatus): void {
    const stmt = this.db.prepare(`
      INSERT INTO provider_status (
        provider_name, is_healthy, last_checked_at, total_requests_today,
        total_errors_today, estimated_cost_today_usd, last_error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_name) DO UPDATE SET
        is_healthy = excluded.is_healthy,
        last_checked_at = excluded.last_checked_at,
        total_requests_today = excluded.total_requests_today,
        total_errors_today = excluded.total_errors_today,
        estimated_cost_today_usd = excluded.estimated_cost_today_usd,
        last_error_message = excluded.last_error_message;
    `);
    stmt.run(
      status.providerName,
      status.isHealthy ? 1 : 0,
      status.lastCheckedAt,
      status.totalRequestsToday,
      status.totalErrorsToday,
      status.estimatedCostTodayUsd,
      status.lastErrorMessage || null
    );
  }

  public getProviderStatus(name = "Travelpayouts Data API v3"): ProviderStatus | null {
    const row = this.db.prepare("SELECT * FROM provider_status WHERE provider_name = ?;").get(name) as any;
    if (!row) return null;
    return {
      providerName: row.provider_name,
      isHealthy: row.is_healthy === 1,
      lastCheckedAt: row.last_checked_at,
      totalRequestsToday: row.total_requests_today,
      totalErrorsToday: row.total_errors_today,
      estimatedCostTodayUsd: row.estimated_cost_today_usd,
      lastErrorMessage: row.last_error_message || undefined
    };
  }

  // ==========================================
  // API CREDIT TRACKING & CONFIGURATION
  // ==========================================

  public recordCreditUsage(provider: string, creditsUsed: number, creditsRemaining?: number, operation = "search"): void {
    const stmt = this.db.prepare(`
      INSERT INTO api_credit_usage (provider, credits_used, credits_remaining, operation, created_at)
      VALUES (?, ?, ?, ?, ?);
    `);
    stmt.run(provider, creditsUsed, creditsRemaining ?? null, operation, new Date().toISOString());
  }

  public getCreditUsageSummary(provider = "flightapi"): { totalUsed: number; lastRemaining?: number; lastUsedAt?: string } {
    try {
      const totalRow = this.db.prepare(`
        SELECT SUM(credits_used) as total_used FROM api_credit_usage WHERE provider = ?;
      `).get(provider) as any;
      const lastRow = this.db.prepare(`
        SELECT credits_remaining, created_at FROM api_credit_usage WHERE provider = ? ORDER BY id DESC LIMIT 1;
      `).get(provider) as any;
      return {
        totalUsed: totalRow?.total_used || 0,
        lastRemaining: lastRow?.credits_remaining !== null ? lastRow?.credits_remaining : undefined,
        lastUsedAt: lastRow?.created_at
      };
    } catch {
      return { totalUsed: 0 };
    }
  }

  public getSetting(key: string): string | null {
    try {
      const row = this.db.prepare("SELECT value FROM application_settings WHERE key = ?;").get(key) as any;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  public setSetting(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO application_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `);
    stmt.run(key, value, new Date().toISOString());
  }

  // ==========================================
  // MAPPERS
  // ==========================================

  private mapProfile(r: any): SearchProfile {
    return {
      id: r.id,
      name: r.name,
      origin: r.origin,
      originDisplay: r.origin_display || r.origin,
      destination: r.destination,
      destinationDisplay: r.destination_display,
      dateStart: r.date_start,
      dateEnd: r.date_end,
      tripType: r.trip_type as any,
      passengers: r.passengers,
      cabinClass: r.cabin_class as any,
      transfers: r.transfers,
      baggage: r.baggage as any,
      preferredAirlines: r.preferred_airlines || undefined,
      excludedAirlines: r.excluded_airlines || undefined,
      budget: r.budget,
      currency: r.currency,
      pollIntervalHours: r.poll_interval_hours,
      notificationsEnabled: r.notifications_enabled === 1,
      isActive: r.is_active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastRunAt: r.last_run_at || undefined
    };
  }

  private mapOffer(r: any): FlightOffer {
    return {
      id: r.id,
      profileId: r.profile_id,
      offerHash: r.offer_hash,
      provider: r.provider,
      origin: r.origin,
      originAirport: r.origin_airport || undefined,
      destination: r.destination,
      destinationName: r.destination_name,
      country: r.country,
      departureDate: r.departure_date,
      departureTime: r.departure_time || undefined,
      departureIso: r.departure_iso,
      returnDate: r.return_date || undefined,
      airline: r.airline,
      flightNumber: r.flight_number || undefined,
      gate: r.gate || undefined,
      cabinClass: r.cabin_class as any,
      transfers: r.transfers,
      isDirect: r.is_direct === 1,
      passengers: r.passengers,
      pricePerPassenger: r.price_per_passenger,
      priceTotal: r.price_total,
      currency: r.currency as any,
      isEstimated: r.is_estimated === 1,
      estimatedNote: r.estimated_note,
      baggageStatus: r.baggage_status as any,
      baggageDetails: r.baggage_details,
      taxesIncluded: r.taxes_included === 1,
      isConfirmed: r.is_confirmed === 1,
      foundAt: r.found_at,
      checkedAt: r.checked_at,
      dataAgeMinutes: r.data_age_minutes,
      isActual: r.is_actual === 1,
      isTargetDate: r.is_target_date === 1,
      isTargetBudget: r.is_target_budget === 1,
      liveSearchUrl: r.live_search_url,
      deepLink: r.deep_link || undefined,
      plane: r.plane || undefined,
      priceStatus: r.price_status || (r.provider?.includes("Google") ? "SEARCH_PRICE" : "ESTIMATED_CACHE")
    };
  }
}
