/**
 * 房間大廳與生命週期狀態機管理員 (Room Manager)
 * 負責房間建立、加入、房主轉移、生命週期狀態機、整合 M2/M3/M4 核心引擎與全房即時狀態廣播
 * 依據 PROJECT.md 與 financial_models.md 規格定義
 */

import { MarketEngine } from './marketEngine.js';
import { NewsEngine } from './newsEngine.js';
import { TradingEngine } from './tradingEngine.js';
import { STOCKS_CONFIG } from '../config/stocks.js';
import { NEWS_CATALOG } from '../config/newsCatalog.js';

export const ROOM_STATUS = {
  WAITING: 'WAITING',   // 等待玩家加入
  PLAYING: 'PLAYING',   // 比賽進行中
  SETTLING: 'SETTLING', // 時間截止結算中
  FINISHED: 'FINISHED'  // 比賽結束
};

const DEFAULT_ROUNDS = 10;
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 50;
const DEFAULT_ROUND_SECONDS = 30;

export class RoomManager {
  constructor() {
    /** @type {Map<string, Object>} roomCode -> Room */
    this.rooms = new Map();
    /** 標記核心引擎已內建掛載 (供測試與系統感知) */
    this._enginesAttached = true;
    /** 全域/外掛事件回調註冊 (供進階外掛或自訂測試擴充) */
    this.onRoomTick = null;        // (room) => void
    this.onGameStart = null;       // (room) => void
    this.onGameOver = null;        // (room) => object (rankings/winner)
    this.onOrderReceived = null;   // (room, player, payload) => void
  }

  /**
   * 產生隨機 6 碼大寫英數字房間代碼 (排除易混淆字元 0, O, 1, I)
   * @returns {string} 6 碼唯一房間代碼
   */
  generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    let attempts = 0;
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      attempts++;
    } while (this.rooms.has(code) && attempts < 100);

    return code;
  }

  /**
   * 安全傳送 JSON 訊息至指定 WebSocket
   * @param {WebSocket} ws 
   * @param {Object} message 
   */
  sendTo(ws, message) {
    if (ws && ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        console.error('[RoomManager] 傳送訊息失敗:', err);
      }
    }
  }

  /**
   * 廣播訊息至指定房間內所有連線中的玩家
   * @param {string} roomCode 
   * @param {Object} message 
   */
  broadcastToRoom(roomCode, message) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const payloadStr = JSON.stringify(message);
    for (const player of room.players.values()) {
      if (player.ws && player.ws.readyState === 1 /* OPEN */) {
        try {
          player.ws.send(payloadStr);
        } catch (err) {
          console.error(`[RoomManager] 廣播至玩家 ${player.id} 失敗:`, err);
        }
      }
    }
  }

  /**
   * 建立新房間，並初始化專屬市場引擎、新聞排程引擎與交易結算引擎
   * @param {WebSocket} ws 
   * @param {Object} payload { hostName, totalRounds, initialCash, playerId }
   * @returns {Object} 建立之房間資訊
   */
  createRoom(ws, payload = {}) {
    const playerId = payload.playerId || ws.playerId || `p_${Math.random().toString(36).slice(2, 9)}`;
    const hostName = (payload.hostName || '玩家').trim().slice(0, 16) || '玩家';
    
    // 回合數限制 1 ~ 50 輪。durationSeconds 僅作舊版客戶端的相容輸入。
    let totalRounds = parseInt(payload.totalRounds ?? payload.rounds, 10);
    if (!Number.isInteger(totalRounds) || totalRounds < MIN_ROUNDS || totalRounds > MAX_ROUNDS) {
      totalRounds = DEFAULT_ROUNDS;
    }
    let roundDurationSeconds = parseInt(payload.roundDurationSeconds, 10);
    if (!Number.isInteger(roundDurationSeconds) || roundDurationSeconds < 10 || roundDurationSeconds > 300) {
      roundDurationSeconds = DEFAULT_ROUND_SECONDS;
    }

    // 初始資金預設 $1,000,000
    const initialCash = Number(payload.initialCash) > 0 ? Number(payload.initialCash) : 1000000;

    const roomCode = this.generateRoomCode();
    
    const hostPlayer = {
      id: playerId,
      name: hostName,
      isHost: true,
      connected: true,
      ws: ws,
      cash: initialCash,
      initialCash: initialCash,
      netWorth: initialCash,
      frozenMargin: 0,
      pnl: 0,
      pnlPercent: 0,
      joinedAt: Date.now(),
      positions: {} // symbol -> { longShares, avgCost, shortShares, shortAvgPrice, frozenMargin }
    };

    // 實例化獨立之核心引擎
    const marketEngine = new MarketEngine(STOCKS_CONFIG);
    const newsEngine = new NewsEngine(NEWS_CATALOG, marketEngine);
    const tradingEngine = new TradingEngine();

    const room = {
      roomCode,
      status: ROOM_STATUS.WAITING,
      hostId: playerId,
      totalRounds,
      roundDurationSeconds,
      remainingTurnSeconds: roundDurationSeconds,
      currentRound: 0,
      remainingRounds: totalRounds,
      // 舊版欄位保留，值代表輪數而非秒數。
      durationSeconds: totalRounds,
      remainingSeconds: totalRounds,
      initialCash,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      timer: null,
      maxPlayers: 8,
      players: new Map([[playerId, hostPlayer]]),
      // 核心引擎掛載
      marketEngine,
      newsEngine,
      tradingEngine,
      marketState: marketEngine.getStocksState(),
      newsHistory: []
    };

    this.rooms.set(roomCode, room);

    // 綁定連線內容
    ws.roomId = roomCode;
    ws.playerId = playerId;

    // 回應建立者房間狀態
    this.sendRoomState(room, ws);

    console.log(`[RoomManager] 房間建立成功: ${roomCode} | 房主: ${hostName} (${playerId}) | 共 ${totalRounds} 輪`);
    return room;
  }

  /**
   * 加入已存在之房間
   * @param {WebSocket} ws 
   * @param {Object} payload { roomCode, playerName, playerId }
   */
  joinRoom(ws, payload = {}) {
    const rawCode = (payload.roomCode || '').trim().toUpperCase();
    const room = this.rooms.get(rawCode);

    if (!room) {
      this.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'ROOM_NOT_FOUND', message: `找不到房間代碼: ${rawCode}` }
      });
      return null;
    }

    if (room.status !== ROOM_STATUS.WAITING) {
      this.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'GAME_ALREADY_STARTED', message: '該房間比賽已在進行或已結束，無法加入' }
      });
      return null;
    }

    if (room.players.size >= room.maxPlayers) {
      this.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'ROOM_FULL', message: `該房間人數已達上限 (${room.maxPlayers}人)` }
      });
      return null;
    }

    const playerId = payload.playerId || ws.playerId || `p_${Math.random().toString(36).slice(2, 9)}`;
    let playerName = (payload.playerName || '挑戰者').trim().slice(0, 16) || '挑戰者';

    // 檢查是否有同名，有則自動加上後綴
    let nameConflictCount = 0;
    for (const p of room.players.values()) {
      if (p.name.startsWith(playerName)) {
        nameConflictCount++;
      }
    }
    if (nameConflictCount > 0) {
      playerName = `${playerName}_${nameConflictCount + 1}`;
    }

    const newPlayer = {
      id: playerId,
      name: playerName,
      isHost: false,
      connected: true,
      ws: ws,
      cash: room.initialCash,
      initialCash: room.initialCash,
      netWorth: room.initialCash,
      frozenMargin: 0,
      pnl: 0,
      pnlPercent: 0,
      joinedAt: Date.now(),
      positions: {}
    };

    room.players.set(playerId, newPlayer);
    ws.roomId = rawCode;
    ws.playerId = playerId;

    console.log(`[RoomManager] 玩家 ${playerName} (${playerId}) 成功加入房間 ${rawCode}`);

    // 全房廣播最新房間狀態
    this.broadcastRoomState(room);
    return room;
  }

  /**
   * 房主啟動比賽
   * @param {WebSocket} ws 
   * @param {Object} payload { roomCode }
   */
  startGame(ws, payload = {}) {
    const roomCode = payload.roomCode || ws.roomId;
    const room = this.rooms.get(roomCode);

    if (!room) {
      this.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'ROOM_NOT_FOUND', message: '找不到房間' }
      });
      return;
    }

    if (room.hostId !== ws.playerId) {
      this.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'NOT_HOST', message: '只有房主可以開始遊戲' }
      });
      return;
    }

    if (room.status !== ROOM_STATUS.WAITING) {
      this.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'INVALID_STATUS', message: '遊戲狀態非等待中，無法開始' }
      });
      return;
    }

    room.status = ROOM_STATUS.PLAYING;
    room.startedAt = Date.now();
    room.currentRound = 1;
    room.remainingRounds = room.totalRounds;
    room.remainingTurnSeconds = room.roundDurationSeconds;
    room.remainingSeconds = room.remainingTurnSeconds;

    // 初始化突發新聞事件時間排程
    if (room.newsEngine) {
      if (typeof room.newsEngine.scheduleRounds === 'function') {
        room.newsEngine.scheduleRounds(room.totalRounds);
      } else {
        room.newsEngine.scheduleEvents(room.totalRounds);
      }
    }

    console.log(`[RoomManager] 房間 ${roomCode} 回合制比賽開始！共 ${room.totalRounds} 輪`);

    // 支援外部擴充回調
    if (typeof this.onGameStart === 'function') {
      this.onGameStart(room);
    }

    // 立即推播開始狀態
    this.broadcastRoomState(room);

    // 廣播初始行情 MARKET_TICK
    this.broadcastToRoom(room.roomCode, {
      type: 'MARKET_TICK',
      payload: {
        timestamp: Date.now(),
        remainingSeconds: room.remainingSeconds,
        stocks: room.marketState
      }
    });

    this.broadcastRoundState(room, 'TRADING');
    room.timer = setInterval(() => this.handleTick(room), 1000);
  }

  /**
   * 同步交易回合沒有個人行動權；保留此入口作為查詢/準備回覆。
   */
  endTurn(ws, payload = {}) {
    const room = this.rooms.get(payload.roomCode || ws.roomId);
    if (!room || room.status !== ROOM_STATUS.PLAYING) {
      this.sendTo(ws, { type: 'ERROR', payload: { code: 'MARKET_CLOSED', message: '目前沒有進行中的回合' } });
      return false;
    }
    this.sendTo(ws, { type: 'TURN_ACK', payload: { success: true, action: 'READY', message: '本回合仍可繼續自由交易，將在倒數結束後統一揭曉' } });
    return true;
  }

  /** 倒數結束後揭曉市場、新聞、資產與排行榜。 */
  completeRound(room) {
    if (room.marketEngine) {
      room.marketEngine.tick();
      room.marketState = room.marketEngine.getStocksState();
    }

    room.remainingRounds = Math.max(0, room.totalRounds - room.currentRound);
    room.remainingSeconds = 0;

    if (room.newsEngine) {
      room.suppressNewsMarketBroadcast = true;
      if (typeof room.newsEngine.onRound === 'function') room.newsEngine.onRound(room, this);
      else room.newsEngine.onTick(room, this);
      room.suppressNewsMarketBroadcast = false;
    }

    this.updateAccountsAndBroadcast(room);
    this.broadcastRoundState(room, 'REVEAL');

    if (room.currentRound >= room.totalRounds) {
      this.endGame(room);
      return;
    }
    room.currentRound += 1;
    room.remainingTurnSeconds = room.roundDurationSeconds;
    room.remainingSeconds = room.remainingTurnSeconds;
    this.broadcastRoomState(room);
    this.broadcastRoundState(room, 'TRADING');
  }

  updateAccountsAndBroadcast(room) {
    const prices = room.marketEngine ? room.marketEngine.getPrices() : room.marketState;
    const rankings = [];
    for (const player of room.players.values()) {
      room.tradingEngine?.updatePlayerFinancials(player, prices);
      this.sendTo(player.ws, {
        type: 'ACCOUNT_UPDATE',
        payload: { cash: player.cash, netWorth: player.netWorth, frozenMargin: player.frozenMargin || 0, pnl: player.pnl, pnlPercent: player.pnlPercent, positions: player.positions }
      });
      rankings.push({ playerId: player.id, playerName: player.name, netWorth: player.netWorth, pnlPercent: player.pnlPercent });
    }
    rankings.sort((a, b) => b.netWorth - a.netWorth).forEach((p, i) => { p.rank = i + 1; });
    this.broadcastToRoom(room.roomCode, { type: 'MARKET_TICK', payload: { timestamp: Date.now(), remainingRounds: room.remainingRounds, currentRound: room.currentRound, stocks: room.marketState } });
    this.broadcastToRoom(room.roomCode, { type: 'LEADERBOARD', payload: { rankings } });
  }

  broadcastRoundState(room, phase) {
    this.broadcastToRoom(room.roomCode, {
      type: 'TURN_STATE',
      payload: {
        phase,
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
        remainingRounds: room.remainingRounds,
        remainingTurnSeconds: room.remainingTurnSeconds,
        message: phase === 'REVEAL' ? `第 ${room.currentRound} 輪結果揭曉` : `第 ${room.currentRound} 輪自由交易中`
      }
    });
  }

  /** 每秒只更新回合倒數；價格與排名僅在回合結束時公開。 */
  handleTick(room) {
    if (room.status !== ROOM_STATUS.PLAYING) return;

    room.remainingTurnSeconds = Math.max(0, room.remainingTurnSeconds - 1);
    room.remainingSeconds = room.remainingTurnSeconds;
    if (typeof this.onRoomTick === 'function') {
      try {
        this.onRoomTick(room);
      } catch (err) {
        console.error(`[RoomManager] onRoomTick 錯誤 (房間 ${room.roomCode}):`, err);
      }
    }

    if (room.remainingTurnSeconds <= 0) {
      this.completeRound(room);
      return;
    }

    // 只同步倒數，不洩漏本輪盤中價格或排名。
    if (room.remainingTurnSeconds % 5 === 0 || room.remainingTurnSeconds <= 5) {
      this.broadcastRoomState(room);
    }
  }

  /**
   * 比賽結束與強制平倉結算
   * @param {Object} room 
   */
  endGame(room) {
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }

    room.status = ROOM_STATUS.SETTLING;
    room.endedAt = Date.now();
    room.remainingSeconds = 0;

    console.log(`[RoomManager] 房間 ${room.roomCode} 時間截止，開始進行強制結算...`);

    let finalRankings = [];
    let winner = null;

    // 若有自訂外部結算 hook
    if (typeof this.onGameOver === 'function') {
      try {
        const result = this.onGameOver(room);
        if (result && result.rankings) {
          finalRankings = result.rankings;
          winner = result.winner || (finalRankings[0] ? {
            name: finalRankings[0].playerName,
            netWorth: finalRankings[0].netWorth,
            returnRate: finalRankings[0].returnRate || finalRankings[0].pnlPercent
          } : null);
        }
      } catch (err) {
        console.error(`[RoomManager] onGameOver 結算失敗:`, err);
      }
    } else if (room.tradingEngine) {
      // 原生交易引擎公允市價強制平倉
      const prices = room.marketEngine ? room.marketEngine.getPrices() : room.marketState;
      const result = room.tradingEngine.forceLiquidateAll(room, prices);
      finalRankings = result.rankings;
      winner = result.winner;
    }

    // 保底結算
    if (finalRankings.length === 0) {
      const playersList = Array.from(room.players.values()).map(p => {
        const initial = p.initialCash || 1000000;
        const current = p.netWorth || p.cash || initial;
        const pnl = current - initial;
        const returnRate = Number(((pnl / initial) * 100).toFixed(2));
        return {
          playerId: p.id,
          playerName: p.name,
          finalCash: p.cash,
          netWorth: current,
          pnl,
          returnRate,
          pnlPercent: returnRate
        };
      });

      playersList.sort((a, b) => b.netWorth - a.netWorth);
      finalRankings = playersList.map((p, idx) => ({
        rank: idx + 1,
        ...p
      }));

      if (finalRankings.length > 0) {
        winner = {
          name: finalRankings[0].playerName,
          netWorth: finalRankings[0].netWorth,
          returnRate: finalRankings[0].returnRate
        };
      }
    }

    room.status = ROOM_STATUS.FINISHED;

    // 廣播結算資訊 GAME_OVER
    this.broadcastToRoom(room.roomCode, {
      type: 'GAME_OVER',
      payload: {
        roomCode: room.roomCode,
        rankings: finalRankings,
        winner: winner
      }
    });

    // 廣播更新後的 ROOM_STATE
    this.broadcastRoomState(room);
    console.log(`[RoomManager] 房間 ${room.roomCode} 結算完成，冠軍:`, winner);
  }

  /**
   * 處理玩家委託下單 (路由至交易引擎執行原子衝擊與會計更新)
   * @param {WebSocket} ws 
   * @param {Object} payload { roomCode, stockSymbol, side, shares }
   */
  handleOrder(ws, payload = {}) {
    const roomCode = payload.roomCode || ws.roomId;
    const room = this.rooms.get(roomCode);

    if (!room) {
      this.sendTo(ws, {
        type: 'ORDER_ACK',
        payload: { success: false, code: 'ROOM_NOT_FOUND', message: '找不到房間' }
      });
      return;
    }

    if (room.status !== ROOM_STATUS.PLAYING) {
      this.sendTo(ws, {
        type: 'ORDER_ACK',
        payload: { success: false, code: 'MARKET_CLOSED', message: '目前非比賽進行狀態，無法下單' }
      });
      return;
    }

    const player = room.players.get(ws.playerId);
    if (!player) {
      this.sendTo(ws, {
        type: 'ORDER_ACK',
        payload: { success: false, code: 'PLAYER_NOT_FOUND', message: '玩家未在該房間註冊' }
      });
      return;
    }

    // 若有外部擴充 hook
    if (typeof this.onOrderReceived === 'function') {
      this.onOrderReceived(room, player, payload);
      return;
    }

    // 原生交易引擎處理
    if (room.tradingEngine) {
      const result = room.tradingEngine.processOrder(room, player, payload);

      if (result.success) {
        // 成交明細與自己的帳戶私下回覆；全房行情留到回合結束才揭曉。
        this.sendTo(player.ws, {
          type: 'ACCOUNT_UPDATE',
          payload: {
            cash: player.cash,
            netWorth: player.netWorth,
            frozenMargin: player.frozenMargin || 0,
            pnl: player.pnl,
            pnlPercent: player.pnlPercent,
            positions: player.positions
          }
        });

        this.sendTo(player.ws, {
          type: 'ORDER_ACK',
          payload: result
        });
      } else {
        // 下單檢核失敗，回覆錯誤原因
        this.sendTo(player.ws, {
          type: 'ORDER_ACK',
          payload: result
        });
      }
    } else {
      this.sendTo(ws, {
        type: 'ORDER_ACK',
        payload: {
          success: false,
          code: 'ENGINE_INITIALIZING',
          message: '撮合交易引擎初始化中，請稍候'
        }
      });
    }
  }

  /**
   * 處理玩家連線中斷或離開
   * @param {WebSocket} ws 
   */
  handleDisconnect(ws) {
    const roomCode = ws.roomId;
    const playerId = ws.playerId;

    if (!roomCode || !this.rooms.has(roomCode)) return;

    const room = this.rooms.get(roomCode);
    const player = room.players.get(playerId);
    if (!player) return;

    player.connected = false;
    player.ws = null;

    console.log(`[RoomManager] 玩家 ${player.name} (${playerId}) 斷開連線 (房間: ${roomCode})`);

    // 檢查全房是否已無任何連線中玩家
    const anyConnected = Array.from(room.players.values()).some(p => p.connected);
    if (!anyConnected) {
      if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
      }
      this.rooms.delete(roomCode);
      console.log(`[RoomManager] 房間 ${roomCode} 全員離線，已立即清理計時器並銷毀房間`);
      return;
    }

    // 若處於 WAITING 階段且房主離開，將房主轉移給下一位在線玩家
    if (room.status === ROOM_STATUS.WAITING && room.hostId === playerId) {
      const nextHost = Array.from(room.players.values()).find(p => p.connected);
      if (nextHost) {
        nextHost.isHost = true;
        room.hostId = nextHost.id;
        console.log(`[RoomManager] 房主轉移: ${nextHost.name} (${nextHost.id}) 成為新房主`);
      }
    }

    // 廣播更新後之房間狀態
    this.broadcastRoomState(room);
  }

  /**
   * 序列化房間狀態物件
   * @param {Object} room 
   * @returns {Object}
   */
  serializeRoomState(room) {
    const playersList = Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      connected: p.connected,
      netWorth: p.netWorth || p.cash,
      pnlPercent: p.pnlPercent || 0
    }));

    return {
      roomCode: room.roomCode,
      status: room.status,
      hostId: room.hostId,
      durationSeconds: room.durationSeconds,
      remainingSeconds: room.remainingSeconds,
      totalRounds: room.totalRounds,
      roundDurationSeconds: room.roundDurationSeconds,
      currentRound: room.currentRound,
      remainingRounds: room.remainingRounds,
      remainingTurnSeconds: room.remainingTurnSeconds,
      phase: room.status === ROOM_STATUS.PLAYING ? 'TRADING' : room.status,
      initialCash: room.initialCash,
      players: playersList,
      playerCount: playersList.length,
      maxPlayers: room.maxPlayers
    };
  }

  /**
   * 向指定連線發送房間狀態
   * @param {Object} room 
   * @param {WebSocket} ws 
   */
  sendRoomState(room, ws) {
    this.sendTo(ws, {
      type: 'ROOM_STATE',
      payload: this.serializeRoomState(room)
    });
  }

  /**
   * 全房廣播房間狀態
   * @param {Object} room 
   */
  broadcastRoomState(room) {
    this.broadcastToRoom(room.roomCode, {
      type: 'ROOM_STATE',
      payload: this.serializeRoomState(room)
    });
  }

  /**
   * 取得指定房間實例
   * @param {string} roomCode 
   * @returns {Object|null}
   */
  getRoom(roomCode) {
    return this.rooms.get(roomCode) || null;
  }
}
