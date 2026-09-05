/**
 * TradingEngine 單元測試: tests/unit/trading.test.mjs
 * 驗證現貨做多/賣出、融券做空/回補、保證金凍結解凍、損益動態標記市價與終局強制平倉結算
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../server/models/tradingEngine.js';
import { MarketEngine } from '../../server/models/marketEngine.js';

function createMockRoom() {
  const marketEngine = new MarketEngine();
  const room = {
    roomCode: 'TEST99',
    status: 'PLAYING',
    marketEngine,
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
    positions: {}
  };
}

test('TradingEngine 雙向交易與會計模型單元測試', async (t) => {
  const engine = new TradingEngine();

  await t.test('現貨買入做多 (BUY) 正常成交與均價計算', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Alice');

    // 買入 200 股 NVTX
    const res = engine.processOrder(room, player, {
      stockSymbol: 'NVTX',
      side: 'BUY',
      shares: 200
    });

    assert.strictEqual(res.success, true, '買單應成功');
    assert.strictEqual(res.shares, 200);
    assert.ok(res.price > 0);
    assert.ok(player.cash < 1000000, '現金應扣除');
    assert.strictEqual(player.positions.NVTX.longShares, 200, '多頭持股應為 200 股');
    assert.strictEqual(player.positions.NVTX.avgCost, res.price, '初始均價應等於成交價');
  });

  await t.test('可用現金不足拒單防禦 (INSUFFICIENT_FUNDS)', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Alice', 500); // 只有 $500

    const res = engine.processOrder(room, player, {
      stockSymbol: 'NVTX',
      side: 'BUY',
      shares: 100 // 需數萬元
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'INSUFFICIENT_FUNDS');
    assert.strictEqual(player.cash, 500, '失敗不應扣減現金');
  });

  await t.test('現貨賣出平倉 (SELL) 與持股清空', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Alice');

    // 先買入 100 股
    engine.processOrder(room, player, { stockSymbol: 'SOLR', side: 'BUY', shares: 100 });
    const cashAfterBuy = player.cash;

    // 賣出 100 股
    const sellRes = engine.processOrder(room, player, { stockSymbol: 'SOLR', side: 'SELL', shares: 100 });
    assert.strictEqual(sellRes.success, true);
    assert.strictEqual(player.positions.SOLR.longShares, 0, '持股應歸零');
    assert.strictEqual(player.positions.SOLR.avgCost, 0, '均價應重置為 0');
    assert.ok(player.cash > cashAfterBuy, '賣出後現金應回補');
  });

  await t.test('未持股賣出防禦 (INSUFFICIENT_SHARES)', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Alice');

    const res = engine.processOrder(room, player, { stockSymbol: 'SOLR', side: 'SELL', shares: 50 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'INSUFFICIENT_SHARES');
  });

  await t.test('融券做空 (SHORT) 質押保證金與部位建立', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Bob');

    const res = engine.processOrder(room, player, {
      stockSymbol: 'MEME',
      side: 'SHORT',
      shares: 500
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(player.positions.MEME.shortShares, 500, '做空部位應為 500 股');
    assert.ok(player.positions.MEME.frozenMargin > 0, '應凍結保證金');
    assert.ok(player.cash < 1000000, '現金應扣除質押保證金');
  });

  await t.test('保證金不足做空防禦 (INSUFFICIENT_MARGIN)', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Bob', 100); // 只有 $100

    const res = engine.processOrder(room, player, {
      stockSymbol: 'NVTX',
      side: 'SHORT',
      shares: 100 // 需數萬元保證金
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'INSUFFICIENT_MARGIN');
  });

  await t.test('融券回補平倉 (COVER) 釋放保證金並結算盈虧', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Bob');

    // 開空 200 股 MEME
    engine.processOrder(room, player, { stockSymbol: 'MEME', side: 'SHORT', shares: 200 });
    assert.strictEqual(player.positions.MEME.shortShares, 200);

    // 買回平倉 200 股
    const coverRes = engine.processOrder(room, player, { stockSymbol: 'MEME', side: 'COVER', shares: 200 });
    assert.strictEqual(coverRes.success, true);
    assert.strictEqual(player.positions.MEME.shortShares, 0, '空單部位應歸零');
    assert.strictEqual(player.positions.MEME.frozenMargin, 0, '保證金應全數解凍歸零');
  });

  await t.test('無空單部位買回平倉防禦 (INSUFFICIENT_SHORT_POSITION)', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Bob');

    const res = engine.processOrder(room, player, { stockSymbol: 'MEME', side: 'COVER', shares: 100 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'INSUFFICIENT_SHORT_POSITION');
  });

  await t.test('動態標記市價 (Mark-to-Market) 損益與總淨資產計算', () => {
    const room = createMockRoom();
    const player = createMockPlayer('p1', 'Alice', 500000);

    // 買入 100 股 NVTX (成本設為 250)
    player.positions.NVTX = { longShares: 100, avgCost: 250, shortShares: 0, shortAvgPrice: 0, frozenMargin: 0 };
    player.cash = 475000;

    // 做空 500 股 SOLR (開空價 50, 保證金 25000)
    player.positions.SOLR = { longShares: 0, avgCost: 0, shortShares: 500, shortAvgPrice: 50, frozenMargin: 25000 };
    player.cash -= 25000; // 450,000 可用現金

    // 市場現價變動：NVTX 漲至 280 (+30/股), SOLR 跌至 40 (+10/股 做空獲利)
    const marketPrices = {
      NVTX: 280,
      SOLR: 40
    };

    engine.updatePlayerFinancials(player, marketPrices);

    // 預期淨資產 = Cash(450,000) + FrozenMargin(25,000) + LongValue(100*280=28,000) + ShortPnL(500*(50-40)=5,000) = 508,000
    assert.strictEqual(player.netWorth, 508000, `動態淨資產應為 $508,000: actual=${player.netWorth}`);
    assert.strictEqual(player.pnl, 8000, `累計總獲利應為 $8,000: actual=${player.pnl}`);
    assert.strictEqual(player.pnlPercent, 1.6, `回報率應為 1.6%: actual=${player.pnlPercent}`);
  });

  await t.test('終局強制平倉 (forceLiquidateAll) 與公允市價清算排行榜', () => {
    const room = createMockRoom();
    const p1 = createMockPlayer('p1', 'Winner', 1000000);
    const p2 = createMockPlayer('p2', 'Loser', 1000000);
    room.players.set('p1', p1);
    room.players.set('p2', p2);

    // p1 做多 1000 股 NVTX (成本 250)
    p1.positions.NVTX = { longShares: 1000, avgCost: 250, shortShares: 0, shortAvgPrice: 0, frozenMargin: 0 };
    p1.cash = 750000;

    // p2 做空 1000 股 NVTX (均價 250, 保證金 250000)
    p2.positions.NVTX = { longShares: 0, avgCost: 0, shortShares: 1000, shortAvgPrice: 250, frozenMargin: 250000 };
    p2.cash = 750000;

    // 結算市價：NVTX 飆升至 300
    const settlementPrices = { NVTX: 300 };

    const { rankings, winner } = engine.forceLiquidateAll(room, settlementPrices);

    // p1 最終現金 = 750,000 + 1000 * 300 = 1,050,000
    assert.strictEqual(p1.cash, 1050000, 'p1 結算後現金應為 1,050,000');
    assert.strictEqual(p1.positions.NVTX.longShares, 0, 'p1 多頭部位應清空');

    // p2 最終現金 = 750,000 + 250,000 + 1000 * (250 - 300) = 1,000,000 - 50,000 = 950,000
    assert.strictEqual(p2.cash, 950000, 'p2 結算後現金應為 950,000');
    assert.strictEqual(p2.positions.NVTX.shortShares, 0, 'p2 空頭部位應清空');

    // 排行榜檢驗
    assert.strictEqual(rankings.length, 2);
    assert.strictEqual(rankings[0].playerId, 'p1');
    assert.strictEqual(rankings[0].rank, 1);
    assert.strictEqual(rankings[1].playerId, 'p2');
    assert.strictEqual(rankings[1].rank, 2);

    assert.ok(winner);
    assert.strictEqual(winner.name, 'Winner');
    assert.strictEqual(winner.netWorth, 1050000);
  });
});
