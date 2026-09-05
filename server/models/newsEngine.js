/**
 * 突發新聞事件與市場衝擊排程引擎 (News Engine - M3)
 * 管理新聞事件排程、冷卻、瞬時價格幾何跳空與指數衰減動能漂移注入
 * 依據 financial_models.md §5 與 PROJECT.md §3 規格定義
 */

import { NEWS_CATALOG } from '../config/newsCatalog.js';

export class NewsEngine {
  /**
   * @param {Array<Object>} [customCatalog] 自訂新聞事件庫
   * @param {Object} [marketEngine] 關聯的市場引擎實例
   */
  constructor(customCatalog = null, marketEngine = null) {
    this.catalog = customCatalog || NEWS_CATALOG;
    this.marketEngine = marketEngine;
    /** @type {Set<string>} 已觸發過的新聞 ID 集合 */
    this.triggeredEventIds = new Set();
    /** 下一次自動觸發的目標秒數 (倒數計時值) */
    this.scheduledTickTimes = [];
  }

  /**
   * 綁定關聯之市場引擎
   * @param {Object} marketEngine 
   */
  setMarketEngine(marketEngine) {
    this.marketEngine = marketEngine;
  }

  /**
   * 依據比賽總時長預先規劃事件排程點 (避開開盤前 10 秒與封盤前 10 秒)
   * @param {number} durationSeconds 比賽總時長
   */
  scheduleEvents(durationSeconds) {
    this.scheduledTickTimes = [];
    this.triggeredEventIds.clear();

    if (durationSeconds < 25) return;

    // 計算可安排事件次數 (30s 局 1 次, 60s 局 2 次, 180s 局 3~4 次, 300s 局 4~5 次)
    const count = Math.max(1, Math.min(5, Math.floor(durationSeconds / 45) + 1));
    const startWindow = durationSeconds - 10;
    const endWindow = 10;
    const span = (startWindow - endWindow) / (count + 1);

    for (let i = 1; i <= count; i++) {
      const scheduledSec = Math.round(startWindow - i * span);
      this.scheduledTickTimes.push(scheduledSec);
    }
  }

  /**
   * 每個 Tick (每秒) 檢查是否到達新聞觸發時刻
   * @param {Object} room 房間物件
   * @param {Object} roomManager 房間管理器 (用於廣播)
   */
  onTick(room, roomManager) {
    if (!room || room.status !== 'PLAYING') return;

    const remaining = room.remainingSeconds;
    const idx = this.scheduledTickTimes.indexOf(remaining);

    if (idx !== -1) {
      // 移除已到達的排程點
      this.scheduledTickTimes.splice(idx, 1);
      this.triggerRandomEvent(room, roomManager);
    }
  }

  /**
   * 隨機抽取一個未觸發的新聞事件並注入市場
   * @param {Object} room 
   * @param {Object} roomManager 
   * @returns {Object|null} 觸發之新聞事件物件
   */
  triggerRandomEvent(room, roomManager) {
    let availableEvents = this.catalog.filter(e => !this.triggeredEventIds.has(e.id));
    if (availableEvents.length === 0) {
      // 若新聞庫已全數觸發完畢，重置已觸發集合
      this.triggeredEventIds.clear();
      availableEvents = this.catalog;
    }

    if (availableEvents.length === 0) return null;

    const selectedEvent = availableEvents[Math.floor(Math.random() * availableEvents.length)];
    this.triggeredEventIds.add(selectedEvent.id);

    return this.dispatchNews(room, roomManager, selectedEvent);
  }

  /**
   * 派發新聞事件至房間與市場引擎
   * @param {Object} room 
   * @param {Object} roomManager 
   * @param {Object} event 
   * @returns {Object}
   */
  dispatchNews(room, roomManager, event) {
    const market = this.marketEngine || room.marketEngine;

    // 1. 將事件衝擊注入市場引擎
    if (market) {
      if (event.scope === 'ALL' && event.stockShocks) {
        // 全市場衝擊：依各股特異性百分比跳空
        for (const [sym, shock] of Object.entries(event.stockShocks)) {
          market.applyNewsShock(sym, shock, event.driftIntensity, event.durationSec);
        }
      } else if (event.scope === 'ALL' && event.affectedSymbols) {
        for (const sym of event.affectedSymbols) {
          market.applyNewsShock(sym, event.shockPercent, event.driftIntensity, event.durationSec);
        }
      } else if (event.affectedSymbol && event.affectedSymbol !== 'ALL') {
        // 單一標的衝擊
        market.applyNewsShock(event.affectedSymbol, event.shockPercent, event.driftIntensity, event.durationSec);
      }
    }

    // 2. 建構符合契約之 NEWS_FLASH 廣播物件
    const newsFlash = {
      id: event.id || `news_${Math.random().toString(36).slice(2, 9)}`,
      title: event.title,
      content: event.content,
      scope: event.scope || (event.affectedSymbol === 'ALL' ? 'ALL' : 'STOCK'),
      affectedSymbol: event.affectedSymbol || (event.affectedSymbols ? event.affectedSymbols[0] : 'ALL'),
      shockPercent: event.shockPercent,
      timestamp: Date.now()
    };

    if (!room.newsHistory) {
      room.newsHistory = [];
    }
    room.newsHistory.push(newsFlash);

    // 3. 廣播推播至全房玩家
    if (roomManager) {
      roomManager.broadcastToRoom(room.roomCode, {
        type: 'NEWS_FLASH',
        payload: newsFlash
      });

      // 同步廣播跳空後最新行情
      const stocksState = market ? market.getStocksState() : room.marketState;
      if (stocksState) {
        room.marketState = stocksState;
        roomManager.broadcastToRoom(room.roomCode, {
          type: 'MARKET_TICK',
          payload: {
            timestamp: Date.now(),
            remainingSeconds: room.remainingSeconds,
            stocks: stocksState
          }
        });
      }
    }

    console.log(`[NewsEngine] 房間 ${room.roomCode} 觸發新聞: ${newsFlash.title} (${newsFlash.affectedSymbol} ${newsFlash.shockPercent}%)`);
    return newsFlash;
  }

  /**
   * 手動/測試腳本注入新聞事件
   * @param {Object} room 
   * @param {Object} roomManager 
   * @param {Object} options { symbol, shockPercent, title, content, driftIntensity, durationSec }
   */
  injectNews(room, roomManager, options = {}) {
    const { symbol, shockPercent, title, content, driftIntensity, durationSec } = options;
    const customEvent = {
      id: `news_${Math.random().toString(36).slice(2, 9)}`,
      title: title || `【突發行情】${symbol} 發生顯著市場跳空！`,
      content: content || `受到市場重大消息影響，${symbol} 發生跳空與流動性波動。`,
      scope: symbol === 'ALL' ? 'ALL' : 'STOCK',
      affectedSymbol: symbol,
      affectedSymbols: symbol === 'ALL' ? ['MEGA', 'NVTX', 'SOLR', 'MEME'] : [symbol],
      shockPercent: shockPercent || 0,
      driftIntensity: driftIntensity || 0,
      durationSec: durationSec || 15
    };

    return this.dispatchNews(room, roomManager, customEvent);
  }
}
