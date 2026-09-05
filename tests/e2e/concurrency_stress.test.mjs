/**
 * Tier 5 Concurrency & Stress Hardening Test Suite
 * 股市即時對戰多人連線模擬系統 - 高併發與壓力對抗測試套件
 * 
 * 涵蓋測試項目：
 * 1. 5~10 個機器人同房高頻交錯併發下單 (BUY, SELL, SHORT, COVER)
 * 2. 惡意與畸形 Payload 注入 (Malformed JSON, null payloads, prototype pollution, oversized payload)
 * 3. 倒數即將歸零 (00:01) 壓哨併發下單與鎖盤防禦
 * 4. 事件循環延遲、記憶體監控與 Race Condition 驗證
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { StockBotClient } from './bot_client.mjs';

process.env.NODE_ENV = 'test';
process.env.DISABLE_SERVER_AUTOSTART = 'true';

const { server, wss, roomManager } = await import('../../server/server.js');

let serverUrl = '';

/**
 * 測量事件循環延遲輔助工具
 */
class LagMonitor {
  constructor() {
    this.maxLag = 0;
    this.samples = [];
    this.timer = null;
    this.running = false;
  }

  start(intervalMs = 10) {
    this.maxLag = 0;
    this.samples = [];
    this.running = true;
    let expected = Date.now() + intervalMs;

    const check = () => {
      if (!this.running) return;
      const now = Date.now();
      const lag = Math.max(0, now - expected);
      if (lag > this.maxLag) this.maxLag = lag;
      this.samples.push(lag);
      expected = now + intervalMs;
      this.timer = setTimeout(check, intervalMs);
    };

    this.timer = setTimeout(check, intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const avgLag = this.samples.length > 0 
      ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length 
      : 0;
    return { maxLagMs: this.maxLag, avgLagMs: avgLag, samplesCount: this.samples.length };
  }
}

describe('Tier 5 Hardening: 高併發與壓力對抗測試套件', () => {

  before(async () => {
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
    // 清除所有房間計時器
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

  // =========================================================================
  // 測試區塊 1: 5~10 個機器人同房極端高頻併發下單壓力測試
  // =========================================================================
  describe('1. 8 機器人同房極端高頻併發下單壓力與 Race Condition 檢驗', () => {
    const BOT_COUNT = 8;
    const bots = [];
    let hostBot;
    let roomCode = '';

    after(async () => {
      for (const b of bots) {
        await b.disconnect();
      }
    });

    test(`1.1 成功連線 ${BOT_COUNT} 個機器人進入同房間並啟動遊戲`, async () => {
      // 1. 建立房主機器人
      hostBot = new StockBotClient({ name: 'Stress_Host' });
      await hostBot.connect(serverUrl);
      const roomState = await hostBot.createRoom({
        hostName: 'Stress_Host',
        durationSeconds: 120,
        initialCash: 1000000
      });
      roomCode = roomState.roomCode;
      bots.push(hostBot);

      // 2. 陸續連線其餘 7 個機器人加入房間
      const joinPromises = [];
      for (let i = 1; i < BOT_COUNT; i++) {
        const bot = new StockBotClient({ name: `Stress_Bot_${i}` });
        bots.push(bot);
        joinPromises.push((async () => {
          await bot.connect(serverUrl);
          await bot.joinRoom(roomCode, `Stress_Bot_${i}`);
        })());
      }
      await Promise.all(joinPromises);

      assert.equal(bots.length, BOT_COUNT);
      assert.equal(roomManager.rooms.get(roomCode).players.size, BOT_COUNT);

      // 3. 房主啟動遊戲
      const startState = await hostBot.startGame(roomCode);
      assert.equal(startState.status, 'PLAYING');
    });

    test('1.2 8 個機器人併發發送 160+ 筆交錯下單 (BUY, SHORT, SELL, COVER)，驗證撮合與會計一致性', async () => {
      const lagMonitor = new LagMonitor();
      lagMonitor.start(10);

      const STOCKS = ['MEGA', 'NVTX', 'SOLR', 'MEME'];
      const SIDES = ['BUY', 'SHORT', 'SELL', 'COVER'];
      const totalOrdersTarget = 160;
      const ordersPerBot = totalOrdersTarget / bots.length; // 每隻機器人 20 筆
      const startTime = Date.now();

      const orderResults = [];

      // 監聽各機器人的 ORDER_ACK
      for (const bot of bots) {
        bot.on('ORDER_ACK', (ack) => {
          orderResults.push({ bot: bot.name, ack });
        });
      }

      // 併發激發爆量下單陣列
      const firingPromises = bots.map(async (bot, botIdx) => {
        for (let j = 0; j < ordersPerBot; j++) {
          const sym = STOCKS[(botIdx + j) % STOCKS.length];
          const side = SIDES[j % SIDES.length];
          const shares = 10 + (j % 5) * 10; // 10 ~ 50 股

          // 直接送出 PLACE_ORDER
          bot.send('PLACE_ORDER', {
            roomCode,
            stockSymbol: sym,
            side,
            shares
          });

          // 微間隔以模擬 20~50 筆/秒真實高頻
          if (j % 4 === 0) {
            await new Promise(r => setTimeout(r, 5));
          }
        }
      });

      await Promise.all(firingPromises);

      // 等待所有 ORDER_ACK 處理完成 (最多等待 3000ms)
      const waitStart = Date.now();
      while (orderResults.length < totalOrdersTarget && Date.now() - waitStart < 3000) {
        await new Promise(r => setTimeout(r, 20));
      }

      const durationMs = Date.now() - startTime;
      const lagStats = lagMonitor.stop();

      console.log(`[Stress Test 1.2] 完成發送與回報: ${orderResults.length}/${totalOrdersTarget} 筆訂單，耗時: ${durationMs}ms`);
      console.log(`[Stress Test 1.2] 事件循環延遲: 最大 ${lagStats.maxLagMs}ms, 平均 ${lagStats.avgLagMs.toFixed(2)}ms`);

      // 斷言：收到的回覆數量應等於總發送數
      assert.ok(orderResults.length >= totalOrdersTarget, `回報數 (${orderResults.length}) 應大於或等於發送數 (${totalOrdersTarget})`);

      // 驗證伺服器狀態與資料一致性 (Race Condition 檢核)
      const room = roomManager.rooms.get(roomCode);
      assert.ok(room, '房間應持續存在');
      assert.equal(room.status, 'PLAYING', '房間狀態仍應為 PLAYING');

      // 檢驗各玩家財務狀態
      for (const player of room.players.values()) {
        assert.ok(Number.isFinite(player.cash), `玩家 ${player.name} 的 cash 必須為有限數字，實測: ${player.cash}`);
        assert.ok(player.cash >= 0, `玩家 ${player.name} 的現金不得為負數，實測: ${player.cash}`);
        assert.ok(Number.isFinite(player.netWorth), `玩家 ${player.name} 的 netWorth 必須為有限數字，實測: ${player.netWorth}`);
        assert.ok(player.frozenMargin >= 0, `玩家 ${player.name} 的凍結保證金不得為負數，實測: ${player.frozenMargin}`);

        // 檢驗各部位
        for (const [sym, pos] of Object.entries(player.positions)) {
          assert.ok(pos.longShares >= 0, `玩家 ${player.name} 股票 ${sym} longShares 不能為負數: ${pos.longShares}`);
          assert.ok(pos.shortShares >= 0, `玩家 ${player.name} 股票 ${sym} shortShares 不能為負數: ${pos.shortShares}`);
          assert.ok(Number.isFinite(pos.avgCost), `avgCost 必須為有效數字: ${pos.avgCost}`);
          assert.ok(Number.isFinite(pos.shortAvgPrice), `shortAvgPrice 必須為有效數字: ${pos.shortAvgPrice}`);
        }
      }

      // 檢驗股票價格邊界守門
      for (const sym of STOCKS) {
        const stock = room.marketEngine.getStock(sym);
        assert.ok(stock.price >= 0.01, `股票 ${sym} 價格不可低於 Penny Floor $0.01: ${stock.price}`);
        assert.ok(stock.price <= 100000.0, `股票 ${sym} 價格不可超過上限 $100,000: ${stock.price}`);
        assert.ok(!isNaN(stock.price), `股票 ${sym} 價格不可為 NaN`);
      }
    });
  });

  // =========================================================================
  // 測試區塊 2: 惡意注入與畸形 Payload 對抗測試
  // =========================================================================
  describe('2. 惡意注入與畸形 Payload 對抗測試 (Fuzzing & Malformed Attacks)', () => {
    let attackerBot;
    let victimRoomCode = '';

    before(async () => {
      attackerBot = new StockBotClient({ name: 'Attacker' });
      await attackerBot.connect(serverUrl);
      const state = await attackerBot.createRoom({ hostName: 'Attacker', durationSeconds: 60 });
      victimRoomCode = state.roomCode;
    });

    after(async () => {
      await attackerBot.disconnect();
    });

    test('2.1 注入非法畸形 JSON 字串，伺服器應回傳 INVALID_JSON 且不崩潰', async () => {
      const errorPromise = attackerBot.waitForEvent('ERROR', 2000, (err) => err.code === 'INVALID_JSON');
      // 送出破損 JSON
      attackerBot.ws.send('{ "type": "PLACE_ORDER", "payload": { broken_json... ');
      const err = await errorPromise;
      assert.ok(err, '伺服器必須回覆錯誤訊息');
      assert.equal(err.code, 'INVALID_JSON');
    });

    test('2.2 注入未知的 Action / Message Type，伺服器應回傳 UNKNOWN_MESSAGE_TYPE 且不崩潰', async () => {
      const errorPromise = attackerBot.waitForEvent('ERROR', 2000, (err) => err.code === 'UNKNOWN_MESSAGE_TYPE');
      attackerBot.send('SYSTEM_DROP_TABLE', { target: 'rooms' });
      const err = await errorPromise;
      assert.equal(err.code, 'UNKNOWN_MESSAGE_TYPE');
    });

    test('2.3 注入非物件型別之 JSON (字串、數字、布林值、陣列)，伺服器不崩潰', async () => {
      // 測試發送數字、字串、陣列
      attackerBot.ws.send('12345');
      attackerBot.ws.send('"just_a_string"');
      attackerBot.ws.send('true');
      attackerBot.ws.send('[1, 2, 3]');

      await new Promise(r => setTimeout(r, 100));

      // 連線保活檢驗：送出合法 PING，確認伺服器依然在線正常運行
      const pong = await attackerBot.ping(2000);
      assert.ok(pong, '伺服器經歷非物件 JSON 注入後必須存活並回覆 PONG');
    });

    test('2.4 注入原生 "null" 訊息與 payload 為 null 之物件，驗證伺服器健壯性', async () => {
      const fuzzerBot = new StockBotClient({ name: 'Fuzzer' });
      await fuzzerBot.connect(serverUrl);

      // 依據審查，JSON.parse("null") 或 payload: null 恐導致解構異常
      try {
        fuzzerBot.ws.send('null');
      } catch (e) {}

      // 測試 payload 為 null
      try {
        fuzzerBot.ws.send(JSON.stringify({ type: 'PLACE_ORDER', payload: null }));
        fuzzerBot.ws.send(JSON.stringify({ type: 'CREATE_ROOM', payload: null }));
        fuzzerBot.ws.send(JSON.stringify({ type: 'JOIN_ROOM', payload: null }));
        fuzzerBot.ws.send(JSON.stringify({ type: 'START_GAME', payload: null }));
        fuzzerBot.ws.send(JSON.stringify({ type: 'PING', payload: null }));
      } catch (e) {}

      await new Promise(r => setTimeout(r, 150));

      // 檢核連線是否存活
      const probePong = await fuzzerBot.ping(2000);
      assert.ok(probePong, '伺服器遭遇 null payload 注入後必須存活並回覆 probe PONG');
      await fuzzerBot.disconnect();
    });

    test('2.5 原型鏈屬性名稱注入 (toString, __proto__, constructor) 下單，伺服器不污染且拒單', async () => {
      // 啟動房間進行測試
      await attackerBot.startGame(victimRoomCode);

      const suspiciousSymbols = ['toString', '__proto__', 'constructor', 'valueOf', '../../secrets'];

      for (const badSym of suspiciousSymbols) {
        const ackPromise = attackerBot.waitForEvent('ORDER_ACK', 2000);
        attackerBot.send('PLACE_ORDER', {
          roomCode: victimRoomCode,
          stockSymbol: badSym,
          side: 'BUY',
          shares: 10
        });

        const ack = await ackPromise;
        assert.equal(ack.success, false, `非法股票標的 ${badSym} 必須被拒絕成交`);
        assert.equal(ack.code, 'INVALID_STOCK', `錯誤代碼應為 INVALID_STOCK: ${badSym}`);
      }

      // 檢驗全域 Object 原型未被污染
      const testObj = {};
      assert.equal(testObj.price, undefined, 'Object.prototype 不得被注入 price 屬性');
      assert.equal(typeof Object.prototype.toString, 'function', 'Object.prototype.toString 必須保持原樣');
    });

    test('2.6 注入負數、零、非數字、無限大與極端股數，伺服器應拒單且無例外', async () => {
      const badShares = [-50, 0, 'fifty', NaN, Infinity, -Infinity, 1e30, null, {}];

      for (const s of badShares) {
        const ackPromise = attackerBot.waitForEvent('ORDER_ACK', 2000);
        attackerBot.send('PLACE_ORDER', {
          roomCode: victimRoomCode,
          stockSymbol: 'MEGA',
          side: 'BUY',
          shares: s
        });

        const ack = await ackPromise;
        assert.equal(ack.success, false, `異常股數 ${s} 必須被拒絕成交`);
        assert.ok(['INVALID_SHARES', 'INSUFFICIENT_FUNDS'].includes(ack.code), `錯誤代碼應為合法拒絕碼: ${ack.code}`);
      }
    });

    test('2.7 注入非法交易方向 (INVALID_SIDE)，伺服器應拒單', async () => {
      const badSides = ['HACK', 'HOLD', 'DESTROY', '', null, 123];

      for (const bSide of badSides) {
        const ackPromise = attackerBot.waitForEvent('ORDER_ACK', 2000);
        attackerBot.send('PLACE_ORDER', {
          roomCode: victimRoomCode,
          stockSymbol: 'MEGA',
          side: bSide,
          shares: 10
        });

        const ack = await ackPromise;
        assert.equal(ack.success, false, `非法交易方向 ${bSide} 必須被拒絕`);
        assert.equal(ack.code, 'INVALID_SIDE');
      }
    });

    test('2.8 注入 1MB 超大 Payload，伺服器不崩潰且能正常運作', async () => {
      const hugeString = 'X'.repeat(1024 * 1024); // 1MB 字串
      const pongPromise = attackerBot.waitForEvent('PONG', 4000);
      attackerBot.ws.send(JSON.stringify({
        type: 'PING',
        payload: { junk: hugeString, timestamp: Date.now() }
      }));

      const pong = await pongPromise;
      assert.ok(pong, '伺服器遭遇 1MB 大 Payload 注入後仍應正常回應 PONG');
    });
  });

  // =========================================================================
  // 測試區塊 3: 倒數即將歸零 (00:01) 壓哨併發下單與鎖盤防禦測試
  // =========================================================================
  describe('3. 倒數歸零 (00:01) 壓哨併發下單與強制平倉鎖盤防禦', () => {
    let host;
    let trader1;
    let trader2;
    let buzzerRoomCode = '';

    after(async () => {
      if (host) await host.disconnect();
      if (trader1) await trader1.disconnect();
      if (trader2) await trader2.disconnect();
    });

    test('3.1 模擬倒數即將歸零 (00:01) 瞬間，併發壓哨下單並經歷鎖盤結算', async () => {
      // 1. 建立短時限房間 (30 秒)
      host = new StockBotClient({ name: 'Buzzer_Host' });
      trader1 = new StockBotClient({ name: 'Buzzer_Trader1' });
      trader2 = new StockBotClient({ name: 'Buzzer_Trader2' });

      await host.connect(serverUrl);
      await trader1.connect(serverUrl);
      await trader2.connect(serverUrl);

      const state = await host.createRoom({
        hostName: 'Buzzer_Host',
        durationSeconds: 30,
        initialCash: 1000000
      });
      buzzerRoomCode = state.roomCode;

      await trader1.joinRoom(buzzerRoomCode, 'Buzzer_Trader1');
      await trader2.joinRoom(buzzerRoomCode, 'Buzzer_Trader2');

      await host.startGame(buzzerRoomCode);

      // 先建立初始倉位 (Trader1 做多 MEGA, Trader2 做空 NVTX)
      await trader1.placeOrder({ stockSymbol: 'MEGA', side: 'BUY', shares: 50 });
      await trader2.placeOrder({ stockSymbol: 'NVTX', side: 'SHORT', shares: 50 });

      const room = roomManager.rooms.get(buzzerRoomCode);
      assert.ok(room);

      // 人為將 remainingSeconds 快轉至 1 秒 (00:01 壓哨倒數)
      room.remainingSeconds = 1;

      // 監聽結算 GAME_OVER 事件
      const gameOverPromise = trader1.waitForGameOver(5000);

      // 在倒數歸零即將切換鎖盤之際，爆量併發射出 30 筆壓哨與盤後下單
      const lateOrderResults = [];
      const burstOrders = [];

      for (let i = 0; i < 15; i++) {
        burstOrders.push(
          trader1.placeOrder({ stockSymbol: 'SOLR', side: 'BUY', shares: 10 }, 3000)
            .then(res => lateOrderResults.push(res))
            .catch(err => lateOrderResults.push({ error: err.message }))
        );
        burstOrders.push(
          trader2.placeOrder({ stockSymbol: 'MEME', side: 'SHORT', shares: 10 }, 3000)
            .then(res => lateOrderResults.push(res))
            .catch(err => lateOrderResults.push({ error: err.message }))
        );
      }

      // 等待時間截止觸發結算
      const gameOverData = await gameOverPromise;
      await Promise.allSettled(burstOrders);

      console.log(`[Buzzer Test] 結算完成，共計處理 ${lateOrderResults.length} 筆壓哨/盤後訂單`);

      // 2. 驗證 GAME_OVER 廣播與排行榜資料結構
      assert.ok(gameOverData, '必須收到 GAME_OVER 廣播');
      assert.equal(gameOverData.roomCode, buzzerRoomCode);
      assert.ok(Array.isArray(gameOverData.rankings), '排行榜必須為陣列');
      assert.equal(gameOverData.rankings.length, 3, '排行榜應恰好有 3 名玩家');

      // 3. 驗證鎖盤後所有持倉全部強制平倉 (部位必須為 0)
      for (const p of room.players.values()) {
        assert.equal(p.frozenMargin, 0, `結算後保證金必須解凍為 0: ${p.name}`);
        assert.equal(p.cash, p.netWorth, `強制平倉後 cash 必須等於 netWorth: ${p.name}`);
        for (const pos of Object.values(p.positions)) {
          assert.equal(pos.longShares, 0, `結算後多頭部位必須歸零: ${p.name}`);
          assert.equal(pos.shortShares, 0, `結算後空頭部位必須歸零: ${p.name}`);
          assert.equal(pos.frozenMargin, 0, `結算後部位保證金必須為 0: ${p.name}`);
        }
      }

      // 4. 檢驗盤後訂單防禦性：在遊戲結算結束後到達之訂單，必須被拒單 (MARKET_CLOSED)
      const postGameOrder = await trader1.placeOrder({ stockSymbol: 'MEGA', side: 'BUY', shares: 10 });
      assert.equal(postGameOrder.success, false, '比賽結束後下單必須被拒絕');
      assert.equal(postGameOrder.code, 'MARKET_CLOSED', '錯誤碼必須為 MARKET_CLOSED');
    });
  });

  // =========================================================================
  // 測試區塊 4: 系統記憶體與事件循環延遲效能監控
  // =========================================================================
  describe('4. 系統資源穩定性與記憶體洩漏監控', () => {
    test('4.1 檢測記憶體用量與垃圾回收，確保經歷高頻壓力後記憶體維持穩定', async () => {
      if (global.gc) {
        global.gc();
      }

      const mem = process.memoryUsage();
      const heapUsedMB = mem.heapUsed / 1024 / 1024;
      const rssMB = mem.rss / 1024 / 1024;

      console.log(`[Memory Monitor] 測試後記憶體用量: HeapUsed = ${heapUsedMB.toFixed(2)} MB, RSS = ${rssMB.toFixed(2)} MB`);

      // 斷言記憶體未失控膨脹 (小於 250MB)
      assert.ok(heapUsedMB < 250, `Heap 用量應小於 250MB，實測: ${heapUsedMB.toFixed(2)} MB`);
      assert.ok(rssMB < 350, `RSS 用量應小於 350MB，實測: ${rssMB.toFixed(2)} MB`);
    });
  });
});
