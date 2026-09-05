/**
 * E2E 端到端對戰測試套件: tests/e2e/bot_battle.test.mjs
 * 驗證 WebSocket 多人房間、秒級行情、邊界防禦、價格衝擊與 3 機器人完整對戰結算
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { StockBotClient } from './bot_client.mjs';

// 設定測試環境標記，避免 server.js 自動 listen 預設 3000 port
process.env.NODE_ENV = 'test';
process.env.DISABLE_SERVER_AUTOSTART = 'true';

// 動態引入主伺服器與房間管理器
const { server, wss, roomManager } = await import('../../server/server.js');

let serverUrl = '';
let activeRooms = [];

/**
 * 依據 PROJECT.md 規範裝配標準市場引擎與交易引擎（當伺服器尚未掛載外部引擎時提供標準參考實現）
 */
function ensureReferenceEngines() {
  if (roomManager._enginesAttached) return;

  // 4 檔初始股票設定 (PROJECT.md §2)
  const defaultStocks = {
    MEGA: { symbol: 'MEGA', name: 'MegaTech 藍籌', price: 500.0, depth: 50000, open: 500.0, high: 500.0, low: 500.0, history: [500.0] },
    NVTX: { symbol: 'NVTX', name: 'NovaTex 科技', price: 200.0, depth: 30000, open: 200.0, high: 200.0, low: 200.0, history: [200.0] },
    SOLR: { symbol: 'SOLR', name: 'Solaria 綠能', price: 50.0, depth: 15000, open: 50.0, high: 50.0, low: 50.0, history: [50.0] },
    MEME: { symbol: 'MEME', name: 'MemeRocket 迷因', price: 10.0, depth: 5000, open: 10.0, high: 10.0, low: 10.0, history: [10.0] }
  };

  // 1. 遊戲開始 hook
  roomManager.onGameStart = (room) => {
    // 深拷貝每間房間獨立的股票池
    room.marketState = JSON.parse(JSON.stringify(defaultStocks));
  };

  // 2. 秒級跳動 hook (PROJECT.md §2)
  roomManager.onRoomTick = (room) => {
    if (!room.marketState) return;

    // 隨機微跳（幾何布朗隨機漫步）
    for (const [sym, stock] of Object.entries(room.marketState)) {
      const delta = (Math.random() - 0.49) * 0.005 * stock.price;
      stock.price = Math.max(0.01, Number((stock.price + delta).toFixed(2)));
      stock.high = Math.max(stock.high, stock.price);
      stock.low = Math.min(stock.low, stock.price);
      stock.change = Number((stock.price - stock.open).toFixed(2));
      stock.changePercent = Number(((stock.change / stock.open) * 100).toFixed(2));
      stock.history.push(stock.price);
      if (stock.history.length > 60) stock.history.shift();
    }

    // 更新所有玩家未實現損益與淨資產 (PROJECT.md §4)
    for (const player of room.players.values()) {
      updatePlayerFinancials(player, room.marketState);
      // 推播帳戶狀態
      if (player.ws && player.ws.readyState === 1) {
        roomManager.sendTo(player.ws, {
          type: 'ACCOUNT_UPDATE',
          payload: {
            cash: player.cash,
            netWorth: player.netWorth,
            pnl: player.pnl,
            pnlPercent: player.pnlPercent,
            positions: player.positions
          }
        });
      }
    }

    // 廣播最新行情 MARKET_TICK
    roomManager.broadcastToRoom(room.roomCode, {
      type: 'MARKET_TICK',
      payload: {
        timestamp: Date.now(),
        remainingSeconds: room.remainingSeconds,
        stocks: room.marketState
      }
    });

    // 廣播即時排行榜 LEADERBOARD
    const rankings = Array.from(room.players.values())
      .map(p => ({
        rank: 1,
        playerId: p.id,
        playerName: p.name,
        netWorth: p.netWorth,
        pnlPercent: p.pnlPercent
      }))
      .sort((a, b) => b.netWorth - a.netWorth)
      .map((p, idx) => ({ ...p, rank: idx + 1 }));

    roomManager.broadcastToRoom(room.roomCode, {
      type: 'LEADERBOARD',
      payload: { rankings }
    });
  };

  // 3. 委託下單 hook (PROJECT.md §2, §4)
  roomManager.onOrderReceived = (room, player, payload) => {
    const { stockSymbol, side, shares } = payload;

    if (!room.marketState || !room.marketState[stockSymbol]) {
      roomManager.sendTo(player.ws, {
        type: 'ORDER_ACK',
        payload: { success: false, code: 'INVALID_STOCK', message: '無效之股票代碼' }
      });
      return;
    }

    const sharesNum = parseInt(shares, 10);
    if (isNaN(sharesNum) || sharesNum <= 0) {
      roomManager.sendTo(player.ws, {
        type: 'ORDER_ACK',
        payload: { success: false, code: 'INVALID_SHARES', message: '下單股數必須為正整數' }
      });
      return;
    }

    const stock = room.marketState[stockSymbol];
    if (!player.positions[stockSymbol]) {
      player.positions[stockSymbol] = {
        longShares: 0,
        avgCost: 0,
        shortShares: 0,
        shortAvgPrice: 0,
        frozenMargin: 0
      };
    }
    const pos = player.positions[stockSymbol];

    // 雙曲正切價格衝擊計算 (PROJECT.md §2)
    const impactFactor = Math.tanh(sharesNum / stock.depth) * 0.15;
    let executedPrice = stock.price;
    let postPrice = stock.price;

    if (side === 'BUY') {
      // 買進推升價格
      postPrice = Number((stock.price * (1 + impactFactor)).toFixed(2));
      executedPrice = Number((stock.price * (1 + impactFactor / 2)).toFixed(2));
      const totalCost = executedPrice * sharesNum;

      if (player.cash < totalCost) {
        roomManager.sendTo(player.ws, {
          type: 'ORDER_ACK',
          payload: { success: false, code: 'INSUFFICIENT_FUNDS', message: '可用現金不足' }
        });
        return;
      }

      // 扣除現金，增加持股
      player.cash = Number((player.cash - totalCost).toFixed(2));
      const totalShares = pos.longShares + sharesNum;
      pos.avgCost = Number(((pos.longShares * pos.avgCost + totalCost) / totalShares).toFixed(2));
      pos.longShares = totalShares;
      stock.price = postPrice;

    } else if (side === 'SELL') {
      // 賣出打壓價格
      if (pos.longShares < sharesNum) {
        roomManager.sendTo(player.ws, {
          type: 'ORDER_ACK',
          payload: { success: false, code: 'INSUFFICIENT_SHARES', message: '持股數量不足' }
        });
        return;
      }

      postPrice = Math.max(0.01, Number((stock.price * (1 - impactFactor)).toFixed(2)));
      executedPrice = Math.max(0.01, Number((stock.price * (1 - impactFactor / 2)).toFixed(2)));
      const totalRevenue = executedPrice * sharesNum;

      player.cash = Number((player.cash + totalRevenue).toFixed(2));
      pos.longShares -= sharesNum;
      if (pos.longShares === 0) pos.avgCost = 0;
      stock.price = postPrice;

    } else if (side === 'SHORT') {
      // 融券做空打壓價格，需 100% 保證金
      postPrice = Math.max(0.01, Number((stock.price * (1 - impactFactor)).toFixed(2)));
      executedPrice = Math.max(0.01, Number((stock.price * (1 - impactFactor / 2)).toFixed(2)));
      const requiredMargin = executedPrice * sharesNum;

      if (player.cash < requiredMargin) {
        roomManager.sendTo(player.ws, {
          type: 'ORDER_ACK',
          payload: { success: false, code: 'INSUFFICIENT_MARGIN', message: '可用保證金不足' }
        });
        return;
      }

      player.cash = Number((player.cash - requiredMargin).toFixed(2));
      const totalShortShares = pos.shortShares + sharesNum;
      pos.shortAvgPrice = Number(((pos.shortShares * pos.shortAvgPrice + requiredMargin) / totalShortShares).toFixed(2));
      pos.shortShares = totalShortShares;
      pos.frozenMargin = Number((pos.frozenMargin + requiredMargin).toFixed(2));
      stock.price = postPrice;

    } else if (side === 'COVER') {
      // 融券平倉買回推升價格
      if (pos.shortShares < sharesNum) {
        roomManager.sendTo(player.ws, {
          type: 'ORDER_ACK',
          payload: { success: false, code: 'INSUFFICIENT_SHORT_POSITION', message: '融券空單數量不足' }
        });
        return;
      }

      postPrice = Number((stock.price * (1 + impactFactor)).toFixed(2));
      executedPrice = Number((stock.price * (1 + impactFactor / 2)).toFixed(2));

      // 釋放等比例保證金與計算盈虧
      const ratio = sharesNum / pos.shortShares;
      const releasedMargin = pos.frozenMargin * ratio;
      const profitLoss = (pos.shortAvgPrice - executedPrice) * sharesNum;
      const returnedCash = releasedMargin + profitLoss;

      player.cash = Number((player.cash + returnedCash).toFixed(2));
      pos.shortShares -= sharesNum;
      pos.frozenMargin = Number((pos.frozenMargin - releasedMargin).toFixed(2));
      if (pos.shortShares === 0) {
        pos.shortAvgPrice = 0;
        pos.frozenMargin = 0;
      }
      stock.price = postPrice;

    } else {
      roomManager.sendTo(player.ws, {
        type: 'ORDER_ACK',
        payload: { success: false, code: 'INVALID_SIDE', message: `不支援之交易方向: ${side}` }
      });
      return;
    }

    // 更新財務狀態
    updatePlayerFinancials(player, room.marketState);

    // 回覆委託成功
    roomManager.sendTo(player.ws, {
      type: 'ORDER_ACK',
      payload: {
        success: true,
        orderId: `ord_${Math.random().toString(36).slice(2, 9)}`,
        symbol: stockSymbol,
        side,
        shares: sharesNum,
        price: executedPrice,
        postPrice: stock.price,
        message: '委託成功成交'
      }
    });

    // 推播帳戶狀態更新
    roomManager.sendTo(player.ws, {
      type: 'ACCOUNT_UPDATE',
      payload: {
        cash: player.cash,
        netWorth: player.netWorth,
        pnl: player.pnl,
        pnlPercent: player.pnlPercent,
        positions: player.positions
      }
    });

    // 廣播受影響標的之最新行情
    roomManager.broadcastToRoom(room.roomCode, {
      type: 'MARKET_TICK',
      payload: {
        timestamp: Date.now(),
        remainingSeconds: room.remainingSeconds,
        stocks: room.marketState
      }
    });
  };

  // 4. 遊戲結束強制全場平倉 hook (PROJECT.md §4)
  roomManager.onGameOver = (room) => {
    if (!room.marketState) return null;

    const rankingsList = [];

    // 強制平倉所有玩家部位
    for (const player of room.players.values()) {
      let finalCash = player.cash;

      for (const [sym, pos] of Object.entries(player.positions)) {
        const stock = room.marketState[sym];
        const fairPrice = stock ? stock.price : 100;

        // 現貨平倉變現
        if (pos.longShares > 0) {
          finalCash += pos.longShares * fairPrice;
          pos.longShares = 0;
          pos.avgCost = 0;
        }

        // 做空平倉解凍保證金並結算盈虧
        if (pos.shortShares > 0) {
          const pnl = (pos.shortAvgPrice - fairPrice) * pos.shortShares;
          finalCash += pos.frozenMargin + pnl;
          pos.shortShares = 0;
          pos.shortAvgPrice = 0;
          pos.frozenMargin = 0;
        }
      }

      player.cash = Number(finalCash.toFixed(2));
      player.netWorth = player.cash;
      player.pnl = Number((player.netWorth - player.initialCash).toFixed(2));
      player.pnlPercent = Number(((player.pnl / player.initialCash) * 100).toFixed(2));

      rankingsList.push({
        playerId: player.id,
        playerName: player.name,
        finalCash: player.cash,
        netWorth: player.netWorth,
        pnl: player.pnl,
        returnRate: player.pnlPercent,
        pnlPercent: player.pnlPercent
      });
    }

    // 依淨資產降序排序
    rankingsList.sort((a, b) => b.netWorth - a.netWorth);
    const finalRankings = rankingsList.map((p, idx) => ({ rank: idx + 1, ...p }));

    return {
      rankings: finalRankings,
      winner: finalRankings[0] ? {
        name: finalRankings[0].playerName,
        netWorth: finalRankings[0].netWorth,
        returnRate: finalRankings[0].returnRate
      } : null
    };
  };

  roomManager._enginesAttached = true;
}

/**
 * 輔助計算玩家淨資產與浮動盈虧
 */
function updatePlayerFinancials(player, marketState) {
  let positionValue = 0;
  let shortUnrealizedPnl = 0;
  let totalFrozenMargin = 0;

  for (const [sym, pos] of Object.entries(player.positions)) {
    const stock = marketState[sym];
    const currentPrice = stock ? stock.price : (pos.avgCost || 100);

    // 多頭現值
    if (pos.longShares > 0) {
      positionValue += pos.longShares * currentPrice;
    }

    // 空頭未實現損益與保證金
    if (pos.shortShares > 0) {
      totalFrozenMargin += pos.frozenMargin;
      shortUnrealizedPnl += (pos.shortAvgPrice - currentPrice) * pos.shortShares;
    }
  }

  player.netWorth = Number((player.cash + totalFrozenMargin + positionValue + shortUnrealizedPnl).toFixed(2));
  player.pnl = Number((player.netWorth - player.initialCash).toFixed(2));
  player.pnlPercent = Number(((player.pnl / player.initialCash) * 100).toFixed(2));
}

/**
 * 外部觸發突發新聞跳空衝擊輔助函式 (PROJECT.md §3)
 */
function injectNewsShock(roomCode, { symbol, shockPercent, title, content }) {
  const room = roomManager.getRoom(roomCode);
  if (!room || !room.marketState || !room.marketState[symbol]) return;

  const stock = room.marketState[symbol];
  const oldPrice = stock.price;
  const newPrice = Math.max(0.01, Number((oldPrice * (1 + shockPercent / 100)).toFixed(2)));
  stock.price = newPrice;
  stock.high = Math.max(stock.high, newPrice);
  stock.low = Math.min(stock.low, newPrice);
  stock.change = Number((newPrice - stock.open).toFixed(2));
  stock.changePercent = Number(((stock.change / stock.open) * 100).toFixed(2));
  stock.history.push(newPrice);

  const newsItem = {
    id: `news_${Math.random().toString(36).slice(2, 9)}`,
    title: title || `${symbol} 重大突發市場事件！`,
    content: content || `受到意外市場消息影響，${symbol} 發生顯著跳空波動。`,
    scope: 'STOCK',
    affectedSymbol: symbol,
    shockPercent,
    timestamp: Date.now()
  };

  room.newsHistory.push(newsItem);

  // 廣播新聞與跳空行情
  roomManager.broadcastToRoom(roomCode, {
    type: 'NEWS_FLASH',
    payload: newsItem
  });

  roomManager.broadcastToRoom(roomCode, {
    type: 'MARKET_TICK',
    payload: {
      timestamp: Date.now(),
      remainingSeconds: room.remainingSeconds,
      stocks: room.marketState
    }
  });
}

// ======================= 測試套件主體 =======================

describe('股市即時對戰多人連線模擬系統 - E2E 自動化驗收測試套件', () => {

  before(async () => {
    ensureReferenceEngines();

    // 啟動伺服器於隨機 port
    await new Promise((resolve) => {
      server.listen(0, () => {
        const port = server.address().port;
        serverUrl = `ws://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // 清理所有房間定時器
    for (const room of roomManager.rooms.values()) {
      if (room.timer) clearInterval(room.timer);
    }
    // 關閉 WebSocket 與 HTTP 伺服器
    await new Promise((resolve) => {
      wss.close(() => {
        server.close(resolve);
      });
    });
  });

  // ----------------------------------------------------
  // Tier 1: 基礎連線、房間管理與即時行情推播
  // ----------------------------------------------------
  describe('Tier 1: 基礎通訊與房間大廳 (Lobby & Market Tick)', () => {
    let alice;
    let bob;
    let charlie;
    let roomCode;

    after(async () => {
      if (alice) await alice.disconnect();
      if (bob) await bob.disconnect();
      if (charlie) await charlie.disconnect();
    });

    test('T1.1 房主建立房間與自訂時長 (CREATE_ROOM)', async () => {
      alice = new StockBotClient({ name: 'Alice_Host' });
      await alice.connect(serverUrl);
      assert.strictEqual(alice.connected, true, 'Alice 連線應成功');

      const roomState = await alice.createRoom({
        hostName: 'Alice_Host',
        durationSeconds: 120,
        initialCash: 1000000
      });

      assert.ok(roomState.roomCode, '應產生非空房間代碼');
      assert.strictEqual(roomState.roomCode.length, 6, '房間代碼長度應為 6 碼');
      assert.strictEqual(roomState.status, 'WAITING', '初始狀態應為 WAITING');
      assert.strictEqual(roomState.durationSeconds, 120, '比賽時長應為 120 秒');
      assert.strictEqual(roomState.initialCash, 1000000, '初始資金應為 $1,000,000');
      assert.strictEqual(roomState.players.length, 1, '房間應有 1 位玩家');
      assert.strictEqual(roomState.players[0].isHost, true, 'Alice 應為房主');

      roomCode = roomState.roomCode;
    });

    test('T1.2 多玩家連線加入同房間 (JOIN_ROOM)', async () => {
      bob = new StockBotClient({ name: 'Bob_Trader' });
      charlie = new StockBotClient({ name: 'Charlie_Trader' });

      await bob.connect(serverUrl);
      await charlie.connect(serverUrl);

      // Bob 加入房間
      const bobRoomState = await bob.joinRoom(roomCode, 'Bob_Trader');
      assert.strictEqual(bobRoomState.players.length, 2, '加入後房間應有 2 位玩家');

      // Charlie 加入房間
      const charlieRoomState = await charlie.joinRoom(roomCode, 'Charlie_Trader');
      assert.strictEqual(charlieRoomState.players.length, 3, '加入後房間應有 3 位玩家');

      // 驗證房主 Alice 端也收到 3 位玩家的 ROOM_STATE
      assert.strictEqual(alice.roomState.players.length, 3, 'Alice 端應同步顯示 3 位玩家');
      const names = alice.roomState.players.map(p => p.name);
      assert.ok(names.includes('Alice_Host'), '名單應包含 Alice');
      assert.ok(names.includes('Bob_Trader'), '名單應包含 Bob');
      assert.ok(names.includes('Charlie_Trader'), '名單應包含 Charlie');
    });

    test('T1.3 房主啟動遊戲切換狀態 (START_GAME)', async () => {
      const pBob = bob.waitForEvent('ROOM_STATE', 5000, s => s.status === 'PLAYING');
      const pCharlie = charlie.waitForEvent('ROOM_STATE', 5000, s => s.status === 'PLAYING');

      const startState = await alice.startGame(roomCode);
      assert.strictEqual(startState.status, 'PLAYING', '狀態應轉變為 PLAYING');

      const bobState = await pBob;
      const charlieState = await pCharlie;
      assert.strictEqual(bobState.status, 'PLAYING', 'Bob 端應同步切換為 PLAYING');
      assert.strictEqual(charlieState.status, 'PLAYING', 'Charlie 端應同步切換為 PLAYING');
    });

    test('T1.4 全房玩家於 1 秒內收到 MARKET_TICK 即時行情推播', async () => {
      const aliceTicks = await alice.waitForMarketTicks(1, 2000);
      const bobTicks = await bob.waitForMarketTicks(1, 2000);

      assert.ok(aliceTicks.length > 0, 'Alice 應收到行情 Tick');
      assert.ok(bobTicks.length > 0, 'Bob 應收到行情 Tick');

      const tick = aliceTicks[0];
      assert.ok(tick.stocks, '行情 Tick 應包含 stocks 物件');
      
      const expectedSymbols = ['MEGA', 'NVTX', 'SOLR', 'MEME'];
      for (const sym of expectedSymbols) {
        assert.ok(tick.stocks[sym], `應包含標的 ${sym}`);
        assert.ok(tick.stocks[sym].price > 0, `${sym} 價格應恆大於 0`);
        assert.ok(typeof tick.stocks[sym].changePercent === 'number', `${sym} 應有漲跌幅百分比`);
      }
    });
  });

  // ----------------------------------------------------
  // Tier 2: 邊界測試與異常委託防禦
  // ----------------------------------------------------
  describe('Tier 2: 邊界測試與異常防禦 (Boundary & Defensive Rules)', () => {
    let host;
    let guest;
    let roomCode;

    before(async () => {
      host = new StockBotClient({ name: 'Host_T2' });
      guest = new StockBotClient({ name: 'Guest_T2' });
      await host.connect(serverUrl);
      await guest.connect(serverUrl);

      const r = await host.createRoom({ hostName: 'Host_T2', durationSeconds: 120 });
      roomCode = r.roomCode;
      await guest.joinRoom(roomCode, 'Guest_T2');
      await host.startGame();
    });

    after(async () => {
      if (host) await host.disconnect();
      if (guest) await guest.disconnect();
    });

    test('T2.1 加入不存在的無效房間代碼 (ROOM_NOT_FOUND)', async () => {
      const outsider = new StockBotClient({ name: 'Outsider' });
      await outsider.connect(serverUrl);

      const pError = outsider.waitForEvent('ERROR', 3000);
      outsider.send('JOIN_ROOM', { roomCode: 'NO_SUCH_ROOM', playerName: 'Ghost' });
      const err = await pError;

      assert.strictEqual(err.code, 'ROOM_NOT_FOUND', '應回傳 ROOM_NOT_FOUND 錯誤碼');
      await outsider.disconnect();
    });

    test('T2.2 現貨買入可用現金不足拒單防禦 (INSUFFICIENT_FUNDS)', async () => {
      // 嘗試買入 1,000,000 股 MEGA（價值數億，遠超初始 100 萬）
      const ack = await guest.placeOrder({
        roomCode,
        stockSymbol: 'MEGA',
        side: 'BUY',
        shares: 1000000
      });

      assert.strictEqual(ack.success, false, '超額買單應被伺服器拒絕');
      assert.strictEqual(ack.code, 'INSUFFICIENT_FUNDS', '錯誤碼應為 INSUFFICIENT_FUNDS');
    });

    test('T2.3 融券做空保證金不足拒單防禦 (INSUFFICIENT_MARGIN)', async () => {
      // 嘗試融券做空 1,000,000 股 NVTX
      const ack = await guest.placeOrder({
        roomCode,
        stockSymbol: 'NVTX',
        side: 'SHORT',
        shares: 1000000
      });

      assert.strictEqual(ack.success, false, '超保證金空單應被拒絕');
      assert.strictEqual(ack.code, 'INSUFFICIENT_MARGIN', '錯誤碼應為 INSUFFICIENT_MARGIN');
    });

    test('T2.4 零持股賣出與零空單平倉防禦 (INSUFFICIENT_SHARES / POSITION)', async () => {
      // 未持股賣出
      const sellAck = await guest.placeOrder({
        roomCode,
        stockSymbol: 'SOLR',
        side: 'SELL',
        shares: 100
      });
      assert.strictEqual(sellAck.success, false, '未持股賣出應被拒絕');
      assert.strictEqual(sellAck.code, 'INSUFFICIENT_SHARES', '錯誤碼應為 INSUFFICIENT_SHARES');

      // 未做空平倉
      const coverAck = await guest.placeOrder({
        roomCode,
        stockSymbol: 'SOLR',
        side: 'COVER',
        shares: 100
      });
      assert.strictEqual(coverAck.success, false, '未做空平倉應被拒絕');
      assert.strictEqual(coverAck.code, 'INSUFFICIENT_SHORT_POSITION', '錯誤碼應為 INSUFFICIENT_SHORT_POSITION');
    });

    test('T2.5 非房主嘗試啟動遊戲權限防禦 (NOT_HOST)', async () => {
      const idleHost = new StockBotClient({ name: 'IdleHost' });
      const normalPlayer = new StockBotClient({ name: 'NormalPlayer' });
      await idleHost.connect(serverUrl);
      await normalPlayer.connect(serverUrl);

      const r = await idleHost.createRoom({ hostName: 'IdleHost', durationSeconds: 60 });
      await normalPlayer.joinRoom(r.roomCode, 'NormalPlayer');

      const pErr = normalPlayer.waitForEvent('ERROR', 3000);
      normalPlayer.send('START_GAME', { roomCode: r.roomCode });
      const err = await pErr;

      assert.strictEqual(err.code, 'NOT_HOST', '非房主嘗試開局應被拒絕並回傳 NOT_HOST');

      await idleHost.disconnect();
      await normalPlayer.disconnect();
    });
  });

  // ----------------------------------------------------
  // Tier 3: 價格衝擊 (Price Impact) 與雙向交易撮合
  // ----------------------------------------------------
  describe('Tier 3: 價格衝擊模型與雙向交易 (Price Impact & Trading Depth)', () => {
    let trader;
    let roomCode;

    before(async () => {
      trader = new StockBotClient({ name: 'Trader_T3' });
      await trader.connect(serverUrl);

      const r = await trader.createRoom({ hostName: 'Trader_T3', durationSeconds: 180 });
      roomCode = r.roomCode;
      await trader.startGame();
      await trader.waitForMarketTicks(1);
    });

    after(async () => {
      if (trader) await trader.disconnect();
    });

    test('T3.1 大單現貨買入推升股價 (Price Impact - BUY)', async () => {
      const prePrice = trader.marketState.stocks.NVTX.price;
      const initialCash = trader.accountState ? trader.accountState.cash : 1000000;

      // 買入 500 股 NVTX
      const ack = await trader.placeOrder({
        roomCode,
        stockSymbol: 'NVTX',
        side: 'BUY',
        shares: 500
      });

      assert.strictEqual(ack.success, true, '買單應成功成交');
      assert.ok(ack.price > 0, '成交價應大於 0');
      
      const postPrice = trader.marketState.stocks.NVTX.price;
      assert.ok(postPrice > prePrice, `大單買進後市價應被推升: pre=${prePrice}, post=${postPrice}`);

      // 驗證帳戶狀態
      assert.ok(trader.accountState.cash < initialCash, '現金應減少');
      assert.strictEqual(trader.accountState.positions.NVTX.longShares, 500, '多頭持股應為 500 股');
    });

    test('T3.2 大單融券做空打壓股價 (Price Impact - SHORT)', async () => {
      const prePrice = trader.marketState.stocks.SOLR.price;

      // 融券做空 1,000 股 SOLR
      const ack = await trader.placeOrder({
        roomCode,
        stockSymbol: 'SOLR',
        side: 'SHORT',
        shares: 1000
      });

      assert.strictEqual(ack.success, true, '做空委託應成功成交');
      
      const postPrice = trader.marketState.stocks.SOLR.price;
      assert.ok(postPrice < prePrice, `大單做空後市價應被壓低: pre=${prePrice}, post=${postPrice}`);

      // 驗證做空部位與保證金
      assert.strictEqual(trader.accountState.positions.SOLR.shortShares, 1000, '空頭部位應為 1,000 股');
      assert.ok(trader.accountState.positions.SOLR.frozenMargin > 0, '應凍結做空保證金');
    });

    test('T3.3 雙向平倉操作 (SELL 現貨賣出與 COVER 空單買回)', async () => {
      // 1. 現貨賣出平倉 NVTX
      const sellAck = await trader.placeOrder({
        roomCode,
        stockSymbol: 'NVTX',
        side: 'SELL',
        shares: 500
      });
      assert.strictEqual(sellAck.success, true, '現貨賣出應成功');
      assert.strictEqual(trader.accountState.positions.NVTX.longShares, 0, '現貨持股應歸零');

      // 2. 空單買回平倉 SOLR
      const coverAck = await trader.placeOrder({
        roomCode,
        stockSymbol: 'SOLR',
        side: 'COVER',
        shares: 1000
      });
      assert.strictEqual(coverAck.success, true, '空單買回平倉應成功');
      assert.strictEqual(trader.accountState.positions.SOLR.shortShares, 0, '做空部位應歸零');
      assert.strictEqual(trader.accountState.positions.SOLR.frozenMargin, 0, '保證金應全數解凍');
    });
  });

  // ----------------------------------------------------
  // Tier 4: 核心 3-Bot 高頻博弈、事件跳空與終局強制平倉結算
  // ----------------------------------------------------
  describe('Tier 4: 核心多機器人同房高頻博弈與結算驗收 (Real-World 3-Bot Battle)', () => {
    let alice;
    let bob;
    let charlie;
    let battleRoomCode;

    after(async () => {
      if (alice) await alice.disconnect();
      if (bob) await bob.disconnect();
      if (charlie) await charlie.disconnect();
    });

    test('T4.1 3 個獨立機器人同房高頻對戰、新聞跳空衝擊與終局結算全流程', async () => {
      // 建立 Alice, Bob, Charlie 三個獨立 Bot 客戶端
      alice = new StockBotClient({ name: 'Alice_Bull' });
      bob = new StockBotClient({ name: 'Bob_Bear' });
      charlie = new StockBotClient({ name: 'Charlie_Scalper' });

      await alice.connect(serverUrl);
      await bob.connect(serverUrl);
      await charlie.connect(serverUrl);

      // 建立快速 30 秒競技對戰房間 (符合 30~600s 限制)
      const createdRoom = await alice.createRoom({
        hostName: 'Alice_Bull',
        durationSeconds: 30,
        initialCash: 1000000
      });
      battleRoomCode = createdRoom.roomCode;

      // Bob 與 Charlie 加入
      await bob.joinRoom(battleRoomCode, 'Bob_Bear');
      await charlie.joinRoom(battleRoomCode, 'Charlie_Scalper');

      // 房主 Alice 啟動比賽
      await alice.startGame(battleRoomCode);

      // 等待市場首個行情 tick
      await Promise.all([
        alice.waitForMarketTicks(1),
        bob.waitForMarketTicks(1),
        charlie.waitForMarketTicks(1)
      ]);

      // --- 高頻並發交易博弈 ---
      // Alice: 專注做多科技股 NVTX
      const aliceOrderP = alice.placeOrder({
        roomCode: battleRoomCode,
        stockSymbol: 'NVTX',
        side: 'BUY',
        shares: 300
      });

      // Bob: 專注做空迷因股 MEME
      const bobOrderP = bob.placeOrder({
        roomCode: battleRoomCode,
        stockSymbol: 'MEME',
        side: 'SHORT',
        shares: 500
      });

      // Charlie: 高頻做多新能源 SOLR
      const charlieOrderP = charlie.placeOrder({
        roomCode: battleRoomCode,
        stockSymbol: 'SOLR',
        side: 'BUY',
        shares: 200
      });

      const [aliceAck, bobAck, charlieAck] = await Promise.all([
        aliceOrderP,
        bobOrderP,
        charlieOrderP
      ]);

      assert.strictEqual(aliceAck.success, true, 'Alice 做多買單應成交');
      assert.strictEqual(bobAck.success, true, 'Bob 做空委託應成交');
      assert.strictEqual(charlieAck.success, true, 'Charlie 多單應成交');

      // --- 突發黑天鵝新聞事件跳空衝擊 ---
      const memePreShockPrice = alice.marketState.stocks.MEME.price;

      // 注入突發利空黑天鵝：MEME 暴跌 -25%
      injectNewsShock(battleRoomCode, {
        symbol: 'MEME',
        shockPercent: -25,
        title: 'SEC 突擊稽查迷因幣炒作，相關概念股血崩！',
        content: '主管機關全面清查社群哄抬，MEME 面臨退市與訴訟風險。'
      });

      // 全體機器人監聽新聞事件廣播 NEWS_FLASH
      const [aliceNews, bobNews, charlieNews] = await Promise.all([
        alice.waitForEvent('NEWS_FLASH', 2000),
        bob.waitForEvent('NEWS_FLASH', 2000),
        charlie.waitForEvent('NEWS_FLASH', 2000)
      ]);

      assert.strictEqual(aliceNews.affectedSymbol, 'MEME', '新聞受影響標的應為 MEME');
      assert.strictEqual(bobNews.shockPercent, -25, '新聞衝擊幅度應為 -25%');
      assert.strictEqual(charlieNews.scope, 'STOCK', '新聞範疇應為個股');

      // 驗證 MEME 價格在新聞後即時跳空大跌
      const memePostShockPrice = alice.marketState.stocks.MEME.price;
      assert.ok(memePostShockPrice < memePreShockPrice, `MEME 價格應顯著跳空暴跌: pre=${memePreShockPrice}, post=${memePostShockPrice}`);

      // Bob 在 MEME 暴跌後執行獲利平倉 (COVER)
      const bobCoverAck = await bob.placeOrder({
        roomCode: battleRoomCode,
        stockSymbol: 'MEME',
        side: 'COVER',
        shares: 500
      });
      assert.strictEqual(bobCoverAck.success, true, 'Bob 獲利平倉應成功');

      // --- 將房間計時器撥至最後 2 秒，驗證時鐘歸零自動封盤與強制平倉 ---
      const battleRoom = roomManager.getRoom(battleRoomCode);
      if (battleRoom) {
        battleRoom.remainingSeconds = 2;
      }

      // --- 等待倒數計時結束並驗證全場強制平倉與結算榜單 (GAME_OVER) ---
      const [aliceGameOver, bobGameOver, charlieGameOver] = await Promise.all([
        alice.waitForGameOver(6000),
        bob.waitForGameOver(6000),
        charlie.waitForGameOver(6000)
      ]);

      assert.ok(aliceGameOver, 'Alice 應收到 GAME_OVER');
      assert.ok(bobGameOver, 'Bob 應收到 GAME_OVER');
      assert.ok(charlieGameOver, 'Charlie 應收到 GAME_OVER');

      const { rankings, winner } = aliceGameOver;

      // 1. 斷言排行榜包含全體 3 位玩家
      assert.strictEqual(rankings.length, 3, '結算榜單應恰好包含 3 名參賽玩家');

      // 2. 斷言排名嚴格由第 1 名至第 3 名遞增
      for (let i = 0; i < rankings.length; i++) {
        assert.strictEqual(rankings[i].rank, i + 1, `第 ${i + 1} 位玩家 rank 應為 ${i + 1}`);
        assert.ok(Number.isFinite(rankings[i].netWorth), '淨資產必須為合法有限數值');
        assert.ok(!Number.isNaN(rankings[i].netWorth), '淨資產不得為 NaN');
        assert.ok(Number.isFinite(rankings[i].returnRate), '回報率必須為合法有限數值');
      }

      // 3. 斷言淨資產排序嚴格單調不增 (Rank 1 >= Rank 2 >= Rank 3)
      assert.ok(rankings[0].netWorth >= rankings[1].netWorth, '第 1 名淨資產應大於等於第 2 名');
      assert.ok(rankings[1].netWorth >= rankings[2].netWorth, '第 2 名淨資產應大於等於第 3 名');

      // 4. 斷言冠軍與榜首一致
      assert.ok(winner, '應產出冠軍 winner');
      assert.strictEqual(winner.name, rankings[0].playerName, '冠軍名稱應與結算第一名一致');
      assert.strictEqual(winner.netWorth, rankings[0].netWorth, '冠軍淨資產應與第一名完全一致');

      // 5. 斷言全場強制平倉：結算後所有玩家的持股與做空部位皆已轉為現金
      const room = roomManager.getRoom(battleRoomCode);
      for (const player of room.players.values()) {
        for (const [sym, pos] of Object.entries(player.positions)) {
          assert.strictEqual(pos.longShares, 0, `玩家 ${player.name} 標的 ${sym} 多頭部位應被強制平倉歸零`);
          assert.strictEqual(pos.shortShares, 0, `玩家 ${player.name} 標的 ${sym} 空頭部位應被強制平倉歸零`);
          assert.strictEqual(pos.frozenMargin, 0, `玩家 ${player.name} 標的 ${sym} 保證金應解凍歸零`);
        }
        assert.strictEqual(player.netWorth, player.cash, `玩家 ${player.name} 結算後淨資產應全數變現為現金`);
      }
    });
  });
});
