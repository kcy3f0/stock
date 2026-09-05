/**
 * 雙向交易撮合、保證金會計與強制平倉結算引擎 (Trading Engine - M4)
 * 實作現貨做多 (BUY / SELL)、融券做空 (SHORT / COVER)
 * 嚴格資金/保證金檢核防禦、Mark-to-Market 動態損益與終局公允市價強制平倉
 * 依據 financial_models.md §6, §7 與 PROJECT.md §4 規格定義
 */

export class TradingEngine {
  constructor() {}

  /**
   * 確保玩家在該股票之部位資料結構完整初始化
   * @param {Object} player 
   * @param {string} symbol 
   * @returns {Object} 玩家標的部位物件
   */
  ensurePosition(player, symbol) {
    if (!player.positions) {
      player.positions = {};
    }
    if (!player.positions[symbol]) {
      player.positions[symbol] = {
        longShares: 0,
        avgCost: 0,
        shortShares: 0,
        shortAvgPrice: 0,
        frozenMargin: 0
      };
    }
    return player.positions[symbol];
  }

  /**
   * 處理玩家下單撮合與帳戶原子更新
   * @param {Object} room 
   * @param {Object} player 
   * @param {Object} payload { stockSymbol, side, shares }
   * @returns {{ success: boolean, code?: string, message?: string, orderId?: string, symbol?: string, side?: string, shares?: number, price?: number, postPrice?: number }}
   */
  processOrder(room, player, payload = {}) {
    const { stockSymbol, side, shares } = payload;

    // 1. 遊戲狀態檢核：非 PLAYING 狀態嚴格禁止下單
    if (!room || room.status !== 'PLAYING') {
      return {
        success: false,
        code: 'MARKET_CLOSED',
        message: '目前非比賽進行狀態，無法下單'
      };
    }

    // 2. 標的合法性檢核
    const market = room.marketEngine;
    const stock = market
      ? market.getStock(stockSymbol)
      : (room.marketState && Object.prototype.hasOwnProperty.call(room.marketState, stockSymbol) ? room.marketState[stockSymbol] : null);

    if (!stock || typeof stock !== 'object' || stock.symbol !== stockSymbol) {
      return {
        success: false,
        code: 'INVALID_STOCK',
        message: `無效之股票代碼: ${stockSymbol}`
      };
    }

    // 3. 股數合法性檢核 (嚴格檢驗 Number.isInteger(shares) && shares > 0，拒絕浮點數、字串與非正整數)
    if (!Number.isInteger(shares) || shares <= 0 || shares > 10000000) {
      return {
        success: false,
        code: 'INVALID_SHARES',
        message: '下單股數必須為大於 0 之正整數且不可超過 10,000,000 股'
      };
    }
    const sharesNum = shares;

    const pos = this.ensurePosition(player, stockSymbol);

    // 4. 依照交易方向執行撮合與會計檢驗
    if (side === 'BUY') {
      // 現貨買入做多 (推升價格)
      const impact = market
        ? market.calculatePriceImpact(stockSymbol, sharesNum)
        : this._calcFallbackImpact(stock, sharesNum, 1);

      const executedPrice = impact.execPrice;
      const postPrice = impact.postPrice;
      const totalCost = Math.round(executedPrice * sharesNum * 100) / 100;

      // 資金可用性檢核
      if (player.cash < totalCost) {
        return {
          success: false,
          code: 'INSUFFICIENT_FUNDS',
          message: `可用現金不足 (需 $${totalCost.toLocaleString()}, 可用 $${player.cash.toLocaleString()})`
        };
      }

      // 原子提交市場衝擊與更新部位
      if (market) {
        market.commitPriceImpact(stockSymbol, postPrice);
      } else {
        stock.price = postPrice;
      }

      player.cash = Math.round((player.cash - totalCost) * 100) / 100;
      const totalShares = pos.longShares + sharesNum;
      pos.avgCost = Math.round(((pos.longShares * pos.avgCost + totalCost) / totalShares) * 100) / 100;
      pos.longShares = totalShares;

      player.tradeCount = (player.tradeCount || 0) + 1;
      player.lastTradeTime = Date.now();

      this.updatePlayerFinancials(player, market ? market.getPrices() : room.marketState);

      return {
        success: true,
        orderId: `ord_${Math.random().toString(36).slice(2, 9)}`,
        symbol: stockSymbol,
        side,
        shares: sharesNum,
        price: executedPrice,
        postPrice,
        message: '現貨買單成交'
      };

    } else if (side === 'SELL') {
      // 現貨賣出平倉 (壓低價格)
      if (pos.longShares < sharesNum) {
        return {
          success: false,
          code: 'INSUFFICIENT_SHARES',
          message: `現貨持股不足 (現有 ${pos.longShares} 股, 欲賣出 ${sharesNum} 股)`
        };
      }

      const impact = market
        ? market.calculatePriceImpact(stockSymbol, -sharesNum)
        : this._calcFallbackImpact(stock, sharesNum, -1);

      const executedPrice = impact.execPrice;
      const postPrice = impact.postPrice;
      const totalRevenue = Math.round(executedPrice * sharesNum * 100) / 100;

      if (market) {
        market.commitPriceImpact(stockSymbol, postPrice);
      } else {
        stock.price = postPrice;
      }

      player.cash = Math.round((player.cash + totalRevenue) * 100) / 100;
      pos.longShares -= sharesNum;
      if (pos.longShares === 0) {
        pos.avgCost = 0;
      }

      player.tradeCount = (player.tradeCount || 0) + 1;
      player.lastTradeTime = Date.now();

      this.updatePlayerFinancials(player, market ? market.getPrices() : room.marketState);

      return {
        success: true,
        orderId: `ord_${Math.random().toString(36).slice(2, 9)}`,
        symbol: stockSymbol,
        side,
        shares: sharesNum,
        price: executedPrice,
        postPrice,
        message: '現貨賣出成交'
      };

    } else if (side === 'SHORT') {
      // 融券開空 (壓低價格，需質押初始保證金)
      const impact = market
        ? market.calculatePriceImpact(stockSymbol, -sharesNum)
        : this._calcFallbackImpact(stock, sharesNum, -1);

      const executedPrice = impact.execPrice;
      const postPrice = impact.postPrice;
      const marginRatio = stock.shortMarginInit || 1.0; // 預設 100% 保證金率
      const requiredMargin = Math.round(executedPrice * sharesNum * marginRatio * 100) / 100;

      // 保證金充裕度檢核
      if (player.cash < requiredMargin) {
        return {
          success: false,
          code: 'INSUFFICIENT_MARGIN',
          message: `融券保證金不足 (需質押保證金 $${requiredMargin.toLocaleString()}, 可用現金 $${player.cash.toLocaleString()})`
        };
      }

      if (market) {
        market.commitPriceImpact(stockSymbol, postPrice);
      } else {
        stock.price = postPrice;
      }

      // 扣減現金至凍結保證金
      player.cash = Math.round((player.cash - requiredMargin) * 100) / 100;
      const totalShortShares = pos.shortShares + sharesNum;
      pos.shortAvgPrice = Math.round(((pos.shortShares * pos.shortAvgPrice + executedPrice * sharesNum) / totalShortShares) * 100) / 100;
      pos.shortShares = totalShortShares;
      pos.frozenMargin = Math.round((pos.frozenMargin + requiredMargin) * 100) / 100;

      player.tradeCount = (player.tradeCount || 0) + 1;
      player.lastTradeTime = Date.now();

      this.updatePlayerFinancials(player, market ? market.getPrices() : room.marketState);

      return {
        success: true,
        orderId: `ord_${Math.random().toString(36).slice(2, 9)}`,
        symbol: stockSymbol,
        side,
        shares: sharesNum,
        price: executedPrice,
        postPrice,
        message: '融券做空委託成交'
      };

    } else if (side === 'COVER') {
      // 融券買回平倉 (推升價格，釋放保證金並結算差額損益)
      if (pos.shortShares < sharesNum) {
        return {
          success: false,
          code: 'INSUFFICIENT_SHORT_POSITION',
          message: `融券空單部位不足 (現有空單 ${pos.shortShares} 股, 欲買回 ${sharesNum} 股)`
        };
      }

      const impact = market
        ? market.calculatePriceImpact(stockSymbol, sharesNum)
        : this._calcFallbackImpact(stock, sharesNum, 1);

      const executedPrice = impact.execPrice;
      const postPrice = impact.postPrice;

      if (market) {
        market.commitPriceImpact(stockSymbol, postPrice);
      } else {
        stock.price = postPrice;
      }

      // 按比例解凍保證金並計算盈虧
      const ratio = sharesNum / pos.shortShares;
      const releasedMargin = Math.round(pos.frozenMargin * ratio * 100) / 100;
      const shortProfitLoss = Math.round((pos.shortAvgPrice - executedPrice) * sharesNum * 100) / 100;
      const returnedCash = Math.round((releasedMargin + shortProfitLoss) * 100) / 100;

      // 穿倉保底防禦：現金絕對不低於 0
      player.cash = Math.max(0, Math.round((player.cash + returnedCash) * 100) / 100);
      pos.shortShares -= sharesNum;
      pos.frozenMargin = Math.max(0, Math.round((pos.frozenMargin - releasedMargin) * 100) / 100);

      if (pos.shortShares === 0) {
        pos.shortAvgPrice = 0;
        pos.frozenMargin = 0;
      }

      player.tradeCount = (player.tradeCount || 0) + 1;
      player.lastTradeTime = Date.now();

      this.updatePlayerFinancials(player, market ? market.getPrices() : room.marketState);

      return {
        success: true,
        orderId: `ord_${Math.random().toString(36).slice(2, 9)}`,
        symbol: stockSymbol,
        side,
        shares: sharesNum,
        price: executedPrice,
        postPrice,
        message: '融券平倉買回成交'
      };

    } else {
      return {
        success: false,
        code: 'INVALID_SIDE',
        message: `不支援之交易方向: ${side}`
      };
    }
  }

  /**
   * 即時標記市價 (Mark-to-Market) 計算玩家總淨資產與浮動損益
   * @param {Object} player 
   * @param {Record<string, number|Object>} marketPrices 股票現價字典
   */
  updatePlayerFinancials(player, marketPrices = {}) {
    let positionValue = 0;
    let shortUnrealizedPnl = 0;
    let totalFrozenMargin = 0;

    if (player.positions) {
      for (const [sym, pos] of Object.entries(player.positions)) {
        let currentPrice = 100;
        if (typeof marketPrices[sym] === 'number') {
          currentPrice = marketPrices[sym];
        } else if (marketPrices[sym] && typeof marketPrices[sym].price === 'number') {
          currentPrice = marketPrices[sym].price;
        } else if (pos.avgCost > 0) {
          currentPrice = pos.avgCost;
        }

        // 多頭市值
        if (pos.longShares > 0) {
          positionValue += pos.longShares * currentPrice;
        }

        // 空頭浮動損益與凍結保證金
        if (pos.shortShares > 0) {
          totalFrozenMargin += pos.frozenMargin;
          shortUnrealizedPnl += (pos.shortAvgPrice - currentPrice) * pos.shortShares;
        }
      }
    }

    const initialCash = player.initialCash || 1000000;
    player.frozenMargin = Math.round(totalFrozenMargin * 100) / 100;
    player.netWorth = Math.round((player.cash + totalFrozenMargin + positionValue + shortUnrealizedPnl) * 100) / 100;
    player.pnl = Math.round((player.netWorth - initialCash) * 100) / 100;
    player.pnlPercent = Number(((player.pnl / initialCash) * 100).toFixed(2));
  }

  /**
   * 限時倒數歸零終局全場強制平倉與排行榜結算
   * 規則：在最終公允市價 P_final 下零滑價強制平倉多空部位，全額變現為現金
   * @param {Object} room 
   * @param {Record<string, number|Object>} settlementPrices 最終固化市價字典
   * @returns {{ rankings: Array<Object>, winner: Object|null }}
   */
  forceLiquidateAll(room, settlementPrices = {}) {
    const rankingsList = [];

    for (const player of room.players.values()) {
      let finalCash = player.cash;

      if (player.positions) {
        for (const [sym, pos] of Object.entries(player.positions)) {
          let fairPrice = 100;
          if (typeof settlementPrices[sym] === 'number') {
            fairPrice = settlementPrices[sym];
          } else if (settlementPrices[sym] && typeof settlementPrices[sym].price === 'number') {
            fairPrice = settlementPrices[sym].price;
          } else if (pos.avgCost > 0) {
            fairPrice = pos.avgCost;
          }

          // 1. 多頭部位公允市價變現
          if (pos.longShares > 0) {
            finalCash += pos.longShares * fairPrice;
            pos.longShares = 0;
            pos.avgCost = 0;
          }

          // 2. 空頭部位公允市價回補，釋放保證金並結算盈虧 (若穿倉虧損超過保證金與現金總和，施加破產保護保底為 0)
          if (pos.shortShares > 0) {
            const shortPnl = (pos.shortAvgPrice - fairPrice) * pos.shortShares;
            finalCash = Math.max(0, Math.round((finalCash + pos.frozenMargin + shortPnl) * 100) / 100);
            pos.shortShares = 0;
            pos.shortAvgPrice = 0;
            pos.frozenMargin = 0;
          }
        }
      }

      // 終局穿倉保底防禦：若平倉後出現虧損穿倉，現金保底為 0 (有限責任與破產保護)
      player.cash = Math.max(0, Math.round(finalCash * 100) / 100);
      player.frozenMargin = 0;
      player.netWorth = Math.max(0, player.cash);
      const initial = player.initialCash || 1000000;
      player.pnl = Math.round((player.netWorth - initial) * 100) / 100;
      player.pnlPercent = Number(((player.pnl / initial) * 100).toFixed(2));

      rankingsList.push({
        playerId: player.id,
        playerName: player.name,
        finalCash: player.cash,
        netWorth: player.netWorth,
        pnl: player.pnl,
        returnRate: player.pnlPercent,
        pnlPercent: player.pnlPercent,
        tradeCount: player.tradeCount || 0,
        lastTradeTime: player.lastTradeTime || 0
      });
    }

    // Tie-Breaking 裁決：1. 淨資產由大到小 2. 交易筆數多者勝 3. 成交時間早者勝
    rankingsList.sort((a, b) => {
      if (b.netWorth !== a.netWorth) return b.netWorth - a.netWorth;
      if (b.tradeCount !== a.tradeCount) return b.tradeCount - a.tradeCount;
      return a.lastTradeTime - b.lastTradeTime;
    });

    const finalRankings = rankingsList.map((p, idx) => ({
      rank: idx + 1,
      ...p
    }));

    const winner = finalRankings[0] ? {
      name: finalRankings[0].playerName,
      netWorth: finalRankings[0].netWorth,
      returnRate: finalRankings[0].returnRate
    } : null;

    return {
      rankings: finalRankings,
      winner
    };
  }

  /**
   * 輔助後備衝擊計算 (當市場引擎未傳入時之保底計算)
   * @private
   */
  _calcFallbackImpact(stock, shares, sign) {
    const depth = stock.depth || 50000;
    const impactFactor = Math.tanh(shares / depth) * 0.15;
    const postPrice = Math.max(0.01, Math.round(stock.price * (1 + sign * impactFactor) * 100) / 100);
    const execPrice = Math.max(0.01, Math.round(stock.price * (1 + sign * impactFactor / 2) * 100) / 100);

    return {
      postPrice,
      execPrice,
      deltaRatio: sign * impactFactor
    };
  }
}
