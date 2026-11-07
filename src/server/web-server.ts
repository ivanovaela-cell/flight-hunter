import http from "node:http";
import { DatabaseManager } from "../db/database.ts";
import { FlightScanner } from "../scanner.ts";
import { FlightScheduler } from "../scheduler.ts";
import { TelegramBotService } from "../telegram/bot.ts";
import type { AppConfig } from "../config.ts";

export class WebServer {
  private server: http.Server;
  private port: number;
  private db: DatabaseManager;
  private scanner: FlightScanner;
  private scheduler: FlightScheduler;
  private bot: TelegramBotService;
  private config: AppConfig;

  constructor(
    port: number,
    db: DatabaseManager,
    scanner: FlightScanner,
    scheduler: FlightScheduler,
    bot: TelegramBotService,
    config: AppConfig
  ) {
    this.port = port;
    this.db = db;
    this.scanner = scanner;
    this.scheduler = scheduler;
    this.bot = bot;
    this.config = config;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[WEB UI] Локальный интерфейс Flight Hunter запущен: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        await this.handleApi(url, method, req, res);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this.renderHtml());
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
    } catch (err: any) {
      console.error("[WEB SERVER ERROR]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleApi(
    url: URL,
    method: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const json = (data: any, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };

    const parseBody = async (): Promise<any> => {
      return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (e) {
            reject(new Error("Invalid JSON body"));
          }
        });
      });
    };

    // GET /api/profiles
    if (url.pathname === "/api/profiles" && method === "GET") {
      json(this.db.getProfiles());
      return;
    }

    // POST /api/profiles
    if (url.pathname === "/api/profiles" && method === "POST") {
      const body = await parseBody();
      const created = this.db.createProfile(body);
      json(created, 201);
      return;
    }

    // PUT /api/profiles/:id
    const profileMatch = url.pathname.match(/^\/api\/profiles\/(\d+)$/);
    if (profileMatch && method === "PUT") {
      const id = parseInt(profileMatch[1], 10);
      const body = await parseBody();
      const updated = this.db.updateProfile(id, body);
      json(updated);
      return;
    }

    // DELETE /api/profiles/:id
    if (profileMatch && method === "DELETE") {
      const id = parseInt(profileMatch[1], 10);
      const success = this.db.deleteProfile(id);
      json({ success });
      return;
    }

    // POST /api/profiles/:id/copy
    const copyMatch = url.pathname.match(/^\/api\/profiles\/(\d+)\/copy$/);
    if (copyMatch && method === "POST") {
      const id = parseInt(copyMatch[1], 10);
      const copied = this.db.copyProfile(id);
      json(copied, 201);
      return;
    }

    // POST /api/profiles/:id/toggle
    const toggleMatch = url.pathname.match(/^\/api\/profiles\/(\d+)\/toggle$/);
    if (toggleMatch && method === "POST") {
      const id = parseInt(toggleMatch[1], 10);
      const updated = this.db.toggleProfile(id);
      json(updated);
      return;
    }

    // POST /api/profiles/:id/run
    const runMatch = url.pathname.match(/^\/api\/profiles\/(\d+)\/run$/);
    if (runMatch && method === "POST") {
      const id = parseInt(runMatch[1], 10);
      if (this.scanner.isBusy()) {
        json({ error: "Сканирование уже выполняется" }, 409);
        return;
      }
      const summary = await this.scanner.scanProfileById(id);
      json(summary);
      return;
    }

    // POST /api/scan-all
    if (url.pathname === "/api/scan-all" && method === "POST") {
      if (this.scanner.isBusy()) {
        json({ error: "Сканирование уже выполняется" }, 409);
        return;
      }
      const providerParam = url.searchParams.get("provider");
      const includeAviaSeek = url.searchParams.get("aviaseek") === "true";

      let options: ScanExecutionOptions = {};
      if (providerParam === "flightapi") {
        options = { provider: "flightapi", forceFlightApi: true };
      } else if (providerParam === "aviaseek" || includeAviaSeek) {
        options = { provider: "aviaseek", includeAviaSeek: true };
      } else if (providerParam === "travelpayouts") {
        options = { provider: "travelpayouts" };
      } else {
        options = { includeAviaSeek };
      }

      const summaries = await this.scanner.scanAllActiveProfiles(options);
      
      let totalFound = 0;
      let totalRequests = 0;
      const allErrors: string[] = [];
      for (const s of summaries) {
        totalFound += s.offersFound;
        totalRequests += s.requestsMade;
        if (s.errors && s.errors.length > 0) {
          allErrors.push(...s.errors);
        }
      }

      json({
        success: allErrors.length === 0 || totalFound > 0,
        provider: providerParam || (includeAviaSeek ? "aviaseek" : "all"),
        offersFound: totalFound,
        requestsMade: totalRequests,
        errors: allErrors,
        summaries
      });
      return;
    }

    // GET /api/aviaseek/status
    if (url.pathname === "/api/aviaseek/status" && method === "GET") {
      const provider = this.scanner.getAviaSeekProvider();
      json({
        name: provider.name,
        enabled: provider.getIsEnabled(),
        stats: provider.getStats()
      });
      return;
    }

    // POST /api/aviaseek/toggle
    if (url.pathname === "/api/aviaseek/toggle" && method === "POST") {
      const provider = this.scanner.getAviaSeekProvider();
      const current = provider.getIsEnabled();
      provider.setEnabled(!current);
      json({
        success: true,
        enabled: provider.getIsEnabled()
      });
      return;
    }

    // POST /api/aviaseek/search
    if (url.pathname === "/api/aviaseek/search" && method === "POST") {
      const body = await parseBody();
      const from = (body.from || "SVO").trim().toUpperCase();
      const to = (body.to || "PEK").trim().toUpperCase();
      const date = body.date || "2027-01-13";
      const adults = parseInt(body.adults || "2", 10);
      const cabin = body.cabin || "business";
      const direct = body.direct !== false;

      const provider = this.scanner.getAviaSeekProvider();
      try {
        const res = await provider.searchFlights({
          origin: from,
          destination: to,
          departureDate: date,
          passengers: adults,
          cabinClass: cabin,
          directOnly: direct,
          currency: "USD"
        });
        json({ success: true, count: res.results.length, results: res.results });
      } catch (err: any) {
        json({ error: err.message }, 500);
      }
      return;
    }

    // GET /api/flightapi/status
    if (url.pathname === "/api/flightapi/status" && method === "GET") {
      const provider = this.scanner.getFlightApiProvider();
      const stats = provider.getStats();
      json({
        configured: provider.hasCredentials(),
        stats
      });
      return;
    }

    // POST /api/flightapi/set-key
    if (url.pathname === "/api/flightapi/set-key" && method === "POST") {
      const body = await parseBody();
      if (!body.apiKey) {
        json({ error: "API-ключ не указан" }, 400);
        return;
      }
      process.env.FLIGHTAPI_KEY = body.apiKey.trim();
      this.scanner.getFlightApiProvider().setApiKey(body.apiKey.trim());
      const stats = this.scanner.getFlightApiProvider().getStats();
      json({
        success: true,
        stats
      });
      return;
    }

    // POST /api/flightapi/set-plan
    if (url.pathname === "/api/flightapi/set-plan" && method === "POST") {
      const body = await parseBody();
      const plan = body.plan || "free_trial";
      const maxCredits = parseInt(body.maxCredits || "50", 10);
      this.scanner.getFlightApiProvider().setPlan(plan, maxCredits);
      json({
        success: true,
        stats: this.scanner.getFlightApiProvider().getStats()
      });
      return;
    }

    // GET /api/offers
    if (url.pathname === "/api/offers" && method === "GET") {
      const profileIdStr = url.searchParams.get("profileId");
      const provider = url.searchParams.get("provider") || undefined;
      const targetDatesOnly = url.searchParams.get("targetDates") === "true";
      const targetBudgetOnly = url.searchParams.get("targetBudget") === "true";
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);

      const offers = this.db.getOffers({
        profileId: profileIdStr ? parseInt(profileIdStr, 10) : undefined,
        provider,
        targetDatesOnly,
        targetBudgetOnly,
        limit
      });
      json(offers);
      return;
    }

    // GET /api/offers/:id/checkout
    const checkoutMatch = url.pathname.match(/^\/api\/offers\/(\d+)\/checkout$/);
    if (checkoutMatch && method === "GET") {
      const id = parseInt(checkoutMatch[1], 10);
      const allOffers = this.db.getOffers({ limit: 1000 });
      const offer = allOffers.find(o => o.id === id);

      if (!offer) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>Предложение не найдено</h3>");
        return;
      }

      if (offer.provider.includes("AviaSeek")) {
        // AviaSeek is an informative aggregator / cache engine, NOT a direct booking engine.
        // It does not support guaranteed persistent booking links or ticket reservation.
        // Directly open the search results page on AviaSeek so the user sees live available fares.
        const searchUrl = offer.liveSearchUrl || `https://aviaseek.com/search?from=${offer.origin}&to=${offer.destination}&date=${offer.departureDate}&adults=${offer.passengers}&cabin=${offer.cabinClass}`;
        res.writeHead(302, { Location: searchUrl });
        res.end();
        return;
      }

      // Default redirect for other providers
      res.writeHead(302, { Location: offer.liveSearchUrl });
      res.end();
      return;
    }

    // POST /api/offers/:id/verify
    const verifyMatch = url.pathname.match(/^\/api\/offers\/(\d+)\/verify$/);
    if (verifyMatch && method === "POST") {
      const id = parseInt(verifyMatch[1], 10);
      const allOffers = this.db.getOffers({ limit: 1000 });
      const offer = allOffers.find(o => o.id === id);

      if (!offer) {
        json({ error: "Offer not found" }, 404);
        return;
      }

      if (offer.provider.includes("AviaSeek")) {
        json({
          status: "SEARCH_PRICE",
          isVerifiedSeller: false,
          isGeneralSearch: true,
          bookingUrl: offer.liveSearchUrl,
          message: "AviaSeek является метапоисковым агрегатором и не поддерживает гарантированное бронирование конкретного тарифа."
        });
        return;
      }

      json({ status: "CONFIRMED", message: "Резервный провайдер" });
      return;
    }

    // POST /api/scheduler/toggle
    if (url.pathname === "/api/scheduler/toggle" && method === "POST") {
      const current = this.scheduler.getStatus();
      if (current.isRunning) {
        this.scheduler.stop();
      } else {
        this.scheduler.start();
      }
      json({ success: true, scheduler: this.scheduler.getStatus() });
      return;
    }

    // POST /api/clear
    if (url.pathname === "/api/clear" && method === "POST") {
      const result = this.db.clearOffersAndAlerts();
      json({ success: true, ...result });
      return;
    }

    // GET /api/history
    if (url.pathname === "/api/history" && method === "GET") {
      json(this.db.getPriceHistoryChartData(100));
      return;
    }

    // GET /api/status
    if (url.pathname === "/api/status" && method === "GET") {
      const sched = this.scheduler.getStatus();
      const prov = this.db.getProviderStatus();
      const offersCount = this.db.getOffers().length;
      json({
        scheduler: sched,
        provider: prov,
        totalOffersTracked: offersCount,
        telegramConfigured: this.bot.isConfigured(),
        isScanningNow: this.scanner.isBusy()
      });
      return;
    }

    json({ error: "API route not found" }, 404);
  }

  private renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flight Hunter v1.0 — Мониторинг и покупка авиабилетов</title>
  <style>
    :root {
      --bg: #0b1120;
      --card-bg: #1e293b;
      --card-border: #334155;
      --primary: #0284c7;
      --primary-light: #38bdf8;
      --accent: #0ea5e9;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding-bottom: 60px; line-height: 1.5; }
    header { background: #070d19; border-bottom: 1px solid var(--card-border); padding: 16px 28px; position: sticky; top: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 1.3rem; font-weight: 800; color: var(--primary-light); }
    .nav-tabs { display: flex; gap: 6px; }
    .tab-btn { background: transparent; border: 1px solid transparent; color: var(--text-muted); padding: 9px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s; font-size: 0.95rem; }
    .tab-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }
    .tab-btn.active { color: #fff; background: var(--primary); }
    .header-actions { display: flex; gap: 10px; align-items: center; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px; border-radius: 8px; font-weight: 700; font-size: 0.9rem; cursor: pointer; border: none; transition: all 0.2s; text-decoration: none; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: #0369a1; }
    .btn-success { background: var(--success); color: #fff; }
    .btn-success:hover { background: #059669; }
    .btn-outline { background: transparent; border: 1px solid var(--card-border); color: var(--text); }
    .btn-outline:hover { background: rgba(255,255,255,0.06); border-color: var(--text-muted); }
    .btn-sm { padding: 5px 10px; font-size: 0.8rem; border-radius: 6px; }
    .container { max-width: 1440px; margin: 24px auto; padding: 0 20px; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 22px; margin-bottom: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
    .card-title { font-size: 1.2rem; font-weight: 700; margin-bottom: 18px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; cursor: pointer; transition: transform 0.1s; }
    .badge:hover { transform: scale(1.05); filter: brightness(1.15); }
    .pill-btn { background: #0f172a; border: 1px solid var(--card-border); color: var(--text-muted); padding: 7px 14px; border-radius: 20px; font-size: 0.83rem; font-weight: 700; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; }
    .pill-btn:hover { background: rgba(255,255,255,0.08); color: var(--text); border-color: var(--primary-light); }
    .pill-btn.active { background: var(--primary); color: #fff; border-color: var(--primary-light); box-shadow: 0 0 10px rgba(2,132,199,0.4); }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .badge-primary { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--card-border); color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 14px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .price-tag { font-size: 1.25rem; font-weight: 800; color: #38bdf8; }
    .price-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
    .live-buy-btn { background: #0284c7; color: #fff; padding: 9px 14px; border-radius: 8px; font-size: 0.88rem; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
    .live-buy-btn:hover { background: #0369a1; transform: translateY(-1px); }
    .grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 16px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    label { font-size: 0.85rem; font-weight: 700; color: var(--text-muted); }
    input, select, textarea { background: #0f172a; border: 1px solid var(--card-border); border-radius: 8px; padding: 10px 14px; color: var(--text); font-size: 0.92rem; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary-light); }
    .presets-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .preset-pill { background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); color: var(--primary-light); padding: 4px 10px; border-radius: 16px; font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .preset-pill:hover { background: var(--primary); color: #fff; }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: none; align-items: center; justify-content: center; z-index: 200; padding: 16px; }
    .modal { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; max-width: 760px; width: 100%; max-height: 92vh; overflow-y: auto; padding: 26px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .modal-close { background: transparent; border: none; color: var(--text-muted); font-size: 1.6rem; cursor: pointer; }
    .stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-item { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; }
    .stat-val { font-size: 1.6rem; font-weight: 800; color: var(--text); margin-top: 4px; }
    .stat-lbl { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }
  </style>
</head>
<body>

<header>
  <div class="brand">
    <span style="font-size: 1.5rem;">✈️</span> Flight Hunter <span class="badge badge-primary">v1.0</span>
  </div>
  <div class="nav-tabs">
    <button class="tab-btn active" data-tab="offers" onclick="switchTab('offers', event)">🎟️ Найденные билеты</button>
    <button class="tab-btn" data-tab="profiles" onclick="switchTab('profiles', event)">📋 Поисковые задания</button>
    <button class="tab-btn" data-tab="history" onclick="switchTab('history', event)">📈 История цен</button>
    <button class="tab-btn" data-tab="settings" onclick="switchTab('settings', event)">⚙️ Настройки и статус</button>
  </div>
  <div class="header-actions">
    <button class="btn btn-outline" id="btnScanAviaSeek" onclick="triggerScanAviaSeek()" title="Запуск живого поиска через AviaSeek (Aviasales Live)" style="border-color:#fbbf24; color:#fbbf24;">🟡 Поиск AviaSeek (Live)</button>
    <button class="btn btn-outline" id="btnScanFlightApi" onclick="triggerScanFlightApi()" title="Запуск живого поиска через FlightAPI.io">✈️ Поиск FlightAPI (Live)</button>
    <button class="btn btn-success" id="btnScanAll" onclick="triggerScanAll()">🔄 Проверить все</button>
    <button class="btn btn-outline" id="btnClearDb" onclick="triggerClearSystem()" title="Очистить кэш тарифов и историю алертов" style="border-color:#f87171; color:#f87171;">🧹 Очистить базу</button>
    <button class="btn btn-primary" onclick="openProfileModal()">➕ Создать поиск</button>
  </div>
</header>

<div class="container">

  <!-- STATS BAR -->
  <div class="stats-bar">
    <div class="stat-item">
      <div class="stat-lbl">Всего билетов в базе</div>
      <div class="stat-val" id="statOffersCount">-</div>
    </div>
    <div class="stat-item" style="cursor:pointer;" onclick="toggleScheduler()" title="Нажмите для включения/выключения почасового поиска">
      <div class="stat-lbl">Почасовой поиск (Telegram)</div>
      <div class="stat-val" id="statScheduler" style="font-size:1.15rem;">Отключен ⏸️</div>
    </div>
    <div class="stat-item">
      <div class="stat-lbl">Основной провайдер</div>
      <div class="stat-val" style="font-size: 1.15rem; color: #34d399;" id="statProvider">FlightAPI.io</div>
    </div>
    <div class="stat-item">
      <div class="stat-lbl">Telegram-уведомления</div>
      <div class="stat-val" id="statTelegram">-</div>
    </div>
    <div class="stat-item">
      <div class="stat-lbl">Кредиты FlightAPI</div>
      <div class="stat-val" style="font-size: 1.15rem; color: #38bdf8;" id="statFlightApi">-</div>
    </div>
    <div class="stat-item">
      <div class="stat-lbl">AviaSeek Live (Aviasales)</div>
      <div class="stat-val" style="font-size: 1.15rem; color: #fbbf24;" id="statAviaSeek">-</div>
    </div>
  </div>

  <!-- TAB 1: OFFERS -->
  <div id="tab-offers" class="tab-content">
    <div class="card">
      <div class="card-title">
        <span>🎟️ Актуальные найденные тарифы</span>
        <div style="display:flex; gap:10px; font-weight: normal; font-size: 0.9rem; align-items:center; flex-wrap:wrap;">
          <select id="filterProvider" onchange="loadOffers()" style="padding:6px 12px; background:#0f172a; color:#fff; border:1px solid var(--card-border); border-radius:6px; font-weight:700;">
            <option value="">🌐 Все источники</option>
            <option value="FlightAPI">✈️ FlightAPI.io (Живые)</option>
            <option value="AviaSeek">🟡 AviaSeek (Метапоиск)</option>
            <option value="Travelpayouts">🎟️ Travelpayouts (Кэш)</option>
          </select>
          <select id="filterProfile" onchange="loadOffers()" style="padding:6px 12px;">
            <option value="">Все задания</option>
          </select>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="filterTargetDates" onchange="loadOffers()" checked> Только целевые даты
          </label>
        </div>
      </div>

      <!-- INTERACTIVE FILTER PILLS (ПЛАШКИ) -->
      <div class="filter-pills-container" style="background: rgba(15,23,42,0.6); padding: 14px 16px; border-radius: 10px; border: 1px solid var(--card-border); margin-bottom: 16px; display: flex; flex-direction: column; gap: 10px;">
        <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
          <span style="font-size:0.8rem; color:var(--text-muted); font-weight:700; text-transform:uppercase; min-width:85px;">Источник:</span>
          <button class="pill-btn active" data-pill-type="provider" data-pill-val="" onclick="setPillFilter('provider', '')">🌐 Все источники</button>
          <button class="pill-btn" data-pill-type="provider" data-pill-val="AviaSeek" onclick="setPillFilter('provider', 'AviaSeek')">🟡 AviaSeek (Живой)</button>
          <button class="pill-btn" data-pill-type="provider" data-pill-val="Travelpayouts" onclick="setPillFilter('provider', 'Travelpayouts')">🎟️ Travelpayouts (Кэш)</button>
          <button class="pill-btn" data-pill-type="provider" data-pill-val="FlightAPI" onclick="setPillFilter('provider', 'FlightAPI')">✈️ FlightAPI.io (Live)</button>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
          <span style="font-size:0.8rem; color:var(--text-muted); font-weight:700; text-transform:uppercase; min-width:85px;">Направление:</span>
          <button class="pill-btn active" data-pill-type="region" data-pill-val="" onclick="setPillFilter('region', '')">🌏 Все города</button>
          <button class="pill-btn" data-pill-type="region" data-pill-val="china" onclick="setPillFilter('region', 'china')">🇨🇳 Китай (Пекин, Чэнду, Шанхай, Гуанчжоу, Санья)</button>
          <button class="pill-btn" data-pill-type="region" data-pill-val="vietnam" onclick="setPillFilter('region', 'vietnam')">🇻🇳 Вьетнам (Ханой, Хошимин)</button>
          <button class="pill-btn" data-pill-type="region" data-pill-val="thailand" onclick="setPillFilter('region', 'thailand')">🇹🇭 Таиланд (Бангкок, Пхукет)</button>
          <button class="pill-btn active" id="pillOnlyDirect" onclick="togglePillDirect()">🟢 Только прямые (0 пересадок)</button>
        </div>
      </div>
      <div id="searchStatusBanner" style="display:none; margin: 0 0 16px 0; padding: 12px 18px; border-radius: 8px; font-size: 0.92rem; font-weight: 600;"></div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Дата и время</th>
              <th>Маршрут</th>
              <th>Перевозчик / Продавец</th>
              <th>Класс</th>
              <th>Пересадки</th>
              <th>Цена за всех (USD)</th>
              <th>Багаж</th>
              <th>Свежесть</th>
              <th>Действие / Покупка</th>
            </tr>
          </thead>
          <tbody id="offersTableBody">
            <tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">Загрузка предложений...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 2: PROFILES -->
  <div id="tab-profiles" class="tab-content" style="display:none;">
    <div class="card">
      <div class="card-title">
        <span>📋 Поисковые задания (Маршруты для автоматического мониторинга)</span>
        <button class="btn btn-primary" onclick="openProfileModal()">➕ Новое задание</button>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Название задания</th>
              <th>Маршрут</th>
              <th>Период вылета</th>
              <th>Класс</th>
              <th>Пассажиры</th>
              <th>Багаж</th>
              <th>Бюджет</th>
              <th>Мониторинг</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody id="profilesTableBody">
            <tr><td colspan="10" style="text-align:center; padding:30px; color:var(--text-muted);">Загрузка заданий...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 3: HISTORY -->
  <div id="tab-history" class="tab-content" style="display:none;">
    <div class="card">
      <div class="card-title">📈 История изменения стоимости по направлениям</div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Направление</th>
              <th>Дата вылета</th>
              <th>Зафиксированная цена за всех</th>
              <th>Время фиксации</th>
            </tr>
          </thead>
          <tbody id="historyTableBody">
            <tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">Загрузка истории...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB 4: SETTINGS -->
  <div id="tab-settings" class="tab-content" style="display:none;">
    <div class="card">
      <div class="card-title">⚙️ Настройки и статус системы</div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px;">
        <div>
          <h4 style="margin-bottom:12px; color:var(--primary-light);">Конфигурация окружения</h4>
          <p style="color:var(--text-muted); font-size:0.92rem; line-height:1.6;">
            Конфигурация хранится в локальном файле <code>.env</code> в каталоге проекта.<br>
            Токены авторизации защищены и никогда не передаются в открытом виде.
          </p>
          <ul style="margin: 14px 0 0 20px; font-size:0.92rem; color:var(--text-muted); line-height:1.8;">
            <li>FlightAPI.io Live Engine: <span id="settingsFlightApiStatus">Загрузка...</span></li>
            <li>AviaSeek Live Provider: <span id="settingsAviaSeekStatus">Загрузка...</span></li>
            <li>Travelpayouts Cache API: <span class="badge badge-success">Резерв</span></li>
            <li>Хранилище: SQLite WAL (<code>data/flights.db</code>)</li>
            <li>Telegram-бот: <span id="settingsTelegramStatus">Загрузка...</span></li>
          </ul>
        </div>
        <div>
          <h4 style="margin-bottom:12px; color:var(--primary-light);">Принцип работы Flight Hunter</h4>
          <p style="color:var(--text-muted); font-size:0.92rem; line-height:1.6;">
            <b>1. Живой поиск (FlightAPI.io):</b> сервис регулярно опрашивает актуальные цены сотен авиакомпаний и агентств со всего мира.<br><br>
            <b>2. Уведомления и покупка:</b> при снижении цены или появлении билета в пределах бюджета бот отправляет оповещение с прямой ссылкой на сайт продавца или авиакомпании.
          </p>
        </div>
      </div>
    </div>

    <!-- FLIGHTAPI KEY & PLAN MANAGEMENT CARD -->
    <div class="card">
      <div class="card-title">🔑 FlightAPI.io B2B (Живые тарифы от авиакомпаний и агентств)</div>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:14px; line-height:1.5;">
        Основной коммерческий API актуальных цен. Каждый поисковый запрос расходует 2 кредита. Ключ хранится в <code>.env</code>.
      </p>
      <div id="flightApiSettingsInfo" style="margin-bottom:15px; font-size:0.95rem; background:rgba(255,255,255,0.03); padding:14px; border-radius:8px; border:1px solid var(--card-border);">
        Загрузка статуса FlightAPI...
      </div>
      <div style="display:flex; gap:10px; max-width:650px; flex-wrap:wrap; margin-bottom:12px;">
        <input type="password" id="flightApiKeyInput" placeholder="Введите API-ключ FlightAPI.io" style="flex:1; min-width:260px; padding:9px 12px; border-radius:8px; border:1px solid var(--card-border); background:#070d19; color:#fff;">
        <button class="btn btn-primary" onclick="saveFlightApiKey()">💾 Сохранить ключ</button>
      </div>
      <div style="display:flex; gap:10px; max-width:650px; align-items:center; flex-wrap:wrap;">
        <label style="font-size:0.88rem; color:var(--text-muted);">Тарифный план:</label>
        <select id="flightApiPlanSelect" style="padding:7px 10px; border-radius:8px; border:1px solid var(--card-border); background:#070d19; color:#fff;">
          <option value="free_trial">Free Trial (лимит: 50 кредитов)</option>
          <option value="lite">Lite ($49/мес, 30 000 кредитов)</option>
          <option value="standard">Standard ($99/мес, 100 000 кредитов)</option>
          <option value="plus">Plus ($199/мес, 500 000 кредитов)</option>
        </select>
        <button class="btn btn-outline btn-sm" onclick="saveFlightApiPlan()">Обновить тариф</button>
      </div>
    </div>

    <!-- AVIASEEK MANAGEMENT CARD -->
    <div class="card">
      <div class="card-title">🟡 AviaSeek Meta Search (Live-агрегатор Aviasales)</div>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:14px; line-height:1.5;">
        Дополнительный провайдер живого поиска авиабилетов без расхода платных API-кредитов. Обращается к движку Aviasales в реальном времени. Ссылки на покупку генерируются динамически.
      </p>
      <div id="aviaSeekSettingsInfo" style="margin-bottom:15px; font-size:0.95rem; background:rgba(255,255,255,0.03); padding:14px; border-radius:8px; border:1px solid var(--card-border);">
        Загрузка статуса AviaSeek...
      </div>
      <div style="display:flex; gap:10px; max-width:650px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-outline" id="btnToggleAviaSeek" onclick="toggleAviaSeek()">Переключить активность AviaSeek</button>
        <span style="font-size:0.88rem; color:var(--text-muted);">По умолчанию фоновый автомониторинг отключен (только ручной поиск по требованию).</span>
      </div>
    </div>
  </div>

</div>

<!-- CREATE/EDIT PROFILE MODAL -->
<div class="modal-overlay" id="profileModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">Создать поисковое задание</h3>
      <button class="modal-close" onclick="closeProfileModal()">&times;</button>
    </div>
    <form id="profileForm" onsubmit="saveProfile(event)">
      <input type="hidden" id="formProfileId">
      
      <div class="form-group" style="margin-bottom:16px;">
        <label>Название задания</label>
        <input type="text" id="formName" required placeholder="Например: Asia Business January 2027">
      </div>

      <!-- ORIGIN WITH DROPDOWN/PRESETS -->
      <div class="grid-form">
        <div class="form-group">
          <label>Город отправления (выберите или введите)</label>
          <input list="originsList" id="formOriginDisplay" required placeholder="Например: Москва" onchange="autoFillOriginCode()">
          <datalist id="originsList">
            <option value="Москва (все аэропорты)">MOW</option>
            <option value="Москва (Шереметьево)">SVO</option>
            <option value="Москва (Домодедово)">DME</option>
            <option value="Москва (Внуково)">VKO</option>
            <option value="Санкт-Петербург">LED</option>
            <option value="Гуанчжоу">CAN</option>
            <option value="Пекин">BJS</option>
            <option value="Бангкок">BKK</option>
            <option value="Ханой">HAN</option>
            <option value="Дубай">DXB</option>
            <option value="Стамбул">IST</option>
          </datalist>
          <input type="hidden" id="formOrigin" value="MOW">
        </div>

        <div class="form-group">
          <label>Куда летим (выберите город или готовый регион)</label>
          <input list="destinationsList" id="formDestinationDisplay" required placeholder="Например: Китай, Таиланд, Вьетнам" onchange="autoFillDestCode()">
          <datalist id="destinationsList">
            <option value="Китай, Таиланд, Вьетнам (все направления)">PEK,PKX,PVG,CAN,TFU,SZX,XIY,SYX,BKK,HKT,HAN,SGN,PQC</option>
            <option value="Только Китай (Пекин, Шанхай, Гуанчжоу, Чэнду)">PEK,PKX,PVG,CAN,TFU,SZX</option>
            <option value="Только Таиланд (Бангкок, Пхукет)">BKK,HKT,DMK,CNX,USM</option>
            <option value="Только Вьетнам (Ханой, Хошимин, Фукуок)">HAN,SGN,PQC,DAD</option>
            <option value="Пекин (все аэропорты)">BJS</option>
            <option value="Шанхай">PVG</option>
            <option value="Гуанчжоу">CAN</option>
            <option value="Чэнду">TFU</option>
            <option value="Бангкок">BKK</option>
            <option value="Пхукет">HKT</option>
            <option value="Ханой (рейс VN62)">HAN</option>
            <option value="Хошимин">SGN</option>
            <option value="Бали (Денпасар)">DPS</option>
            <option value="Дубай">DXB</option>
            <option value="Токио">TYO</option>
          </datalist>
          <input type="hidden" id="formDestination" value="PEK,PKX,PVG,CAN,TFU,SZX,XIY,SYX,BKK,HKT,HAN,SGN,PQC">

          <!-- QUICK REGION PRESETS -->
          <div class="presets-row">
            <span class="preset-pill" onclick="applyDestPreset('Китай, Таиланд, Вьетнам (все направления)', 'PEK,PKX,PVG,CAN,TFU,SZX,XIY,SYX,BKK,HKT,HAN,SGN,PQC')">🌏 Вся Азия</span>
            <span class="preset-pill" onclick="applyDestPreset('Только Китай', 'PEK,PKX,PVG,CAN,TFU,SZX')">🇨🇳 Китай</span>
            <span class="preset-pill" onclick="applyDestPreset('Только Таиланд', 'BKK,HKT')">🇹🇭 Таиланд</span>
            <span class="preset-pill" onclick="applyDestPreset('Только Вьетнам', 'HAN,SGN,PQC')">🇻🇳 Вьетнам</span>
          </div>
        </div>
      </div>

      <!-- DATES -->
      <div class="grid-form">
        <div class="form-group">
          <label>Дата вылета С (календарь)</label>
          <input type="date" id="formDateStart" required>
        </div>
        <div class="form-group">
          <label>Дата вылета ПО (календарь)</label>
          <input type="date" id="formDateEnd" required>
        </div>
      </div>

      <!-- CABIN CLASS, PASSENGERS, TRANSFERS -->
      <div class="grid-form">
        <div class="form-group">
          <label>Класс обслуживания</label>
          <select id="formCabinClass">
            <option value="business">✈️ Бизнес-класс</option>
            <option value="economy">💺 Эконом-класс</option>
            <option value="premium_economy">⭐ Премиум-эконом</option>
            <option value="first">👑 Первый класс</option>
            <option value="any">🔄 Любой класс</option>
          </select>
        </div>
        <div class="form-group">
          <label>Пассажиры (взрослые)</label>
          <input type="number" id="formPassengers" min="1" max="9" value="2" required>
        </div>
        <div class="form-group">
          <label>Пересадки</label>
          <select id="formTransfers">
            <option value="0">🟢 Только прямые (0 пересадок)</option>
            <option value="1">🟡 Не более 1 пересадки</option>
            <option value="-1">⚪ Любое количество</option>
          </select>
        </div>
      </div>

      <!-- BAGGAGE, BUDGET, CURRENCY -->
      <div class="grid-form">
        <div class="form-group">
          <label>Требования к багажу</label>
          <select id="formBaggage">
            <option value="preferred">🧳 Желательно с включенным багажом</option>
            <option value="1pc_23kg">🧳 1 место багажа (до 23 кг)</option>
            <option value="2pc_32kg">🧳🧳 2 места багажа (до 32 кг)</option>
            <option value="none">🎒 Только ручная кладь</option>
            <option value="any">🤷 Любой тариф (неважно)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Бюджет (максимально за всех)</label>
          <input type="number" id="formBudget" value="2000" required>
        </div>
        <div class="form-group">
          <label>Валюта</label>
          <select id="formCurrency">
            <option value="USD">USD ($)</option>
            <option value="RUB">RUB (₽)</option>
            <option value="EUR">EUR (€)</option>
          </select>
        </div>
      </div>

      <!-- AIRLINES FILTERS -->
      <div class="grid-form">
        <div class="form-group">
          <label>Предпочитаемые авиакомпании (необязательно)</label>
          <input type="text" id="formPreferredAirlines" placeholder="Например: SU, CA, CZ, VN">
        </div>
        <div class="form-group">
          <label>Исключить авиакомпании (необязательно)</label>
          <input type="text" id="formExcludedAirlines" placeholder="Например: WZ">
        </div>
      </div>

      <!-- INTERVAL & NOTIFICATIONS -->
      <div class="grid-form" style="align-items:center;">
        <div class="form-group">
          <label>Частота автоматической проверки</label>
          <select id="formPollInterval">
            <option value="1">Каждый 1 час</option>
            <option value="2" selected>Каждые 2 часа (рекомендуется)</option>
            <option value="4">Каждые 4 часа</option>
            <option value="6">Каждые 6 часов</option>
            <option value="12">Каждые 12 часов</option>
            <option value="24">Раз в сутки</option>
          </select>
        </div>
        <div class="form-group" style="margin-top: 18px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" id="formNotifications" checked>
            🔔 Присылать уведомления в Telegram
          </label>
        </div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:22px;">
        <button type="button" class="btn btn-outline" onclick="closeProfileModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить задание</button>
      </div>
    </form>
  </div>
</div>

<script>
  let profiles = [];
  let offers = [];

  const KNOWN_CODES = {
    'москва': 'MOW',
    'москва (все аэропорты)': 'MOW',
    'шереметьево': 'SVO',
    'домодедово': 'DME',
    'внуково': 'VKO',
    'пекин': 'BJS',
    'шанхай': 'PVG',
    'гуанчжоу': 'CAN',
    'чэнду': 'TFU',
    'бангкок': 'BKK',
    'пхукет': 'HKT',
    'ханой': 'HAN',
    'хошимин': 'SGN',
    'фукуок': 'PQC',
    'бали': 'DPS',
    'денпасар': 'DPS',
    'дубай': 'DXB',
    'стамбул': 'IST',
    'санкт-петербург': 'LED'
  };

  function autoFillOriginCode() {
    const val = document.getElementById('formOriginDisplay').value.toLowerCase().trim();
    for (const [key, code] of Object.entries(KNOWN_CODES)) {
      if (val.includes(key)) {
        document.getElementById('formOrigin').value = code;
        return;
      }
    }
    // If entered directly 3 letters IATA
    if (val.length === 3) {
      document.getElementById('formOrigin').value = val.toUpperCase();
    }
  }

  function autoFillDestCode() {
    const val = document.getElementById('formDestinationDisplay').value.toLowerCase().trim();
    if (val.includes('все направления') || val.includes('вся азия')) {
      document.getElementById('formDestination').value = 'PEK,PKX,PVG,CAN,TFU,SZX,XIY,SYX,BKK,HKT,HAN,SGN,PQC';
      return;
    }
    if (val.includes('только китай')) {
      document.getElementById('formDestination').value = 'PEK,PKX,PVG,CAN,TFU,SZX';
      return;
    }
    if (val.includes('только таиланд')) {
      document.getElementById('formDestination').value = 'BKK,HKT,DMK,CNX,USM';
      return;
    }
    if (val.includes('только вьетнам')) {
      document.getElementById('formDestination').value = 'HAN,SGN,PQC,DAD';
      return;
    }
    for (const [key, code] of Object.entries(KNOWN_CODES)) {
      if (val.includes(key)) {
        document.getElementById('formDestination').value = code;
        return;
      }
    }
    if (val.length === 3) {
      document.getElementById('formDestination').value = val.toUpperCase();
    }
  }

  function applyDestPreset(displayName, code) {
    document.getElementById('formDestinationDisplay').value = displayName;
    document.getElementById('formDestination').value = code;
  }

  async function init() {
    await loadStatus();
    await loadProfiles();
    await loadOffers();
    await loadHistory();
  }

  function switchTab(tabId, ev) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
    
    const targetBtn = (ev && ev.target) || (typeof event !== 'undefined' && event && event.target) || document.querySelector('button[data-tab="' + tabId + '"]');
    if (targetBtn && targetBtn.classList) {
      targetBtn.classList.add('active');
    }
    const tabElem = document.getElementById('tab-' + tabId);
    if (tabElem) tabElem.style.display = 'block';

    if (tabId === 'history') loadHistory();
    if (tabId === 'offers') loadOffers();
    if (tabId === 'profiles') loadProfiles();
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('statOffersCount').textContent = data.totalOffersTracked;
      document.getElementById('statScheduler').innerHTML = data.scheduler.isRunning
        ? '<span style="color:#34d399">Активен (' + data.scheduler.intervalHours + 'ч)</span>'
        : '<span style="color:#f87171">Остановлен</span>';
      document.getElementById('statProvider').textContent = data.provider?.providerName || 'Travelpayouts v3';
      document.getElementById('statTelegram').innerHTML = data.telegramConfigured
        ? '<span style="color:#34d399">Подключен ✅</span>'
        : '<span style="color:#94a3b8">Не настроен</span>';
      document.getElementById('settingsTelegramStatus').textContent = data.telegramConfigured ? 'Активен (уведомления включены)' : 'Отключен (добавьте токен в .env)';
      await loadFlightApiStatus();
      await loadAviaSeekStatus();
    } catch (e) {
      console.error(e);
    }
  }

  async function loadFlightApiStatus() {
    try {
      const res = await fetch('/api/flightapi/status');
      const data = await res.json();
      const stats = data.stats;
      const statElem = document.getElementById('statFlightApi');
      const settingsElem = document.getElementById('flightApiSettingsInfo');
      const settingsStatusBadge = document.getElementById('settingsFlightApiStatus');

      if (!data.configured) {
        if (statElem) statElem.innerHTML = '<span style="color:#94a3b8; font-size:0.9rem;">Ключ не задан</span>';
        if (settingsStatusBadge) settingsStatusBadge.innerHTML = '<span class="badge badge-warning">Не настроен</span>';
        if (settingsElem) {
          settingsElem.innerHTML = '⚠️ API-ключ FlightAPI.io не настроен. Добавьте его в <code>.env</code> или сохраните через форму ниже.';
        }
      } else {
        const remaining = stats ? stats.creditsRemaining : 0;
        const max = stats ? stats.maxCredits : 50;
        const used = stats ? stats.creditsUsed : 0;
        const plan = stats ? stats.plan : 'free_trial';
        const color = remaining <= 4 ? '#ef4444' : '#38bdf8';

        if (statElem) statElem.innerHTML = '<span style="color:' + color + ';">' + remaining + ' / ' + max + ' ост.</span>';
        if (settingsStatusBadge) settingsStatusBadge.innerHTML = '<span class="badge badge-success">Подключен (' + plan + ')</span>';
        if (settingsElem) {
          settingsElem.innerHTML = 'Тариф: <b>' + plan.toUpperCase() + '</b> | Использовано: <b>' + used + ' кр.</b> | Остаток: <b style="color:' + color + ';">' + remaining + ' из ' + max + ' кредитов</b> | Статус: <b>Активен</b>';
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function loadAviaSeekStatus() {
    try {
      const res = await fetch('/api/aviaseek/status');
      const data = await res.json();
      const statElem = document.getElementById('statAviaSeek');
      const settingsElem = document.getElementById('aviaSeekSettingsInfo');
      const settingsStatusBadge = document.getElementById('settingsAviaSeekStatus');
      const btnToggle = document.getElementById('btnToggleAviaSeek');

      const isEnabled = data.enabled;
      if (statElem) {
        statElem.innerHTML = isEnabled 
          ? '<span style="color:#fbbf24;">Подключен ✅</span>' 
          : '<span style="color:#94a3b8;">Отключен</span>';
      }
      if (settingsStatusBadge) {
        settingsStatusBadge.innerHTML = isEnabled 
          ? '<span class="badge badge-success">Включен</span>' 
          : '<span class="badge badge-outline">Отключен</span>';
      }
      if (settingsElem) {
        settingsElem.innerHTML = 'Статус: <b>' + (isEnabled ? 'АКТИВЕН' : 'ОТКЛЮЧЕН') + '</b> | Всего запросов: <b>' + (data.stats?.searchesExecuted || 0) + '</b> | Успешных: <b>' + (data.stats?.successfulSearches || 0) + '</b>';
      }
      if (btnToggle) {
        btnToggle.textContent = isEnabled ? '⏸️ Отключить AviaSeek' : '▶️ Включить AviaSeek';
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function toggleAviaSeek() {
    try {
      const res = await fetch('/api/aviaseek/toggle', { method: 'POST' });
      await res.json();
      await loadAviaSeekStatus();
    } catch (e) {
      alert('Ошибка переключения AviaSeek: ' + e.message);
    }
  }

  async function loadProfiles() {
    try {
      const res = await fetch('/api/profiles');
      profiles = await res.json();
      renderProfiles();
      renderProfileFilter();
    } catch (e) {
      console.error(e);
    }
  }

  function renderProfileFilter() {
    const sel = document.getElementById('filterProfile');
    sel.innerHTML = '<option value="">Все задания</option>';
    profiles.forEach(p => {
      sel.innerHTML += '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>';
    });
  }

  function renderProfiles() {
    const tbody = document.getElementById('profilesTableBody');
    if (profiles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:30px;">Нет заданий. Создайте первое задание!</td></tr>';
      return;
    }

    tbody.innerHTML = profiles.map(p => {
      const statusBadge = p.isActive 
        ? '<span class="badge badge-success" style="cursor:pointer;" onclick="toggleProfile(' + p.id + ')">🟢 Активен</span>' 
        : '<span class="badge badge-danger" style="cursor:pointer;" onclick="toggleProfile(' + p.id + ')">⚪ На паузе</span>';
      const transfersTxt = p.transfers === 0 ? 'Прямой' : (p.transfers === 1 ? 'До 1 перес.' : 'Любые');
      const baggageTxt = p.baggage === '1pc_23kg' ? '1x23 кг' : (p.baggage === '2pc_32kg' ? '2x32 кг' : (p.baggage === 'none' ? 'Ручная кладь' : 'Любой'));

      return '<tr>' +
        '<td><b>#' + p.id + '</b></td>' +
        '<td><b>' + escapeHtml(p.name) + '</b></td>' +
        '<td>' + escapeHtml(p.originDisplay) + ' ➔ ' + escapeHtml(p.destinationDisplay) + '</td>' +
        '<td>' + p.dateStart + ' .. ' + p.dateEnd + '</td>' +
        '<td><span class="badge badge-primary">' + p.cabinClass.toUpperCase() + '</span></td>' +
        '<td>' + p.passengers + ' взр.</td>' +
        '<td><span class="badge badge-outline">' + baggageTxt + '</span></td>' +
        '<td><b>$' + p.budget.toLocaleString() + ' ' + p.currency + '</b></td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' +
          '<div style="display:flex; gap:6px;">' +
            '<button class="btn btn-outline btn-sm" title="Запустить проверку прямо сейчас" onclick="runProfile(' + p.id + ')">🚀</button>' +
            '<button class="btn btn-outline btn-sm" title="Пауза / Возобновить" onclick="toggleProfile(' + p.id + ')">⏯️</button>' +
            '<button class="btn btn-outline btn-sm" title="Копировать задание" onclick="copyProfile(' + p.id + ')">📋</button>' +
            '<button class="btn btn-outline btn-sm" title="Редактировать" onclick="editProfile(' + p.id + ')">✏️</button>' +
            '<button class="btn btn-outline btn-sm" style="color:var(--danger);" title="Удалить" onclick="deleteProfile(' + p.id + ')">🗑️</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function showStatusBanner(type, message) {
    const banner = document.getElementById('searchStatusBanner');
    if (!banner) return;
    banner.style.display = 'block';
    if (type === 'loading') {
      banner.style.background = 'rgba(56, 189, 248, 0.15)';
      banner.style.border = '1px solid #38bdf8';
      banner.style.color = '#38bdf8';
      banner.innerHTML = '⏳ <b>Идет поиск:</b> ' + message;
    } else if (type === 'success') {
      banner.style.background = 'rgba(16, 185, 129, 0.15)';
      banner.style.border = '1px solid #10b981';
      banner.style.color = '#34d399';
      banner.innerHTML = '✅ ' + message;
    } else if (type === 'empty') {
      banner.style.background = 'rgba(245, 158, 11, 0.15)';
      banner.style.border = '1px solid #f59e0b';
      banner.style.color = '#fbbf24';
      banner.innerHTML = 'ℹ️ ' + message;
    } else if (type === 'error') {
      banner.style.background = 'rgba(239, 68, 68, 0.15)';
      banner.style.border = '1px solid #ef4444';
      banner.style.color = '#f87171';
      banner.innerHTML = '❌ <b>Ошибка API:</b> ' + message;
    }
  }

  let activePillProvider = '';
  let activePillRegion = '';
  let activePillDirect = true;

  function setPillFilter(type, val) {
    if (type === 'provider') {
      activePillProvider = val;
      document.querySelectorAll('.pill-btn[data-pill-type="provider"]').forEach(b => {
        b.classList.toggle('active', b.dataset.pillVal === val);
      });
      const sel = document.getElementById('filterProvider');
      if (sel) sel.value = val;
    }
    if (type === 'region') {
      activePillRegion = val;
      document.querySelectorAll('.pill-btn[data-pill-type="region"]').forEach(b => {
        b.classList.toggle('active', b.dataset.pillVal === val);
      });
    }
    loadOffers();
  }

  function togglePillDirect() {
    activePillDirect = !activePillDirect;
    const btn = document.getElementById('pillOnlyDirect');
    if (btn) btn.classList.toggle('active', activePillDirect);
    renderOffers();
  }

  async function toggleScheduler() {
    try {
      const res = await fetch('/api/scheduler/toggle', { method: 'POST' });
      const data = await res.json();
      const sched = data.scheduler;
      const el = document.getElementById('statScheduler');
      if (el) {
        el.innerHTML = sched.isRunning
          ? '<span style="color:#34d399">Активен (' + sched.intervalHours + 'ч)</span>'
          : '<span style="color:#f87171">Отключен ⏸️</span>';
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function loadOffers() {
    try {
      const profileId = document.getElementById('filterProfile').value;
      const targetDates = document.getElementById('filterTargetDates').checked;
      const provider = document.getElementById('filterProvider') ? document.getElementById('filterProvider').value : '';
      let url = '/api/offers?limit=100';
      if (profileId) url += '&profileId=' + profileId;
      if (targetDates) url += '&targetDates=true';
      if (provider) url += '&provider=' + encodeURIComponent(provider);

      const res = await fetch(url);
      offers = await res.json();
      renderOffers();
    } catch (e) {
      console.error(e);
    }
  }

  function renderOffers() {
    const tbody = document.getElementById('offersTableBody');
    const selectedProv = document.getElementById('filterProvider') ? document.getElementById('filterProvider').value : '';

    let list = offers;
    if (activePillDirect) {
      list = list.filter(o => o.transfers === 0);
    }
    if (activePillRegion === 'china') {
      const chinaCodes = ['PEK', 'PKX', 'TFU', 'CAN', 'PVG', 'SHA', 'SZX', 'XIY', 'SYX', 'URC'];
      list = list.filter(o => chinaCodes.includes(o.destination) || (o.destinationName && o.destinationName.includes('Китай')));
    } else if (activePillRegion === 'vietnam') {
      const vnCodes = ['HAN', 'SGN', 'PQC', 'CXR', 'DAD'];
      list = list.filter(o => vnCodes.includes(o.destination) || (o.destinationName && o.destinationName.includes('Вьетнам')));
    } else if (activePillRegion === 'thailand') {
      const thCodes = ['BKK', 'DMK', 'HKT', 'UTP', 'CNX', 'USM'];
      list = list.filter(o => thCodes.includes(o.destination) || (o.destinationName && o.destinationName.includes('Таиланд')));
    }

    if (list.length === 0) {
      let emptyMsg = 'По выбранным фильтрам предложений не найдено.';
      if (selectedProv === 'FlightAPI') {
        emptyMsg = 'По источнику <b>FlightAPI.io</b> предложений не найдено (0 результатов).<br><span style="font-size:0.85rem; color:var(--text-muted);">Нажмите кнопку «✈️ Поиск FlightAPI (Live)» вверху для запуска платного живого поиска.</span>';
      } else if (selectedProv === 'AviaSeek') {
        emptyMsg = 'По источнику <b>AviaSeek</b> предложений не найдено.<br><span style="font-size:0.85rem; color:var(--text-muted);">Нажмите «🟡 Поиск AviaSeek (Live)» для выполнения живого поиска по агрегатору.</span>';
      } else if (selectedProv === 'Travelpayouts') {
        emptyMsg = 'По источнику <b>Travelpayouts</b> кэшированных тарифов не найдено.';
      }
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:35px; color:var(--text-muted); line-height:1.7;">' + emptyMsg + '</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(o => {
      const isAviaSeek = o.provider && o.provider.includes('AviaSeek');
      const flightNum = o.flightNumber ? ' (' + o.flightNumber + ')' : '';
      const plane = o.plane ? '<div style="font-size:0.72rem; color:var(--text-muted);">' + escapeHtml(o.plane) + '</div>' : '';
      const gateText = isAviaSeek ? 'Метапоиск AviaSeek' : escapeHtml(o.gate || '');
      const gate = gateText ? '<div style="font-size:0.75rem; color:var(--text-muted);">Источник: ' + gateText + '</div>' : '';
      const timeStr = o.departureTime ? '<br><span style="font-size:0.78rem; color:var(--text-muted);">' + o.departureTime + ' МСК</span>' : '';
      
      const provBadge = o.provider.includes('FlightAPI')
        ? '<span class="badge badge-success" onclick="setPillFilter(\\'provider\\', \\'FlightAPI\\')" style="font-size:0.7rem;" title="Фильтровать по FlightAPI">FlightAPI Live</span>'
        : (isAviaSeek
          ? '<span class="badge" onclick="setPillFilter(\\'provider\\', \\'AviaSeek\\')" style="font-size:0.7rem; background:#fbbf24; color:#0f172a; font-weight:bold;" title="Фильтровать по AviaSeek">AviaSeek</span>'
          : '<span class="badge badge-outline" onclick="setPillFilter(\\'provider\\', \\'Travelpayouts\\')" style="font-size:0.7rem;" title="Фильтровать по Travelpayouts">Travelpayouts</span>');
      
      const ddmm = (o.departureDate && o.departureDate.length >= 10) ? (o.departureDate.slice(8, 10) + o.departureDate.slice(5, 7)) : '1301';
      const aviasalesUrl = 'https://www.aviasales.ru/search/' + (o.origin || 'MOW') + ddmm + o.destination + 'c2';
      const aviaseekUrl = 'https://aviaseek.com/search?from=' + (o.origin || 'MOW') + '&to=' + o.destination + '&date=' + o.departureDate + '&adults=' + (o.passengers || 2) + '&cabin=' + (o.cabinClass || 'business');

      let airlineUrl = '';
      const aUpper = (o.airline || '').toUpperCase();
      if (aUpper.includes('AIR CHINA')) airlineUrl = 'https://www.airchina.com';
      else if (aUpper.includes('CHINA EASTERN')) airlineUrl = 'https://ru.ceair.com';
      else if (aUpper.includes('CHINA SOUTHERN')) airlineUrl = 'https://www.csair.com';
      else if (aUpper.includes('SICHUAN')) airlineUrl = 'https://www.sichuanair.com';
      else if (aUpper.includes('VIETNAM')) airlineUrl = 'https://www.vietnamairlines.com';
      else if (aUpper.includes('АЭРОФЛОТ')) airlineUrl = 'https://www.aeroflot.ru';

      const airlineLink = airlineUrl ? '<a href="' + airlineUrl + '" target="_blank" style="font-size:0.74rem; color:#38bdf8; display:block; margin-top:2px; text-decoration:underline;">Сайт авиакомпании ↗</a>' : '';

      const actionBtn = '<div style="display:flex; flex-direction:column; gap:4px; min-width:160px;">' +
        '<a href="' + aviasalesUrl + '" target="_blank" class="live-buy-btn" style="background:#0284c7; padding:7px 10px; font-size:0.82rem; justify-content:center;" title="Открыть рейс со всеми продавцами на Aviasales">' +
          '🛒 Купить (Aviasales)' +
        '</a>' +
        '<a href="' + aviaseekUrl + '" target="_blank" class="btn btn-outline btn-sm" style="font-size:0.75rem; justify-content:center; border-color:#475569;" title="Открыть выдачу метапоиска AviaSeek">' +
          '🟡 Поиск AviaSeek' +
        '</a>' +
        airlineLink +
      '</div>';

      const priceHtml = '<div class="price-tag"><a href="' + aviasalesUrl + '" target="_blank" style="color:inherit; text-decoration:none;" title="Нажмите для перехода к покупке">$' + o.priceTotal.toLocaleString() + ' ' + o.currency + '</a></div>' +
        '<div class="price-sub">$' + o.pricePerPassenger.toLocaleString() + '/чел. (x' + o.passengers + ')</div>';

      const transfersBadge = o.transfers === 0
        ? '<span class="badge badge-success" onclick="togglePillDirect()" title="Нажмите для фильтрации">Прямой (0)</span>'
        : '<span class="badge badge-warning">' + o.transfers + ' перес.</span>';

      return '<tr>' +
        '<td><b>' + o.departureDate + '</b>' + timeStr + '<br>' + provBadge + '</td>' +
        '<td><a href="' + aviasalesUrl + '" target="_blank" style="color:inherit; text-decoration:none;" title="Открыть направление на Aviasales"><b>' + escapeHtml(o.destinationName) + '</b><br><span style="font-size:0.75rem; color:var(--text-muted);">' + o.origin + ' ➔ ' + o.destination + ' ↗</span></a></td>' +
        '<td>' + escapeHtml(o.airline) + flightNum + plane + gate + '</td>' +
        '<td><span class="badge badge-primary">' + o.cabinClass.toUpperCase() + '</span></td>' +
        '<td>' + transfersBadge + '</td>' +
        '<td>' + priceHtml + '</td>' +
        '<td><span class="badge badge-warning" title="' + escapeHtml(o.baggageDetails) + '">BAGGAGE_UNKNOWN</span></td>' +
        '<td>' + o.dataAgeMinutes + ' мин назад</td>' +
        '<td>' + actionBtn + '</td>' +
      '</tr>';
    }).join('');
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      const rows = await res.json();
      const tbody = document.getElementById('historyTableBody');
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px;">История пуста.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => 
        '<tr>' +
          '<td><b>' + escapeHtml(r.routeKey) + '</b></td>' +
          '<td>' + r.departureDate + '</td>' +
          '<td><b style="color:var(--primary-light)">$' + r.priceTotal.toLocaleString() + ' ' + r.currency + '</b></td>' +
          '<td>' + new Date(r.recordedAt).toLocaleString('ru-RU') + '</td>' +
        '</tr>'
      ).join('');
    } catch (e) {
      console.error(e);
    }
  }

  async function triggerScanAll() {
    const btn = document.getElementById('btnScanAll');
    btn.disabled = true;
    btn.textContent = '⏳ Поиск...';
    showStatusBanner('loading', 'Выполняется поиск по всем активным заданиям... Пожалуйста, подождите.');
    try {
      const res = await fetch('/api/scan-all', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Ошибка сканирования');

      const count = data.offersFound || 0;
      if (count > 0) {
        showStatusBanner('success', 'Проверка всех заданий завершена! Найдено тарифов: <b>' + count + '</b>.');
      } else {
        showStatusBanner('empty', 'Проверка завершена: новых тарифов не найдено (0 результатов).');
      }

      await loadOffers();
      await loadProfiles();
      await loadStatus();
    } catch (e) {
      showStatusBanner('error', e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Проверить все';
    }
  }

  async function triggerClearSystem() {
    if (!confirm('Вы уверены, что хотите очистить кэш найденных билетов и сбросить историю отправленных алертов?\n(Поисковые задания и история графиков сохранятся)')) {
      return;
    }
    const btn = document.getElementById('btnClearDb');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/clear', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка очистки');
      showStatusBanner('success', 'База очищена! Удалено тарифов: <b>' + data.offersCleared + '</b>, сброшено алертов: <b>' + data.alertsCleared + '</b>.');
      await loadOffers();
      await loadStatus();
    } catch (e) {
      showStatusBanner('error', e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function triggerScanAviaSeek() {
    const btn = document.getElementById('btnScanAviaSeek');
    btn.disabled = true;
    btn.textContent = '⏳ Поиск AviaSeek...';
    showStatusBanner('loading', 'Выполняется живой опрос метапоиска AviaSeek (Aviasales Live)... Пожалуйста, подождите.');
    try {
      const res = await fetch('/api/scan-all?provider=aviaseek', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Сбой запроса к AviaSeek');

      const count = data.offersFound || 0;
      if (count > 0) {
        showStatusBanner('success', 'Поиск AviaSeek (Live) завершен! Найдено предложений: <b>' + count + '</b>.');
      } else {
        showStatusBanner('empty', 'Поиск AviaSeek завершен: предложений не найдено (0 результатов).');
      }

      // Automatically filter table by AviaSeek to clearly show the result of this source!
      const provSel = document.getElementById('filterProvider');
      if (provSel) provSel.value = 'AviaSeek';

      await loadOffers();
      await loadProfiles();
      await loadStatus();
      await loadAviaSeekStatus();
    } catch (e) {
      showStatusBanner('error', e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🟡 Поиск AviaSeek (Live)';
    }
  }

  async function triggerScanFlightApi() {
    // 1. Get current credit status for explicit user confirmation
    let creditsRemaining = null;
    let plan = 'free_trial';
    try {
      const st = await fetch('/api/flightapi/status').then(r => r.json());
      if (st.configured && st.stats) {
        creditsRemaining = st.stats.creditsRemaining;
        plan = st.stats.plan;
      }
    } catch (_) {}

    const creditsInfo = creditsRemaining !== null
      ? 'Остаток: ' + creditsRemaining + ' кредитов (Тариф: ' + plan.toUpperCase() + ').'
      : 'Каждый поисковый запрос расходует 2 кредита.';

    const confirmMsg = "⚠️ ПОДТВЕРЖДЕНИЕ ПЛАТНОГО ПОИСКА FLIGHTAPI.IO\\n\\n" +
      "Поиск через коммерческий B2B API FlightAPI.io расходует платные кредиты тарифа.\\n" +
      creditsInfo + "\\n\\n" +
      "Вы подтверждаете запуск поиска?";
    const confirmed = confirm(confirmMsg);

    if (!confirmed) {
      return; // Aborted by user - no credits spent
    }

    const btn = document.getElementById('btnScanFlightApi');
    btn.disabled = true;
    btn.textContent = '⏳ Поиск FlightAPI...';
    showStatusBanner('loading', 'Выполняется платный живой поиск через FlightAPI.io... Пожалуйста, подождите.');

    try {
      const res = await fetch('/api/scan-all?provider=flightapi', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Сбой запроса к FlightAPI.io');

      const count = data.offersFound || 0;
      if (data.errors && data.errors.length > 0 && count === 0) {
        showStatusBanner('error', data.errors.join('; '));
      } else if (count > 0) {
        showStatusBanner('success', 'Поиск FlightAPI.io успешно завершен! Найдено тарифов: <b>' + count + '</b>.');
      } else {
        showStatusBanner('empty', 'Поиск FlightAPI.io завершен: прямых билетов по заданным критериям не найдено (0 предложений).');
      }

      // Automatically filter table by FlightAPI so only its results are shown!
      const provSel = document.getElementById('filterProvider');
      if (provSel) provSel.value = 'FlightAPI';

      await loadOffers();
      await loadProfiles();
      await loadStatus();
      await loadFlightApiStatus();
    } catch (e) {
      showStatusBanner('error', e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✈️ Поиск FlightAPI (Live)';
    }
  }

  async function saveFlightApiKey() {
    const input = document.getElementById('flightApiKeyInput');
    const key = input.value.trim();
    if (!key) return alert('Пожалуйста, введите API-ключ FlightAPI.io.');

    try {
      const res = await fetch('/api/flightapi/set-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      input.value = '';
      await loadFlightApiStatus();
      alert('API-ключ FlightAPI.io успешно сохранен! Статус обновлен.');
    } catch (e) {
      alert('Ошибка сохранения ключа: ' + e.message);
    }
  }

  async function saveFlightApiPlan() {
    const sel = document.getElementById('flightApiPlanSelect');
    const plan = sel.value;
    let maxCredits = 50;
    if (plan === 'lite') maxCredits = 30000;
    if (plan === 'standard') maxCredits = 100000;
    if (plan === 'plus') maxCredits = 500000;

    try {
      const res = await fetch('/api/flightapi/set-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, maxCredits })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      await loadFlightApiStatus();
      alert('Тарифный план FlightAPI обновлен на: ' + plan.toUpperCase() + ' (Лимит: ' + maxCredits + ' кредитов).');
    } catch (e) {
      alert('Ошибка обновления плана: ' + e.message);
    }
  }

  async function runProfile(id) {
    if (!confirm('Запустить немедленную проверку задания #' + id + '?')) return;
    try {
      const res = await fetch('/api/profiles/' + id + '/run', { method: 'POST' });
      await res.json();
      await loadOffers();
      await loadProfiles();
      alert('Проверка задания завершена!');
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async function toggleProfile(id) {
    await fetch('/api/profiles/' + id + '/toggle', { method: 'POST' });
    await loadProfiles();
  }

  async function copyProfile(id) {
    await fetch('/api/profiles/' + id + '/copy', { method: 'POST' });
    await loadProfiles();
  }

  async function deleteProfile(id) {
    if (!confirm('Вы действительно хотите удалить задание #' + id + '?')) return;
    await fetch('/api/profiles/' + id, { method: 'DELETE' });
    await loadProfiles();
    await loadOffers();
  }

  function openProfileModal(profile = null) {
    document.getElementById('profileForm').reset();
    document.getElementById('formProfileId').value = '';
    document.getElementById('modalTitle').textContent = 'Создать новое поисковое задание';

    if (profile) {
      document.getElementById('modalTitle').textContent = 'Редактировать задание #' + profile.id;
      document.getElementById('formProfileId').value = profile.id;
      document.getElementById('formName').value = profile.name;
      document.getElementById('formOrigin').value = profile.origin;
      document.getElementById('formOriginDisplay').value = profile.originDisplay;
      document.getElementById('formDestination').value = profile.destination;
      document.getElementById('formDestinationDisplay').value = profile.destinationDisplay;
      document.getElementById('formDateStart').value = profile.dateStart;
      document.getElementById('formDateEnd').value = profile.dateEnd;
      document.getElementById('formCabinClass').value = profile.cabinClass;
      document.getElementById('formPassengers').value = profile.passengers;
      document.getElementById('formTransfers').value = profile.transfers;
      document.getElementById('formBaggage').value = profile.baggage;
      document.getElementById('formBudget').value = profile.budget;
      document.getElementById('formCurrency').value = profile.currency;
      document.getElementById('formPreferredAirlines').value = profile.preferredAirlines || '';
      document.getElementById('formExcludedAirlines').value = profile.excludedAirlines || '';
      document.getElementById('formPollInterval').value = profile.pollIntervalHours;
      document.getElementById('formNotifications').checked = profile.notificationsEnabled;
    } else {
      document.getElementById('formOriginDisplay').value = 'Москва';
      document.getElementById('formOrigin').value = 'MOW';
      document.getElementById('formDestinationDisplay').value = 'Китай, Таиланд, Вьетнам (все направления)';
      document.getElementById('formDestination').value = 'PEK,PKX,PVG,CAN,TFU,SZX,XIY,SYX,BKK,HKT,HAN,SGN,PQC';
      document.getElementById('formDateStart').value = '2027-01-12';
      document.getElementById('formDateEnd').value = '2027-01-18';
      document.getElementById('formBudget').value = '2000';
    }

    document.getElementById('profileModal').style.display = 'flex';
  }

  function closeProfileModal() {
    document.getElementById('profileModal').style.display = 'none';
  }

  function editProfile(id) {
    const p = profiles.find(x => x.id === id);
    if (p) openProfileModal(p);
  }

  async function saveProfile(e) {
    e.preventDefault();
    const id = document.getElementById('formProfileId').value;
    const data = {
      name: document.getElementById('formName').value,
      origin: document.getElementById('formOrigin').value,
      originDisplay: document.getElementById('formOriginDisplay').value,
      destination: document.getElementById('formDestination').value,
      destinationDisplay: document.getElementById('formDestinationDisplay').value,
      dateStart: document.getElementById('formDateStart').value,
      dateEnd: document.getElementById('formDateEnd').value,
      cabinClass: document.getElementById('formCabinClass').value,
      passengers: parseInt(document.getElementById('formPassengers').value, 10),
      transfers: parseInt(document.getElementById('formTransfers').value, 10),
      baggage: document.getElementById('formBaggage').value,
      budget: parseFloat(document.getElementById('formBudget').value),
      currency: document.getElementById('formCurrency').value,
      preferredAirlines: document.getElementById('formPreferredAirlines').value,
      excludedAirlines: document.getElementById('formExcludedAirlines').value,
      pollIntervalHours: parseInt(document.getElementById('formPollInterval').value, 10),
      notificationsEnabled: document.getElementById('formNotifications').checked,
      tripType: 'one_way',
      isActive: true
    };

    if (id) {
      await fetch('/api/profiles/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } else {
      await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }

    closeProfileModal();
    await loadProfiles();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  init();
</script>
</body>
</html>`;
  }

  private escapeHtml(str: string): string {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private renderPriceChangedPage(offer: any, verifyRes: any): string {
    const flightTitle = `${offer.airline} ${offer.flightNumber || ""} (${offer.origin} ➔ ${offer.destination})`;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Изменение цены — Flight Hunter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #070d19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 85vh; margin: 0; padding: 20px; }
    .card { background: #0f172a; padding: 36px; border-radius: 12px; max-width: 620px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h2 { color: #c084fc; margin-top: 0; font-size: 1.4rem; }
    .info-box { background: rgba(168,85,247,0.1); border: 1px solid rgba(168,85,247,0.3); border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 0.95rem; line-height: 1.6; color: #e9d5ff; text-align: left; }
    .btn-group { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.95rem; }
    .btn-primary { background: #0284c7; color: #fff; }
    .btn-primary:hover { background: #0369a1; }
    .btn-outline { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
    .btn-outline:hover { background: rgba(255,255,255,0.06); }
  </style>
</head>
<body>
  <div class="card">
    <h2>⚠️ Цена предложения изменилась</h2>
    <div class="info-box">
      <div><b>Рейс:</b> ${this.escapeHtml(flightTitle)}</div>
      <div><b>Дата:</b> ${offer.departureDate} | <b>Класс:</b> ${offer.cabinClass.toUpperCase()} (${offer.passengers} взр.)</div>
      <div style="margin-top:10px; font-size:1.1rem;">
        <span style="text-decoration: line-through; color: #94a3b8;">Старая цена: $${offer.priceTotal}</span> &nbsp;➔&nbsp; 
        <b style="color: #38bdf8;">Новая цена: $${verifyRes.priceTotal}</b>
      </div>
      <div style="margin-top:6px; color:#cbd5e1;"><b>Продавец:</b> ${this.escapeHtml(verifyRes.sellerName || "Купибилет")}</div>
    </div>
    <p style="color:#94a3b8; font-size:0.9rem;">В соответствии с правилами честной прозрачности Flight Hunter мы не перенаправляем автоматически, если стоимость билета изменилась.</p>
    <div class="btn-group">
      <a href="${this.escapeHtml(verifyRes.bookingUrl)}" target="_blank" class="btn btn-primary">Купить по новой цене ($${verifyRes.priceTotal})</a>
      <a href="/" class="btn btn-outline">Вернуться в Flight Hunter</a>
    </div>
  </div>
</body>
</html>`;
  }

  private renderAccessDeniedPage(offer: any, verifyRes: any): string {
    const flightTitle = `${offer.airline} ${offer.flightNumber || ""} (${offer.origin} ➔ ${offer.destination})`;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Защита WAF продавца — Flight Hunter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #070d19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 85vh; margin: 0; padding: 20px; }
    .card { background: #0f172a; padding: 36px; border-radius: 12px; max-width: 620px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h2 { color: #fbbf24; margin-top: 0; font-size: 1.4rem; }
    .info-box { background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.3); border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 0.95rem; line-height: 1.6; color: #fef08a; text-align: left; }
    .btn-group { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.95rem; }
    .btn-primary { background: #d97706; color: #fff; }
    .btn-primary:hover { background: #b45309; }
    .btn-outline { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
    .btn-outline:hover { background: rgba(255,255,255,0.06); }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔒 Защита продавца от автоматических запросов (HTTP 403)</h2>
    <div class="info-box">
      <div><b>Рейс:</b> ${this.escapeHtml(flightTitle)}</div>
      <div><b>Дата:</b> ${offer.departureDate} | <b>Класс:</b> ${offer.cabinClass.toUpperCase()} (${offer.passengers} взр.)</div>
      <div><b>Зафиксированная стоимость:</b> $${offer.priceTotal} USD</div>
      <div style="margin-top:10px; font-size:0.88rem; color:#fde047;">
        <b>Причина:</b> Веб-сервер продавца (AWS ELB/WAF) блокирует программные проверки со стороны сервера (HTTP 403 Forbidden). Ссылка предназначена для открытия обычным пользователем в браузере.
      </div>
    </div>
    <p style="color:#94a3b8; font-size:0.9rem;">Билет сохранен в системе и не считается распроданным. Вы можете открыть прямое предложение продавца в обычном браузере:</p>
    <div class="btn-group">
      <a href="${this.escapeHtml(offer.deepLink || offer.liveSearchUrl)}" target="_blank" class="btn btn-primary">🌐 Открыть предложение в браузере</a>
      <a href="/" class="btn btn-outline">Вернуться в Flight Hunter</a>
    </div>
  </div>
</body>
</html>`;
  }

  private renderTimeoutPage(offer: any, verifyRes: any): string {
    const flightTitle = `${offer.airline} ${offer.flightNumber || ""} (${offer.origin} ➔ ${offer.destination})`;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Тайм-аут проверки — Flight Hunter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #070d19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 85vh; margin: 0; padding: 20px; }
    .card { background: #0f172a; padding: 36px; border-radius: 12px; max-width: 620px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h2 { color: #94a3b8; margin-top: 0; font-size: 1.4rem; }
    .info-box { background: rgba(148,163,184,0.1); border: 1px solid rgba(148,163,184,0.3); border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 0.95rem; line-height: 1.6; color: #e2e8f0; text-align: left; }
    .btn-group { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.95rem; }
    .btn-primary { background: #0284c7; color: #fff; }
    .btn-primary:hover { background: #0369a1; }
    .btn-outline { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
    .btn-outline:hover { background: rgba(255,255,255,0.06); }
  </style>
</head>
<body>
  <div class="card">
    <h2>⏱️ Тайм-аут при проверке тарифа</h2>
    <div class="info-box">
      <div><b>Рейс:</b> ${this.escapeHtml(flightTitle)}</div>
      <div><b>Дата:</b> ${offer.departureDate} | <b>Класс:</b> ${offer.cabinClass.toUpperCase()}</div>
      <div><b>Причина:</b> Сервер поставщика не ответил в течение 3.5 секунд. Билет сохранен и не снят с мониторинга.</div>
    </div>
    <div class="btn-group">
      <a href="/api/offers/${offer.id}/checkout" class="btn btn-primary">🔄 Повторить проверку</a>
      <a href="${this.escapeHtml(offer.deepLink || offer.liveSearchUrl)}" target="_blank" class="btn btn-outline">🌐 Открыть ссылку напрямую</a>
      <a href="/" class="btn btn-outline">Вернуться</a>
    </div>
  </div>
</body>
</html>`;
  }

  private renderNotAvailablePage(offer: any, verifyRes: any): string {
    const flightTitle = `${offer.airline} ${offer.flightNumber || ""} (${offer.origin} ➔ ${offer.destination})`;
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Билет распродан — Flight Hunter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #070d19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 85vh; margin: 0; padding: 20px; }
    .card { background: #0f172a; padding: 36px; border-radius: 12px; max-width: 620px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h2 { color: #f87171; margin-top: 0; font-size: 1.4rem; }
    .info-box { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 0.95rem; line-height: 1.6; color: #fca5a5; text-align: left; }
    .btn-group { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.95rem; }
    .btn-primary { background: #0284c7; color: #fff; }
    .btn-primary:hover { background: #0369a1; }
  </style>
</head>
<body>
  <div class="card">
    <h2>❌ Билет распродан у продавцов</h2>
    <div class="info-box">
      <div><b>Рейс:</b> ${this.escapeHtml(flightTitle)}</div>
      <div><b>Дата:</b> ${offer.departureDate} | <b>Класс:</b> ${offer.cabinClass.toUpperCase()} (${offer.passengers} взр.)</div>
      <div style="margin-top:8px;">${this.escapeHtml(verifyRes.message || "Места в бизнес-классе на этот рейс закончились.")}</div>
    </div>
    <p style="color:#94a3b8; font-size:0.9rem;"><b>Честный поиск Flight Hunter:</b> мы никогда не подменяем выбранный прямой рейс альтернативными билетами других авиакомпаний с пересадками (например, Azerbaijan Airlines через Баку). Билет переведен в статус «НЕДОСТУПЕН».</p>
    <div class="btn-group">
      <a href="/" class="btn btn-primary">Вернуться в Flight Hunter</a>
    </div>
  </div>
</body>
</html>`;
  }

  private renderOfferExpiredPage(offer: any, verifyRes: any): string {
    const flightTitle = `${offer.airline} ${offer.flightNumber || ""} (${offer.origin} ➔ ${offer.destination})`;
    const isGeneral = verifyRes.isGeneralSearch || (verifyRes.bookingUrl && (verifyRes.bookingUrl.includes("/search") || verifyRes.bookingUrl.includes("/results")));
    const actionBtn = isGeneral
      ? `<a href="${this.escapeHtml(verifyRes.bookingUrl || 'https://aviaseek.com/results')}" target="_blank" class="btn btn-primary">🌐 Открыть поиск у источника (AviaSeek)</a>`
      : `<a href="${this.escapeHtml(offer.deepLink || offer.liveSearchUrl)}" target="_blank" class="btn btn-primary">🌐 Открыть исходную ссылку</a>`;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Ссылка устарела — Flight Hunter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #070d19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 85vh; margin: 0; padding: 20px; }
    .card { background: #0f172a; padding: 36px; border-radius: 12px; max-width: 620px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h2 { color: #f97316; margin-top: 0; font-size: 1.4rem; }
    .info-box { background: rgba(249,115,22,0.1); border: 1px solid rgba(249,115,22,0.3); border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 0.95rem; line-height: 1.6; color: #fdba74; text-align: left; }
    .btn-group { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
    .btn { display: inline-block; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.95rem; }
    .btn-primary { background: #ea580c; color: #fff; }
    .btn-primary:hover { background: #c2410c; }
    .btn-outline { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
    .btn-outline:hover { background: rgba(255,255,255,0.06); }
  </style>
</head>
<body>
  <div class="card">
    <h2>⏳ Срок действия ссылки истек</h2>
    <div class="info-box">
      <div><b>Рейс:</b> ${this.escapeHtml(flightTitle)}</div>
      <div><b>Дата:</b> ${offer.departureDate} | <b>Класс:</b> ${offer.cabinClass.toUpperCase()} (${offer.passengers} взр.)</div>
      <div style="margin-top:8px;">${this.escapeHtml(verifyRes.message || "Динамическая ссылка на бронирование действует 15 минут. Продавец перенаправляет на общую страницу выдачи поиска.")}</div>
    </div>
    <p style="color:#94a3b8; font-size:0.9rem;">Чтобы не вводить вас в заблуждение, мы не выдаем ссылку на общий поиск за подтвержденный билет конкретной авиакомпании.</p>
    <div class="btn-group">
      ${actionBtn}
      <a href="/" class="btn btn-outline">Вернуться в Flight Hunter</a>
    </div>
  </div>
</body>
</html>`;
  }
}
