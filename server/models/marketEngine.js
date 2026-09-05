/**
 * 市場行情與做市商價格衝擊引擎 (Market Engine - M2)
 * 實作離散 GBM + OU 均值回歸隨機漫步、飽和非線性雙曲價格衝擊、滑價計算與做市商流動性彈性
 * 依據 financial_models.md §3, §4, §5 與 PROJECT.md §2 規格定義
 */

import { STOCKS_CONFIG, createInitialStockState } from '../config/stocks.js';

export class MarketEngine {
  /**
   * @param {Record<string, Object>} [customStocksConfig] 選擇性覆蓋之股票設定
   */
  constructor(customStocksConfig = null) {
    this.config = customStocksConfig || STOCKS_CONFIG;
    /** @type {Record<string, Object>} */
    this.stocks = createInitialStockState();
  }

  /**
   * 生成標準常態分佈隨機數 (Box-Muller Transform)
   * 數值穩定性：杜絕 u1 === 0 時之對數異常
   * @returns {number} Z ~ N(0, 1)
   */
  sampleStandardNormal() {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * 執行每秒 1 次的市場自然跳動 Tick
   * 整合 GBM (幾何布朗運動) + OU (奧恩斯坦-烏倫貝克均值回歸) + 新聞動能漂移衰減
   * @returns {Record<string, Object>} 更新後之股票最新狀態
   */
  tick() {
    const dt = 1.0;

    for (const [symbol, stock] of Object.entries(this.stocks)) {
      const z = this.sampleStandardNormal();
      const sigma = stock.tickVolatility || 0.005;
      const kappa = stock.meanReversionKappa !== undefined ? stock.meanReversionKappa : 0.01;
      const theta = stock.anchorTheta || stock.basePrice || 100.0;
      const currentP = stock.price;

      // 1. 均值回歸力矩項 (Logarithmic Mean Reversion)
      const meanRevTerm = kappa * (Math.log(theta) - Math.log(currentP));

      // 2. 突發新聞動能漂移項
      const driftTerm = stock.driftMomentum || 0.0;

      // 3. 伊藤修正項 (Itô Correction for unbiased log-normal expectation)
      const itoCorrection = -0.5 * sigma * sigma;

      // 4. 對數增量指數計算
      const exponent = (driftTerm + meanRevTerm + itoCorrection) * dt + sigma * Math.sqrt(dt) * z;
      let nextPrice = currentP * Math.exp(exponent);

      // 5. 邊界守門防禦：絕對底線 $0.01 (Penny Floor)，上限 $100,000.00
      nextPrice = Math.max(0.01, Math.min(100000.0, nextPrice));
      nextPrice = Math.round(nextPrice * 100) / 100;

      // 6. 衰減事件動能 (半衰期指數衰減，每秒衰減 15%)
      if (stock.driftMomentum) {
        stock.driftMomentum *= 0.85;
        if (Math.abs(stock.driftMomentum) < 0.0001) {
          stock.driftMomentum = 0.0;
        }
      }

      // 7. 做市商彈性回補 (Resilience Decay)
      if (stock.impactOffset) {
        stock.impactOffset *= 0.80;
        if (Math.abs(stock.impactOffset) < 0.0001) {
          stock.impactOffset = 0.0;
        }
      }

      // 8. 狀態寫入
      stock.price = nextPrice;
      stock.high = Math.max(stock.high, nextPrice);
      stock.low = Math.min(stock.low, nextPrice);
      stock.change = Number((nextPrice - stock.open).toFixed(2));
      stock.changePercent = Number(((stock.change / stock.open) * 100).toFixed(2));

      stock.history.push(nextPrice);
      if (stock.history.length > 60) {
        stock.history.shift();
      }
    }

    return this.stocks;
  }

  /**
   * 試算訂單價格衝擊與成交均價 (純函數試算，不修改市場內部狀態)
   * 飽和非線性模型: r = sgn(Q) * (|Q|/D)^0.8, delta = delta_max * tanh(r / delta_max)
   * 撮合均價: execPrice = prePrice * (1 + delta / 2)
   * @param {string} symbol 股票代碼
   * @param {number} sharesSigned 帶正負號之股數 (買入/回補為正，賣出/做空為負)
   * @returns {{ postPrice: number, execPrice: number, deltaRatio: number, slippage: number }}
   */
  calculatePriceImpact(symbol, sharesSigned) {
    const stock = this.stocks[symbol];
    if (!stock) {
      throw new Error(`找不到股票標的: ${symbol}`);
    }

    const prePrice = stock.price;
    const depth = stock.depth || 50000;
    const maxImpact = stock.maxImpact || 0.15; // 單筆最大衝擊 15%

    if (sharesSigned === 0) {
      return {
        postPrice: prePrice,
        execPrice: prePrice,
        deltaRatio: 0,
        slippage: 0
      };
    }

    const sign = sharesSigned > 0 ? 1 : -1;
    const absShares = Math.abs(sharesSigned);

    // 未飽和衝擊比率: (Q / D)^0.8
    const rawRatio = Math.pow(absShares / depth, 0.8);

    // 雙曲正切飽和鉗制
    const saturatedRatio = maxImpact * Math.tanh(rawRatio / maxImpact);
    const deltaRatio = sign * saturatedRatio;

    // 新市價 (符合 PROJECT.md 雙曲正切飽和上限 <= 15%)
    let postPrice = prePrice * (1 + deltaRatio);
    postPrice = Math.max(0.01, Math.min(100000.0, postPrice));
    postPrice = Math.round(postPrice * 100) / 100;

    // 撮合均價 (梯形積分與點差防禦，確保做市商無幽靈套利空間)
    let execPrice = prePrice * (1 + deltaRatio * 0.55);
    execPrice = Math.max(0.01, execPrice);
    execPrice = Math.round(execPrice * 100) / 100;

    const slippage = Math.round(Math.abs(execPrice - prePrice) * 100) / 100;

    return {
      postPrice,
      execPrice,
      deltaRatio,
      slippage
    };
  }

  /**
   * 提交確認訂單價格衝擊（將試算出的 postPrice 正式生效至市場）
   * @param {string} symbol 
   * @param {number} postPrice 
   */
  commitPriceImpact(symbol, postPrice) {
    const stock = this.stocks[symbol];
    if (!stock) return;

    stock.price = postPrice;
    stock.high = Math.max(stock.high, postPrice);
    stock.low = Math.min(stock.low, postPrice);
    stock.change = Number((postPrice - stock.open).toFixed(2));
    stock.changePercent = Number(((stock.change / stock.open) * 100).toFixed(2));

    stock.history.push(postPrice);
    if (stock.history.length > 60) {
      stock.history.shift();
    }
  }

  /**
   * 一鍵計算並執行訂單價格衝擊 (符合 PROJECT.md 契約)
   * @param {string} symbol 
   * @param {'BUY'|'SELL'|'SHORT'|'COVER'} side 
   * @param {number} shares 
   * @returns {{ executedPrice: number, newPrice: number, impactRatio: number }}
   */
  executePriceImpact(symbol, side, shares) {
    const signedShares = (side === 'BUY' || side === 'COVER') ? Math.abs(shares) : -Math.abs(shares);
    const impact = this.calculatePriceImpact(symbol, signedShares);
    this.commitPriceImpact(symbol, impact.postPrice);

    return {
      executedPrice: impact.execPrice,
      newPrice: impact.postPrice,
      impactRatio: impact.deltaRatio
    };
  }

  /**
   * 施加突發新聞跳空衝擊與動能漂移注入 (M3 介面)
   * @param {string} symbol 股票代號
   * @param {number} shockPercent 跳空百分比 (例如 -25 代表 -25%, +20 代表 +20%)
   * @param {number} [driftIntensity] 趨勢動能初速度 (每秒漂移率)
   * @param {number} [durationSec=15] 漂移衰減週期
   */
  applyNewsShock(symbol, shockPercent, driftIntensity, durationSec = 15) {
    const stock = this.stocks[symbol];
    if (!stock) return;

    const jumpRatio = shockPercent / 100.0;
    let newPrice = stock.price * (1 + jumpRatio);
    newPrice = Math.max(0.01, Math.min(100000.0, newPrice));
    newPrice = Math.round(newPrice * 100) / 100;

    stock.price = newPrice;
    stock.high = Math.max(stock.high, newPrice);
    stock.low = Math.min(stock.low, newPrice);
    stock.change = Number((newPrice - stock.open).toFixed(2));
    stock.changePercent = Number(((stock.change / stock.open) * 100).toFixed(2));
    stock.history.push(newPrice);
    if (stock.history.length > 60) {
      stock.history.shift();
    }

    // 重置均值回歸錨定價為跳空後價格
    stock.anchorTheta = newPrice;

    // 注入新聞動能趨勢
    if (driftIntensity !== undefined && driftIntensity !== null) {
      stock.driftMomentum = driftIntensity;
    } else {
      stock.driftMomentum = (jumpRatio / durationSec) * 1.5;
    }
  }

  /**
   * 取得單檔股票狀態
   * @param {string} symbol 
   */
  getStock(symbol) {
    if (!symbol || typeof symbol !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(this.stocks, symbol)) return null;
    const s = this.stocks[symbol];
    if (!s || typeof s !== 'object' || s.symbol !== symbol) return null;
    return s;
  }

  /**
   * 取得全市場股票即時狀態字典
   * @returns {Record<string, Object>}
   */
  getStocksState() {
    return this.stocks;
  }

  /**
   * 取得各股票當前公允報價快照
   * @returns {Record<string, number>}
   */
  getPrices() {
    const prices = {};
    for (const [sym, stock] of Object.entries(this.stocks)) {
      prices[sym] = stock.price;
    }
    return prices;
  }

  /**
   * 同步外部傳入的 marketState (若有外部直接修改)
   * @param {Record<string, Object>} externalState 
   */
  syncFromState(externalState) {
    if (!externalState) return;
    for (const [sym, s] of Object.entries(externalState)) {
      if (this.stocks[sym]) {
        Object.assign(this.stocks[sym], s);
      }
    }
  }
}
