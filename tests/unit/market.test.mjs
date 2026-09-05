/**
 * MarketEngine 單元測試: tests/unit/market.test.mjs
 * 驗證 Box-Muller 分佈、GBM+OU 隨機跳動、雙曲正切飽和價格衝擊、滑價計算與新聞衝擊
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine } from '../../server/models/marketEngine.js';
import { STOCKS_CONFIG } from '../../server/config/stocks.js';

test('MarketEngine 核心金融模型驗證', async (t) => {

  await t.test('Box-Muller 常態分佈取樣驗證 (Mean ~ 0, Variance ~ 1)', () => {
    const engine = new MarketEngine();
    const sampleSize = 2000;
    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < sampleSize; i++) {
      const z = engine.sampleStandardNormal();
      assert.ok(Number.isFinite(z), '常態隨機數必須為有限數字');
      assert.ok(!Number.isNaN(z), '常態隨機數不得為 NaN');
      sum += z;
      sumSq += z * z;
    }

    const mean = sum / sampleSize;
    const variance = (sumSq / sampleSize) - (mean * mean);

    // 均值應接近 0 (允許誤差 +- 0.15)
    assert.ok(Math.abs(mean) < 0.15, `標準常態均值應趨近於 0: mean=${mean}`);
    // 變異數應接近 1 (允許誤差 +- 0.2)
    assert.ok(Math.abs(variance - 1.0) < 0.20, `標準常態變異數應趨近於 1: var=${variance}`);
  });

  await t.test('初始標的池四檔股票參數完整性檢核', () => {
    const engine = new MarketEngine();
    const stocks = engine.getStocksState();

    const expectedSymbols = ['MEGA', 'NVTX', 'SOLR', 'MEME'];
    for (const sym of expectedSymbols) {
      const s = stocks[sym];
      assert.ok(s, `標的 ${sym} 應存在`);
      assert.strictEqual(s.symbol, sym);
      assert.ok(s.price > 0, `${sym} 初始價格應大於 0`);
      assert.ok(s.depth > 0, `${sym} 深度應大於 0`);
      assert.ok(s.tickVolatility > 0, `${sym} 波動率應大於 0`);
      assert.ok(Array.isArray(s.history), `${sym} history 應為陣列`);
    }
  });

  await t.test('秒級 Tick 自然隨機跳動與數值邊界守門', () => {
    const engine = new MarketEngine();
    const initialPrice = engine.getStock('NVTX').price;

    // 運行 30 個 tick
    for (let i = 0; i < 30; i++) {
      engine.tick();
      const n = engine.getStock('NVTX');
      assert.ok(n.price >= 0.01, '價格絕對不得跌破最低下限 $0.01');
      assert.ok(n.price <= 100000.0, '價格不得超過上限 $100,000.00');
      assert.ok(n.high >= n.price, 'high 應大於等於最新價');
      assert.ok(n.low <= n.price, 'low 應小於等於最新價');
      assert.strictEqual(typeof n.changePercent, 'number');
    }

    const currentPrice = engine.getStock('NVTX').price;
    assert.ok(currentPrice > 0, '經過 30 ticks 後價格應維持合法有效正數');
  });

  await t.test('雙曲正切飽和價格衝擊 (Price Impact) 與滑價計算', () => {
    const engine = new MarketEngine();
    const stock = engine.getStock('NVTX');
    const pPre = stock.price;

    // 1. 小單買入：衝擊溫和
    const smallImpact = engine.calculatePriceImpact('NVTX', 100);
    assert.ok(smallImpact.postPrice > pPre, '小買單應推升市價');
    assert.ok(smallImpact.execPrice > pPre, '小買單成交均價應高於前價');
    assert.ok(smallImpact.execPrice < smallImpact.postPrice, '撮合均價應小於新市價 (梯形積分)');
    assert.ok(smallImpact.deltaRatio > 0);

    // 2. 超大單買入：雙曲正切鉗制上限不得超過 maxImpact (15%)
    const hugeImpact = engine.calculatePriceImpact('NVTX', 1000000);
    assert.ok(hugeImpact.deltaRatio <= 0.150001, `單筆衝擊上限應被鉗制在 15% 內: ${hugeImpact.deltaRatio}`);
    assert.ok(hugeImpact.postPrice <= pPre * 1.1501, '新市價最大漲幅不超過 15%');

    // 3. 賣單衝擊：價格向下壓低
    const sellImpact = engine.calculatePriceImpact('NVTX', -500);
    assert.ok(sellImpact.postPrice < pPre, '賣單應壓低市價');
    assert.ok(sellImpact.execPrice < pPre, '賣單成交均價應低於前價');
    assert.ok(sellImpact.execPrice > sellImpact.postPrice, '賣單撮合均價應高於新市價');
  });

  await t.test('新聞跳空衝擊與動能漂移注入 (applyNewsShock)', () => {
    const engine = new MarketEngine();
    const meme = engine.getStock('MEME');
    const prePrice = meme.price;

    // 注入暴跌 25% 新聞衝擊
    engine.applyNewsShock('MEME', -25, -0.03, 15);

    const postPrice = meme.price;
    const expected = Math.round(prePrice * 0.75 * 100) / 100;
    assert.strictEqual(postPrice, expected, '新聞衝擊後價格應暴跌 25%');
    assert.strictEqual(meme.anchorTheta, postPrice, '均值錨點 theta 應重置為新價格');
    assert.strictEqual(meme.driftMomentum, -0.03, '應注入 -0.03 負向漂移動能');

    // 經過 1 個 tick，動能應衰減
    engine.tick();
    assert.ok(Math.abs(meme.driftMomentum) < 0.03, '漂移動能應逐步衰減');
  });

  await t.test('極端暴跌價格下限截斷防禦 ($0.01 Penny Floor)', () => {
    const engine = new MarketEngine();
    // 施加 -99.9% 毀滅性打擊
    engine.applyNewsShock('MEME', -99.9, -0.5, 5);
    // 連續巨大賣單打壓
    for (let i = 0; i < 20; i++) {
      const imp = engine.calculatePriceImpact('MEME', -100000);
      engine.commitPriceImpact('MEME', imp.postPrice);
    }

    const price = engine.getStock('MEME').price;
    assert.ok(price >= 0.01, `極限砸盤下價格恆大於等於 $0.01: ${price}`);
  });
});
