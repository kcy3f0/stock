/**
 * Tier 5 對抗性金融邊界與極端值衝擊測試套件 (Tier 5 Hardening)
 * 涵蓋：
 * 1. 超額大單衝擊與飽和鉗制 (Penny floor 0.01, 雙曲飽和, 連續空單暴砸與買單暴拉)
 * 2. 軋空與爆倉邊界 (MEME 開空 + 暴漲新聞跳空, 穿倉/負數資產檢驗, 強制平倉順序)
 * 3. 委託股數防禦 (零股、負數股、小數浮點數股 10.5、非整數與注入型字串 "10abc")
 * 4. 浮點數精度與資產守恆性 (MEME shortMarginInit 幽靈資金、多輪交易現金流閉環)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine } from '../../server/models/marketEngine.js';
import { TradingEngine } from '../../server/models/tradingEngine.js';
import { NewsEngine } from '../../server/models/newsEngine.js';
import { STOCKS_CONFIG } from '../../server/config/stocks.js';

function createMockRoom() {
  const marketEngine = new MarketEngine(STOCKS_CONFIG);
  const newsEngine = new NewsEngine(null, marketEngine);
  const tradingEngine = new TradingEngine();
  const room = {
    roomCode: 'TIER5_TEST',
    status: 'PLAYING',
    durationSeconds: 300,
    remainingSeconds: 300,
    initialCash: 1000000,
    marketEngine,
    newsEngine,
    tradingEngine,
    marketState: marketEngine.getStocksState(),
    players: new Map()
  };
  return room;
}

function createMockPlayer(id, name, initialCash = 1000000) {
  return {
    id,
    name,
    cash: initialCash,
    initialCash,
    netWorth: initialCash,
    frozenMargin: 0,
    pnl: 0,
    pnlPercent: 0,
    tradeCount: 0,
    lastTradeTime: 0,
    positions: {}
  };
}

test('Tier 5 金融邊界與極端值對抗衝擊測試 (Tier 5 Hardening)', async (t) => {
  const trading = new TradingEngine();

  // =========================================================================
  // 1. 超額大單衝擊：連續下單做空或連續全倉買進，驗證股價是否飽和於最大衝擊上限，且絕對不跌破 0.01
  // =========================================================================
  await t.test('1. 超額大單衝擊與價格下限邊界防禦', async (t1) => {
    await t1.test('1.1 單筆超額大單衝擊嚴格飽和於 maxImpact (15%)', () => {
      const market = new MarketEngine(STOCKS_CONFIG);
      const symbols = ['MEGA', 'NVTX', 'SOLR', 'MEME'];

      for (const sym of symbols) {
        const stock = market.getStock(sym);
        const p0 = stock.price;

        // 巨量買單: 1,000,000,000 股
        const buyImpact = market.calculatePriceImpact(sym, 1e9);
        assert.ok(
          buyImpact.deltaRatio <= stock.maxImpact + 1e-9,
          `${sym} 巨量買單衝擊比率 (${buyImpact.deltaRatio}) 不得超過 maxImpact (${stock.maxImpact})`
        );
        assert.ok(
          buyImpact.postPrice <= Math.round(p0 * (1 + stock.maxImpact) * 100) / 100 + 0.02,
          `${sym} 巨量買單新市價不大於飽和上限`
        );
        assert.ok(
          buyImpact.execPrice <= buyImpact.postPrice,
          `${sym} 梯形積分均價應不大於 postPrice`
        );

        // 巨量賣單: -1,000,000,000 股
        const sellImpact = market.calculatePriceImpact(sym, -1e9);
        assert.ok(
          sellImpact.deltaRatio >= -stock.maxImpact - 1e-9,
          `${sym} 巨量賣單打壓比例 (${sellImpact.deltaRatio}) 不得超過 -maxImpact`
        );
        assert.ok(
          sellImpact.execPrice >= sellImpact.postPrice,
          `${sym} 梯形積分均價應不小於 postPrice`
        );
      }
    });

    await t1.test('1.2 連續極端狂砸做空 100 次，價格恆大於等於 $0.01 (Penny Floor) 且不出現 NaN/負數', () => {
      const market = new MarketEngine(STOCKS_CONFIG);
      // 對流動性最淺的 MEME 進行連環狂砸
      for (let i = 0; i < 100; i++) {
        const impact = market.calculatePriceImpact('MEME', -10000000);
        market.commitPriceImpact('MEME', impact.postPrice);

        const currentPrice = market.getStock('MEME').price;
        assert.ok(Number.isFinite(currentPrice), `第 ${i + 1} 輪做空後市價必須為有限數字: ${currentPrice}`);
        assert.ok(currentPrice >= 0.01, `第 ${i + 1} 輪做空後市價 (${currentPrice}) 絕對不得跌破 0.01`);
        assert.ok(impact.execPrice >= 0.01, `第 ${i + 1} 輪成交均價 (${impact.execPrice}) 絕對不得跌破 0.01`);
      }

      const memePriceAfterDumping = market.getStock('MEME').price;
      console.log(`[價格衝擊底線] 100 輪連續巨單做空後 MEME 價格收斂於: $${memePriceAfterDumping} (因兩位小數四捨五入 0.03 * 0.85 = 0.0255 -> 0.03)`);
      assert.ok(memePriceAfterDumping >= 0.01, '連環砸盤市價絕對不低於 0.01');

      // 測試極限新聞暴跌至 0.01 時之絕對守門
      market.applyNewsShock('MEME', -99.9, 0, 15);
      const priceAtFloor = market.getStock('MEME').price;
      assert.strictEqual(priceAtFloor, 0.01, '暴跌後價格精確達到最低下限 0.01');

      // 達到 0.01 後再次做空衝擊，驗證絕對不跌破 0.01
      const floorImpact = market.calculatePriceImpact('MEME', -50000000);
      assert.strictEqual(floorImpact.postPrice, 0.01, '處於 0.01 底線時再次做空，市價仍嚴格鉗制在 0.01');
      assert.strictEqual(floorImpact.execPrice, 0.01, '處於 0.01 底線時再次做空，成交價仍嚴格鉗制在 0.01');
    });

    await t1.test('1.3 連續全倉狂買推升 100 次，價格有有限上限鉗制且無溢位/NaN', () => {
      const market = new MarketEngine(STOCKS_CONFIG);
      for (let i = 0; i < 100; i++) {
        const impact = market.calculatePriceImpact('NVTX', 10000000);
        market.commitPriceImpact('NVTX', impact.postPrice);

        const currentPrice = market.getStock('NVTX').price;
        assert.ok(Number.isFinite(currentPrice), `第 ${i + 1} 輪買進後市價必須為有限數: ${currentPrice}`);
        assert.ok(currentPrice <= 100000.0, `市價不超過天花板 100,000.00: ${currentPrice}`);
      }
    });
  });

  // =========================================================================
  // 2. 軋空與爆倉邊界：在超高波動迷因股 (MEME) 做空並注入爆漲新聞，驗證淨資產計算、強制平倉順序與無負數資產擊穿
  // =========================================================================
  await t.test('2. 軋空與爆倉邊界及負數資產擊穿 (穿倉) 檢驗', async (t2) => {
    await t2.test('2.1 MEME 開空後遭暴漲軋空，檢驗動態 MTM 淨資產計算與負數資產擊穿', () => {
      const room = createMockRoom();
      const player = createMockPlayer('p_short', 'BearRider', 1000000);
      room.players.set(player.id, player);

      // MEME 初始價 10.00，shortMarginInit = 1.5
      // 玩家做空 60,000 股
      const res = trading.processOrder(room, player, {
        stockSymbol: 'MEME',
        side: 'SHORT',
        shares: 60000
      });
      assert.strictEqual(res.success, true, '做空應成功');

      const cashAfterShort = player.cash;
      const frozenMargin = player.positions.MEME.frozenMargin;
      assert.ok(cashAfterShort >= 0, `保證金扣除後現金不應為負: ${cashAfterShort}`);
      assert.ok(frozenMargin > 0, `應有凍結保證金: ${frozenMargin}`);

      // 注入暴漲新聞 +300% (軋空狂飆至 $40+)
      room.newsEngine.injectNews(room, null, {
        symbol: 'MEME',
        shockPercent: 300,
        title: '【迷因狂熱】全球散戶瘋狂軋空！MEME 暴漲 300%',
        driftIntensity: 0.1,
        durationSec: 15
      });

      const memePriceAfterShock = room.marketEngine.getStock('MEME').price;
      assert.ok(memePriceAfterShock >= 30, `MEME 暴漲後價格應大幅提升: ${memePriceAfterShock}`);

      // 執行動態 Mark-to-Market 財務標記
      trading.updatePlayerFinancials(player, room.marketEngine.getPrices());

      console.log(`[軋空測試] 軋空後 MEME 市價: $${memePriceAfterShock}`);
      console.log(`[軋空測試] 玩家可用現金: $${player.cash}, 凍結保證金: $${player.frozenMargin}`);
      console.log(`[軋空測試] 玩家總淨資產 (netWorth): $${player.netWorth}`);

      // 【核心挑戰檢驗點】：在真實交易所或模擬遊戲中，若無爆倉強平 (Margin Call) 或穿倉保底，淨資產是否跌成負數？
      const isNegativeNetWorth = player.netWorth < 0;
      console.log(`[軋空測試] 淨資產是否跌破 0 擊穿穿倉: ${isNegativeNetWorth} (netWorth: ${player.netWorth})`);
    });

    await t2.test('2.2 爆倉狀態下終局強制平倉 (forceLiquidateAll)，驗證現金與淨資產是否出現負數擊穿 (Negative Cash Deficit)', () => {
      const room = createMockRoom();
      const player = createMockPlayer('p_short2', 'SuperBear', 1000000);
      room.players.set(player.id, player);

      // 做空 65,000 股 MEME
      trading.processOrder(room, player, { stockSymbol: 'MEME', side: 'SHORT', shares: 65000 });

      // 市場直接暴漲至 100 元 (10 倍暴漲)
      room.marketEngine.getStock('MEME').price = 100.0;

      const { rankings, winner } = trading.forceLiquidateAll(room, { MEME: 100.0 });

      console.log(`[爆倉強制平倉] 結算後玩家現金: $${player.cash}, 淨資產: $${player.netWorth}`);
      const isCashPenetrated = player.cash < 0;
      console.log(`[爆倉強制平倉] 結算後現金是否為負數 (穿倉擊穿): ${isCashPenetrated}`);

      // 依據「無負數資產擊穿」規格要求，結算現金與淨資產絕對不應小於 0
      assert.ok(player.cash >= 0, `【嚴重穿倉漏洞】終局平倉後玩家現金被擊穿為負數: $${player.cash}`);
      assert.ok(player.netWorth >= 0, `【嚴重穿倉漏洞】終局平倉後玩家淨資產被擊穿為負數: $${player.netWorth}`);
    });

    await t2.test('2.3 爆倉狀態下玩家手動平倉 (COVER)，驗證可用現金是否被扣成負數', () => {
      const room = createMockRoom();
      const player = createMockPlayer('p_short3', 'DesperateBear', 1000000);
      room.players.set(player.id, player);

      // 做空 65,000 股 MEME
      trading.processOrder(room, player, { stockSymbol: 'MEME', side: 'SHORT', shares: 65000 });

      // 市場暴漲至 80 元
      room.marketEngine.getStock('MEME').price = 80.0;

      // 玩家在暴漲後買回平倉 COVER
      const coverRes = trading.processOrder(room, player, {
        stockSymbol: 'MEME',
        side: 'COVER',
        shares: 65000
      });

      console.log(`[手動平倉測試] 平倉成功: ${coverRes.success}, 玩家剩餘現金: $${player.cash}`);
      assert.ok(player.cash >= 0, `【手動平倉穿倉漏洞】平倉後玩家現金擊穿為負數: $${player.cash}`);
    });
  });

  // =========================================================================
  // 3. 委託股數防禦：零股數、負數股數、浮點數小數股數、非整數股數委託下單防禦
  // =========================================================================
  await t.test('3. 委託股數非法輸入與邊界防禦測試 (Shares Validation)', async (t3) => {
    const room = createMockRoom();
    const player = createMockPlayer('p_validator', 'ValTester', 1000000);
    room.players.set(player.id, player);

    const testCases = [
      { name: '零股數 (0)', shares: 0, expectCode: 'INVALID_SHARES' },
      { name: '負整數股數 (-100)', shares: -100, expectCode: 'INVALID_SHARES' },
      { name: '負浮點數股數 (-0.5)', shares: -0.5, expectCode: 'INVALID_SHARES' },
      { name: '浮點數小數股數 (10.5)', shares: 10.5, expectCode: 'INVALID_SHARES' },
      { name: '浮點數小數股數 (1.5)', shares: 1.5, expectCode: 'INVALID_SHARES' },
      { name: '科學記號極小正小數 (1e-10)', shares: 1e-10, expectCode: 'INVALID_SHARES' },
      { name: '小於 1 之微小正浮點數 (0.75)', shares: 0.75, expectCode: 'INVALID_SHARES' },
      { name: '字串注入混合整數 ("10abc")', shares: "10abc", expectCode: 'INVALID_SHARES' },
      { name: '純非法字串 ("invalid")', shares: "invalid", expectCode: 'INVALID_SHARES' },
      { name: 'NaN 股數 (NaN)', shares: NaN, expectCode: 'INVALID_SHARES' },
      { name: '正無窮大 (Infinity)', shares: Infinity, expectCode: 'INVALID_SHARES' },
      { name: '空物件 ({})', shares: {}, expectCode: 'INVALID_SHARES' },
      { name: '空陣列 ([])', shares: [], expectCode: 'INVALID_SHARES' },
      { name: 'null 股數', shares: null, expectCode: 'INVALID_SHARES' },
      { name: 'undefined 股數', shares: undefined, expectCode: 'INVALID_SHARES' }
    ];

    for (const tc of testCases) {
      await t3.test(`防禦檢驗: ${tc.name}`, () => {
        const res = trading.processOrder(room, player, {
          stockSymbol: 'MEGA',
          side: 'BUY',
          shares: tc.shares
        });

        assert.strictEqual(
          res.success,
          false,
          `【安全漏洞】對於 ${tc.name} (輸入: ${JSON.stringify(tc.shares)}) 伺服器未予拒絕，竟成功下單！`
        );
        assert.strictEqual(
          res.code,
          tc.expectCode,
          `對於 ${tc.name} 應返回錯誤代碼 ${tc.expectCode}，實際返回: ${res.code}`
        );
      });
    }
  });

  // =========================================================================
  // 4. 精確浮點數守恆：經過數十輪買賣平倉後，比對全場玩家總資產與現金流，確認無浮點數累積誤差或資金幽靈增減
  // =========================================================================
  await t.test('4. 精確浮點數守恆與幽靈資金無中生有測試 (Conservation of Money)', async (t4) => {
    await t4.test('4.1 MEME 融券保證金計算之 pos.shortAvgPrice 幽靈資金暴賺檢驗', () => {
      const room = createMockRoom();
      const player = createMockPlayer('p_ghost', 'GhostExploiter', 1000000);
      room.players.set(player.id, player);

      const initialCash = player.cash; // 1,000,000

      // MEME 價格維持在 10 元，shortMarginInit 為 1.5 (150%)
      // 玩家做空 1,000 股
      const shortRes = trading.processOrder(room, player, {
        stockSymbol: 'MEME',
        side: 'SHORT',
        shares: 1000
      });
      assert.strictEqual(shortRes.success, true);

      const pos = player.positions.MEME;
      console.log(`[幽靈資金檢驗] MEME 融券成交價: $${shortRes.price}`);
      console.log(`[幽靈資金檢驗] pos.shortAvgPrice 記錄值: $${pos.shortAvgPrice}`);
      console.log(`[幽靈資金檢驗] pos.frozenMargin 凍結保證金: $${pos.frozenMargin}`);
      console.log(`[幽靈資金檢驗] 玩家下單後剩餘現金: $${player.cash}`);

      // 【漏洞判定】：若 shortAvgPrice 不是成交價格，而是加上了保證金 (1.5 倍)，則 shortAvgPrice 會變成 ~15 元！
      // 若市價維持不變，立即買回平倉 COVER 1,000 股：
      const coverRes = trading.processOrder(room, player, {
        stockSymbol: 'MEME',
        side: 'COVER',
        shares: 1000
      });
      assert.strictEqual(coverRes.success, true);

      console.log(`[幽靈資金檢驗] MEME 平倉買回價: $${coverRes.price}`);
      console.log(`[幽靈資金檢驗] 平倉後玩家現金: $${player.cash}`);

      // 由於下單會產生微量滑價，做空賣出價 <= 平倉買入價，正常交易一定會因為滑價略微虧損或持平，
      // 絕對不可能在市價未下跌的情況下「憑空暴賺數千元幽靈資金」！
      const profitFromNowhere = player.cash - initialCash;
      console.log(`[幽靈資金檢驗] 玩家淨損益 (cash - initialCash): $${profitFromNowhere}`);

      assert.ok(
        profitFromNowhere <= 0,
        `【嚴重金融漏洞: 幽靈資金增減】玩家在價格未下跌情況下做空並平倉 MEME，竟憑空獲利 $${profitFromNowhere}！(原因: shortAvgPrice 誤算入 1.5 倍保證金)`
      );
    });

    await t4.test('4.2 數十輪連續買賣平倉現金流對帳與浮點數無累積誤差 (Conservation of Cash Flow)', () => {
      const room = createMockRoom();
      const player = createMockPlayer('p_churn', 'HighFreqTrader', 1000000);
      room.players.set(player.id, player);

      let totalCashOutflow = 0;
      let totalCashInflow = 0;

      // 連續進行 50 輪現貨買進與全額賣出
      for (let round = 1; round <= 50; round++) {
        const cashBeforeBuy = player.cash;
        const buyRes = trading.processOrder(room, player, {
          stockSymbol: 'SOLR',
          side: 'BUY',
          shares: 50
        });
        assert.strictEqual(buyRes.success, true);
        const buyCost = cashBeforeBuy - player.cash;
        totalCashOutflow += buyCost;

        const cashBeforeSell = player.cash;
        const sellRes = trading.processOrder(room, player, {
          stockSymbol: 'SOLR',
          side: 'SELL',
          shares: 50
        });
        assert.strictEqual(sellRes.success, true);
        const sellRevenue = player.cash - cashBeforeSell;
        totalCashInflow += sellRevenue;

        // 驗證部位完全清空
        assert.strictEqual(player.positions.SOLR.longShares, 0);
        assert.strictEqual(player.positions.SOLR.avgCost, 0);

        // 驗證現金小數位數嚴格不超過 2 位 (無 0.00000000000001 浮點數污染)
        const cashStr = player.cash.toString();
        const decimalParts = cashStr.split('.')[1];
        if (decimalParts) {
          assert.ok(
            decimalParts.length <= 2,
            `第 ${round} 輪現金出現多餘小數精度污染: ${player.cash}`
          );
        }

        // 驗證淨資產等於現金
        trading.updatePlayerFinancials(player, room.marketEngine.getPrices());
        assert.strictEqual(player.netWorth, player.cash, `持倉清空時 netWorth 必須嚴格等於 cash`);
        assert.strictEqual(player.frozenMargin, 0, `無空單時 frozenMargin 必須為 0`);
      }

      console.log(`[50輪交易資產對帳] 總流出: $${totalCashOutflow.toFixed(2)}, 總流入: $${totalCashInflow.toFixed(2)}`);
      console.log(`[50輪交易資產對帳] 最終現金: $${player.cash}, 淨滑價成本: $${(1000000 - player.cash).toFixed(2)}`);
      assert.ok(player.cash > 0, '50輪交易後現金維持合理正數');
    });
  });
});
