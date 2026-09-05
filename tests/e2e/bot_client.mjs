/**
 * StockBotClient: 虛擬股票交易機器人客戶端封裝
 * 基於 Node 24 原生 globalThis.WebSocket 實作
 * 支援房間大廳、雙向多空交易、行情監聽、新聞快訊、資產追蹤與結算事件
 */

export class StockBotClient {
  /**
   * @param {Object} options
   * @param {string} [options.name='Bot'] 機器人名稱
   * @param {boolean} [options.debug=false] 是否輸出除錯記錄
   */
  constructor(options = {}) {
    this.name = options.name || 'Bot';
    this.debug = Boolean(options.debug);

    this.ws = null;
    this.url = null;
    this.connected = false;

    // 帳戶與房間資訊
    this.playerId = null;
    this.roomCode = null;
    this.isHost = false;

    // 狀態快照
    this.roomState = null;
    this.marketState = null;
    this.accountState = null;
    this.leaderboard = null;
    this.gameOverData = null;

    // 事件收集器
    this.newsList = [];
    this.orderAcks = [];
    this.errors = [];
    this.ticks = [];
    this.eventsHistory = [];

    // 事件監聽回調 (type -> Set<Function>)
    this._listeners = new Map();

    // 等待 Promise 隊列: { type, predicate, resolve, reject, timeoutId }
    this._waiters = [];
  }

  log(...args) {
    if (this.debug) {
      console.log(`[BotClient:${this.name}]`, ...args);
    }
  }

  /**
   * 連線至伺服器
   * @param {string} url 伺服器 WebSocket 網址 (ws://localhost:PORT)
   * @param {number} [timeoutMs=5000] 連線逾時毫秒
   * @returns {Promise<void>}
   */
  connect(url, timeoutMs = 5000) {
    this.url = url;
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (this.ws) {
            try { this.ws.close(); } catch (_) {}
          }
          reject(new Error(`[BotClient:${this.name}] 連線逾時 (${timeoutMs}ms): ${url}`));
        }
      }, timeoutMs);

      try {
        // 使用 Node 24 原生 globalThis.WebSocket
        const WSClass = globalThis.WebSocket;
        if (!WSClass) {
          throw new Error('當前 Node 環境缺少原生 globalThis.WebSocket 支援');
        }

        this.ws = new WSClass(url);

        this.ws.onopen = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          this.connected = true;
          this.log('WebSocket 連線建立成功');
          resolve();
        };

        this.ws.onmessage = (event) => {
          this._handleMessage(event.data);
        };

        this.ws.onerror = (err) => {
          this.log('WebSocket 錯誤:', err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(err);
          }
        };

        this.ws.onclose = (event) => {
          this.connected = false;
          this.log(`WebSocket 連線已關閉 (code: ${event.code}, reason: ${event.reason})`);
          this._rejectAllWaiters(new Error(`WebSocket 連線關閉: code ${event.code}`));
        };
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * 關閉連線並釋放資源
   */
  async disconnect() {
    this._rejectAllWaiters(new Error('客戶端主動中斷連線'));
    if (this.ws) {
      if (this.ws.readyState === 1 /* OPEN */ || this.ws.readyState === 0 /* CONNECTING */) {
        return new Promise((resolve) => {
          this.ws.onclose = () => {
            this.connected = false;
            resolve();
          };
          try {
            this.ws.close();
          } catch (_) {
            this.connected = false;
            resolve();
          }
        });
      }
      this.connected = false;
    }
  }

  /**
   * 發送 JSON 訊息至伺服器
   * @param {string} type 訊息類型
   * @param {Object} [payload={}] 承載資料
   * @param {string} [requestId] 選擇性請求 ID
   */
  send(type, payload = {}, requestId = undefined) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error(`[BotClient:${this.name}] 連線尚未就緒，無法發送訊息: ${type}`);
    }
    const message = { type, payload };
    if (requestId) message.requestId = requestId;
    this.ws.send(JSON.stringify(message));
    this.log(`發送 -> ${type}`, payload);
  }

  /**
   * 內部訊息解析與事件分發
   * @param {string|Buffer} rawData 
   */
  _handleMessage(rawData) {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch (err) {
      this.log('無法解析之訊息格式:', rawData);
      return;
    }

    const { type, payload } = message;
    this.log(`接收 <- ${type}`, payload);
    this.eventsHistory.push({ type, payload, timestamp: Date.now() });

    // 更新內部狀態
    switch (type) {
      case 'ROOM_STATE':
        this.roomState = payload;
        this.roomCode = payload.roomCode;
        if (payload.hostId && this.playerId) {
          this.isHost = payload.hostId === this.playerId;
        }
        break;

      case 'MARKET_TICK':
        this.marketState = payload;
        this.ticks.push(payload);
        break;

      case 'ACCOUNT_UPDATE':
        this.accountState = payload;
        break;

      case 'ORDER_ACK':
        this.orderAcks.push(payload);
        break;

      case 'NEWS_FLASH':
        this.newsList.push(payload);
        break;

      case 'LEADERBOARD':
        this.leaderboard = payload.rankings || payload;
        break;

      case 'GAME_OVER':
        this.gameOverData = payload;
        break;

      case 'ERROR':
        this.errors.push(payload);
        break;
    }

    // 觸發自訂監聽器
    this._emit(type, payload, message);

    // 檢核等待隊列
    this._checkWaiters(type, payload, message);
  }

  /**
   * 註冊自訂事件監聽器
   * @param {string} type 
   * @param {Function} callback 
   */
  on(type, callback) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(callback);
    return () => this.off(type, callback);
  }

  /**
   * 移除事件監聽器
   * @param {string} type 
   * @param {Function} callback 
   */
  off(type, callback) {
    if (this._listeners.has(type)) {
      this._listeners.get(type).delete(callback);
    }
  }

  _emit(type, payload, message) {
    if (this._listeners.has(type)) {
      for (const cb of this._listeners.get(type)) {
        try {
          cb(payload, message);
        } catch (e) {
          console.error(`[BotClient:${this.name}] 監聽回調異常:`, e);
        }
      }
    }
  }

  /**
   * 等待指定事件滿足條件
   * @param {string} type 訊息類型
   * @param {number} [timeoutMs=5000] 逾時毫秒數
   * @param {Function} [predicate=null] 判斷函式 (payload, message) => boolean
   * @returns {Promise<Object>} 回傳 payload
   */
  waitForEvent(type, timeoutMs = 5000, predicate = null) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // 從等待隊列中移除
        this._waiters = this._waiters.filter((w) => w.timeoutId !== timeoutId);
        reject(new Error(`[BotClient:${this.name}] 等待事件逾時 (${timeoutMs}ms): ${type}`));
      }, timeoutMs);

      this._waiters.push({
        type,
        predicate,
        resolve,
        reject,
        timeoutId
      });
    });
  }

  _checkWaiters(type, payload, message) {
    const remaining = [];
    for (const waiter of this._waiters) {
      if (waiter.type === type) {
        let match = true;
        if (typeof waiter.predicate === 'function') {
          try {
            match = Boolean(waiter.predicate(payload, message));
          } catch (e) {
            match = false;
          }
        }
        if (match) {
          clearTimeout(waiter.timeoutId);
          waiter.resolve(payload);
          continue;
        }
      }
      remaining.push(waiter);
    }
    this._waiters = remaining;
  }

  _rejectAllWaiters(error) {
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    }
    this._waiters = [];
  }

  /**
   * 清除收集的歷史記錄
   */
  clearEvents() {
    this.newsList = [];
    this.orderAcks = [];
    this.errors = [];
    this.ticks = [];
    this.eventsHistory = [];
  }

  // ================= 快捷業務操作封裝 =================

  /**
   * 建立房間
   * @param {Object} payload { hostName, durationSeconds, initialCash }
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object>} 房間狀態 payload
   */
  async createRoom({ hostName, durationSeconds = 300, initialCash = 1000000 } = {}, timeoutMs = 5000) {
    const p = this.waitForEvent('ROOM_STATE', timeoutMs, (state) => state.status === 'WAITING');
    this.send('CREATE_ROOM', {
      hostName: hostName || this.name,
      durationSeconds,
      initialCash
    });
    const state = await p;
    this.roomCode = state.roomCode;
    this.isHost = true;
    if (state.players && state.players.length > 0) {
      const me = state.players.find(pl => pl.name === (hostName || this.name));
      if (me) this.playerId = me.id;
    }
    return state;
  }

  /**
   * 加入房間
   * @param {string} roomCode 
   * @param {string} [playerName] 
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object>} 房間狀態 payload
   */
  async joinRoom(roomCode, playerName = null, timeoutMs = 5000) {
    const name = playerName || this.name;
    const p = this.waitForEvent('ROOM_STATE', timeoutMs, (state) => {
      return state.roomCode === roomCode && Array.isArray(state.players) && state.players.some(pl => pl.name.startsWith(name));
    });
    this.send('JOIN_ROOM', {
      roomCode,
      playerName: name
    });
    const state = await p;
    this.roomCode = roomCode;
    const me = state.players.find(pl => pl.name.startsWith(name));
    if (me) {
      this.playerId = me.id;
      this.isHost = Boolean(me.isHost);
    }
    return state;
  }

  /**
   * 開始遊戲 (僅限房主)
   * @param {string} [roomCode]
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object>}
   */
  async startGame(roomCode = null, timeoutMs = 5000) {
    const targetRoom = roomCode || this.roomCode;
    const p = this.waitForEvent('ROOM_STATE', timeoutMs, (state) => state.status === 'PLAYING');
    this.send('START_GAME', { roomCode: targetRoom });
    return await p;
  }

  /**
   * 雙向多空委託下單
   * @param {Object} options
   * @param {string} [options.roomCode]
   * @param {string} options.stockSymbol 標的代碼 (MEGA, NVTX, SOLR, MEME)
   * @param {"BUY"|"SELL"|"SHORT"|"COVER"} options.side 交易方向
   * @param {number} options.shares 下單股數
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object>} 委託回報 ORDER_ACK payload
   */
  async placeOrder({ roomCode, stockSymbol, side, shares }, timeoutMs = 5000) {
    const code = roomCode || this.roomCode;
    const p = this.waitForEvent('ORDER_ACK', timeoutMs);
    this.send('PLACE_ORDER', {
      roomCode: code,
      stockSymbol,
      side,
      shares
    });
    return await p;
  }

  /**
   * 發送心跳 Ping
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object>}
   */
  async ping(timeoutMs = 5000) {
    const p = this.waitForEvent('PONG', timeoutMs);
    this.send('PING', { timestamp: Date.now() });
    return await p;
  }

  /**
   * 等待收到至少指定數量的行情 Tick
   * @param {number} [minTicks=1] 
   * @param {number} [timeoutMs=5000] 
   * @returns {Promise<Array<Object>>}
   */
  async waitForMarketTicks(minTicks = 1, timeoutMs = 5000) {
    if (this.ticks.length >= minTicks) {
      return this.ticks.slice(-minTicks);
    }
    const targetCount = this.ticks.length + minTicks;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('MARKET_TICK', onTick);
        reject(new Error(`[BotClient:${this.name}] 等待 ${minTicks} 次行情 Tick 逾時 (${timeoutMs}ms)`));
      }, timeoutMs);

      const onTick = () => {
        if (this.ticks.length >= targetCount) {
          clearTimeout(timer);
          this.off('MARKET_TICK', onTick);
          resolve(this.ticks.slice(-minTicks));
        }
      };

      this.on('MARKET_TICK', onTick);
    });
  }

  /**
   * 等待遊戲結算 GAME_OVER
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<Object>}
   */
  async waitForGameOver(timeoutMs = 15000) {
    if (this.gameOverData) return this.gameOverData;
    return await this.waitForEvent('GAME_OVER', timeoutMs);
  }
}
