export interface TelegramBotHandlers {
  onManualSearch: () => Promise<string>;
  onGetTopDeals: () => Promise<string>;
  onGetDailySummary: () => Promise<string>;
  onGetStatus: () => Promise<string>;
  onClearSystem?: () => Promise<string>;
}

export class TelegramBotService {
  private botToken?: string;
  private allowedChatId?: string;
  private isPolling = false;
  private lastUpdateId = 0;
  private abortController?: AbortController;
  private handlers?: TelegramBotHandlers;
  private sentMessageIds = new Set<number>();

  constructor(botToken?: string, allowedChatId?: string) {
    this.botToken = botToken;
    this.allowedChatId = allowedChatId;
  }

  public isConfigured(): boolean {
    return Boolean(this.botToken && this.allowedChatId);
  }

  public setHandlers(handlers: TelegramBotHandlers): void {
    this.handlers = handlers;
  }

  private getKeyboardMarkup() {
    return {
      keyboard: [
        [{ text: "🔍 Найти билеты сейчас" }, { text: "🏆 ТОП билетов" }],
        [{ text: "🌐 Google Flights и Отели" }, { text: "✈️ Skyscanner (Азия)" }],
        [{ text: "📊 Статус системы" }, { text: "🧹 Очистить систему" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    };
  }

  /**
   * Send a formatted HTML notification to the whitelisted user chat.
   * Can include inline keyboard buttons (e.g. [Купить], [Очистить поиск]) attached to the message.
   */
  public async sendAlert(
    messageHtml: string,
    inlineKeyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.log("[Telegram] Bot not fully configured (token or chat ID missing). Skipping notification.");
      return false;
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      const reply_markup = inlineKeyboard && inlineKeyboard.length > 0
        ? { inline_keyboard: inlineKeyboard }
        : this.getKeyboardMarkup();

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.allowedChatId,
          text: messageHtml,
          parse_mode: "HTML",
          disable_web_page_preview: false,
          reply_markup
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Telegram Error] Failed to send message (${res.status}): ${errText}`);
        return false;
      }
      const data: any = await res.json();
      if (data.ok && data.result?.message_id) {
        this.sentMessageIds.add(data.result.message_id);
      }
      return true;
    } catch (err: any) {
      console.error(`[Telegram Error] Network error sending alert: ${err.message}`);
      return false;
    }
  }

  /**
   * Delete previously sent messages from the chat to clean up the conversation.
   */
  public async deleteAllChatMessages(aroundMessageId?: number): Promise<number> {
    if (!this.isConfigured()) return 0;

    const idsToDelete = new Set<number>(this.sentMessageIds);
    if (aroundMessageId && aroundMessageId > 0) {
      for (let i = Math.max(1, aroundMessageId - 60); i <= aroundMessageId; i++) {
        idsToDelete.add(i);
      }
    }

    let deleted = 0;
    for (const msgId of idsToDelete) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.botToken}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.allowedChatId,
            message_id: msgId
          })
        });
        const data: any = await res.json();
        if (data.ok) deleted++;
      } catch (_) {}
    }
    this.sentMessageIds.clear();
    return deleted;
  }

  /**
   * Start long polling for Telegram commands (/search, /top, /daily, /status).
   */
  public startPolling(): void {
    if (!this.isConfigured()) {
      console.log("[Telegram] Long polling not started (bot token or chat ID not set).");
      return;
    }

    if (this.isPolling) return;
    this.isPolling = true;
    this.abortController = new AbortController();

    console.log(`[Telegram] Starting long polling for whitelisted Chat ID: ${this.allowedChatId}`);
    this.pollLoop();
  }

  public stopPolling(): void {
    this.isPolling = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    console.log("[Telegram] Long polling stopped.");
  }

  private async pollLoop(): Promise<void> {
    while (this.isPolling) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=25`;
        const res = await fetch(url, {
          signal: this.abortController?.signal
        });

        if (!res.ok) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const data: any = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.handleUpdate(update);
          }
        }
      } catch (err: any) {
        if (!this.isPolling) break;
        // Exponential/gentle sleep on connection error
        await new Promise(r => setTimeout(r, 4000));
      }
    }
  }

  private async handleCallbackQuery(cb: any): Promise<void> {
    const chatId = String(cb.message?.chat?.id || cb.from?.id);
    if (this.allowedChatId && chatId !== this.allowedChatId) return;

    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: cb.id,
          text: "🧹 Удаляю старые сообщения и очищаю базу..."
        })
      });
    } catch (_) {}

    const data = cb.data;
    if (data === "clear_system") {
      const msgId = cb.message?.message_id;
      const deletedCount = await this.deleteAllChatMessages(msgId);

      let resText = "🧹 <b>Чат и поисковая система полностью очищены!</b>\n\nВсе старые сообщения и кэш тарифов сброшены.";
      if (this.handlers?.onClearSystem) {
        resText = await this.handlers.onClearSystem();
      }
      resText += `\n🗑️ Удалено предыдущих сообщений из чата: <b>${deletedCount}</b>`;
      await this.reply(chatId, resText);
    }
  }

  private async handleUpdate(update: any): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Security check: Whitelist only
    if (this.allowedChatId && chatId !== this.allowedChatId) {
      console.warn(`[Telegram Security] Blocked unauthorized message from Chat ID: ${chatId}`);
      await this.reply(chatId, "⛔ <b>Доступ запрещен.</b> Этот бот работает только для авторизованного владельца.");
      return;
    }

    const command = text.split(" ")[0].toLowerCase();
    const lowerText = text.toLowerCase();

    if (command === "/start" || command === "/help") {
      await this.reply(chatId, `
✈️ <b>FLIGHT HUNTER — МОНИТОРИНГ БИЗНЕС-КЛАССА</b>

Добро пожаловать! Бот отслеживает прямые рейсы бизнес-класса (180° спальные кровати) в Китай (Пекин, Чэнду, Шанхай, Гуанчжоу) на 12–18 января 2027 года.

<b>Быстрые кнопки внизу экрана:</b>
🔍 <b>Найти билеты сейчас</b> — внеплановый живой опрос
🏆 <b>ТОП билетов</b> — минимальные найденные тарифы
📊 <b>Статус системы</b> — расписание и параметры поиска
🧹 <b>Очистить систему</b> — сбросить кэш и историю для поиска с нуля
      `.trim());
      return;
    }

    if (command === "/clear" || command === "/reset" || lowerText.includes("очистить систему") || lowerText === "очистить") {
      const msgId = msg.message_id;
      const deletedCount = await this.deleteAllChatMessages(msgId);

      let resText = "🧹 <b>Чат и поисковая система полностью очищены!</b>";
      if (this.handlers?.onClearSystem) {
        resText = await this.handlers.onClearSystem();
      }
      resText += `\n🗑️ Удалено предыдущих сообщений из чата: <b>${deletedCount}</b>`;
      await this.reply(chatId, resText);
      return;
    }

    if (command === "/search" || lowerText.includes("найти билеты")) {
      if (this.handlers?.onManualSearch) {
        await this.reply(chatId, "🔄 <i>Запускаю поиск по всем направлениям Азии... Это займет около 15–20 секунд.</i>");
        const result = await this.handlers.onManualSearch();
        await this.reply(chatId, result);
      }
      return;
    }

    if (command === "/top" || command === "/best" || lowerText.includes("топ билетов")) {
      if (this.handlers?.onGetTopDeals) {
        const topDealsText = await this.handlers.onGetTopDeals();
        await this.reply(chatId, topDealsText);
      }
      return;
    }

    if (command === "/google" || command === "/hotels" || lowerText.includes("google") || lowerText.includes("отели")) {
      const googleText = `
🌐 <b>БЫСТРЫЙ ПОИСК В GOOGLE FLIGHTS И GOOGLE ОТЕЛИ</b>

Прямые ссылки для мгновенного просмотра расписания, удобств, 180° кроватей и цен в реальном времени:

✈️ <b>ДАЛЬНЕЕ ПЛЕЧО (Бизнес 180° кровать, 12–18 января):</b>
• 🇨🇳 <b>Москва ➔ Гуанчжоу:</b> <a href="https://www.google.com/travel/flights?q=Flights%20to%20CAN%20from%20MOW%20on%202027-01-13%20business%20class%20for%202%20adults&hl=ru">Google Flights (Air China / China Southern)</a>
• 🇨🇳 <b>Москва ➔ Чэнду:</b> <a href="https://www.google.com/travel/flights?q=Flights%20to%20TFU%20from%20MOW%20on%202027-01-13%20business%20class%20for%202%20adults&hl=ru">Google Flights (Sichuan Airlines A350)</a>
• 🇨🇳 <b>Москва ➔ Пекин:</b> <a href="https://www.google.com/travel/flights?q=Flights%20to%20PEK%20from%20MOW%20on%202027-01-13%20business%20class%20for%202%20adults&hl=ru">Google Flights (Air China B777)</a>

🏖️ <b>ВТОРОЕ ПЛЕЧО (Курорты из Гуанчжоу, 15–22 января):</b>
• 🇻🇳 <b>Гуанчжоу ➔ Дананг (Вьетнам):</b> <a href="https://www.google.com/travel/flights?q=Flights%20to%20DAD%20from%20CAN%20on%202027-01-16%20for%202%20adults&hl=ru">Google Flights (2 часа!)</a>
• 🇹🇭 <b>Гуанчжоу ➔ Бангкок (Таиланд):</b> <a href="https://www.google.com/travel/flights?q=Flights%20to%20BKK%20from%20CAN%20on%202027-01-16%20for%202%20adults&hl=ru">Google Flights (2.5 часа)</a>
• 🇹🇭 <b>Гуанчжоу ➔ Пхукет (Таиланд):</b> <a href="https://www.google.com/travel/flights?q=Flights%20to%20HKT%20from%20CAN%20on%202027-01-16%20for%202%20adults&hl=ru">Google Flights (3 часа)</a>

🏨 <b>ОТЕЛИ НА GOOGLE HOTELS:</b>
• 🇨🇳 <a href="https://www.google.com/travel/hotels?q=Hotels%20in%20Guangzhou&hl=ru">Отели в Гуанчжоу (2–3 дня без визы)</a>
• 🇻🇳 <a href="https://www.google.com/travel/hotels?q=Hotels%20in%20Da%20Nang&hl=ru">Отели и курорты в Дананге (море)</a>
• 🇹🇭 <a href="https://www.google.com/travel/hotels?q=Hotels%20in%20Bangkok&hl=ru">Отели в Бангкоке</a>
      `.trim();

      const inlineKeyboard = [
        [
          { text: "🇨🇳 Гуанчжоу Бизнес", url: "https://www.google.com/travel/flights?q=Flights%20to%20CAN%20from%20MOW%20on%202027-01-13%20business%20class%20for%202%20adults&hl=ru" },
          { text: "🇻🇳 Дананг Пляж (2ч)", url: "https://www.google.com/travel/flights?q=Flights%20to%20DAD%20from%20CAN%20on%202027-01-16%20for%202%20adults&hl=ru" }
        ],
        [
          { text: "🇹🇭 Бангкок (2.5ч)", url: "https://www.google.com/travel/flights?q=Flights%20to%20BKK%20from%20CAN%20on%202027-01-16%20for%202%20adults&hl=ru" },
          { text: "🏨 Отели Гуанчжоу", url: "https://www.google.com/travel/hotels?q=Hotels%20in%20Guangzhou&hl=ru" }
        ]
      ];

      await this.sendAlert(googleText, inlineKeyboard);
      return;
    }

    if (command === "/skyscanner" || lowerText.includes("skyscanner")) {
      const skyText = `
✈️ <b>БЫСТРЫЙ ПОИСК В SKYSCANNER (МЕЖДУНАРОДНЫЕ РЕЙСЫ ПО АЗИИ)</b>

Skyscanner идеально подходит для перелётов между Китаем, Вьетнамом и Таиландом на 2 человек (прямые рейсы):

🇻🇳 <b>КУРОРТЫ ВЬЕТНАМА ИЗ ГУАНЧЖОУ (15–22 января):</b>
• <b>Гуанчжоу ➔ Дананг (Пляжи):</b> <a href="https://www.skyscanner.net/transport/flights/can/dad/270116/?adultsv2=2&cabinclass=economy&preferdirects=true">Открыть в Skyscanner (2 часа лёта!)</a>
• <b>Гуанчжоу ➔ Ханой:</b> <a href="https://www.skyscanner.net/transport/flights/can/han/270116/?adultsv2=2&cabinclass=economy&preferdirects=true">Открыть в Skyscanner (1 час 45 мин)</a>

🇹🇭 <b>ТАИЛАНД ИЗ ГУАНЧЖОУ (15–22 января):</b>
• <b>Гуанчжоу ➔ Бангкок:</b> <a href="https://www.skyscanner.net/transport/flights/can/bkk/270116/?adultsv2=2&cabinclass=economy&preferdirects=true">Открыть в Skyscanner (2.5 часа)</a>
• <b>Гуанчжоу ➔ Пхукет:</b> <a href="https://www.skyscanner.net/transport/flights/can/hkt/270116/?adultsv2=2&cabinclass=economy&preferdirects=true">Открыть в Skyscanner (3 часа)</a>
      `.trim();

      const inlineKeyboard = [
        [
          { text: "🇻🇳 Дананг (Skyscanner, 2ч)", url: "https://www.skyscanner.net/transport/flights/can/dad/270116/?adultsv2=2&cabinclass=economy&preferdirects=true" },
          { text: "🇹🇭 Бангкок (Skyscanner, 2.5ч)", url: "https://www.skyscanner.net/transport/flights/can/bkk/270116/?adultsv2=2&cabinclass=economy&preferdirects=true" }
        ],
        [
          { text: "🇻🇳 Ханой (Skyscanner)", url: "https://www.skyscanner.net/transport/flights/can/han/270116/?adultsv2=2&cabinclass=economy&preferdirects=true" },
          { text: "🇹🇭 Пхукет (Skyscanner)", url: "https://www.skyscanner.net/transport/flights/can/hkt/270116/?adultsv2=2&cabinclass=economy&preferdirects=true" }
        ]
      ];

      await this.sendAlert(skyText, inlineKeyboard);
      return;
    }

    if (command === "/daily" || lowerText.includes("сводка")) {
      if (this.handlers?.onGetDailySummary) {
        const dailyText = await this.handlers.onGetDailySummary();
        await this.reply(chatId, dailyText);
      }
      return;
    }

    if (command === "/status" || lowerText.includes("статус системы")) {
      if (this.handlers?.onGetStatus) {
        const statusText = await this.handlers.onGetStatus();
        await this.reply(chatId, statusText);
      }
      return;
    }

    await this.reply(chatId, "Выберите действие с помощью кнопок меню внизу или используйте команды /search, /top, /status, /clear.");
  }

  private async reply(chatId: string, html: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: false,
          reply_markup: {
            keyboard: [
              [{ text: "🔍 Найти билеты сейчас" }, { text: "🏆 ТОП билетов" }],
              [{ text: "🌐 Google Flights и Отели" }, { text: "✈️ Skyscanner (Азия)" }],
              [{ text: "📊 Статус системы" }, { text: "🧹 Очистить систему" }]
            ],
            resize_keyboard: true,
            is_persistent: true
          }
        })
      });
      const data: any = await res.json();
      if (data.ok && data.result?.message_id) {
        this.sentMessageIds.add(data.result.message_id);
      }
    } catch (e: any) {
      console.error(`[Telegram] Failed to reply: ${e.message}`);
    }
  }
}
