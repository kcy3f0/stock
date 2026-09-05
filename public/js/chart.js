/**
 * HTML5 Canvas 2D 走勢圖引擎 (StockChart Engine)
 * 支援 60FPS 動態繪圖、Retina 高清適配、分時折線圖（漸層填充）與 K 線蠟燭圖模式
 */

export class StockChart {
  /**
   * @param {HTMLCanvasElement} canvas 
   * @param {Object} options 
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = Object.assign({
      mode: 'line', // 'line' | 'candle'
      colorUp: '#00f090',
      colorDown: '#ff3366',
      gridColor: 'rgba(35, 49, 77, 0.6)',
      textColor: '#94a3b8',
      fontMono: '11px "JetBrains Mono", monospace',
      padding: { top: 25, right: 65, bottom: 25, left: 15 },
      maxPoints: 120 // 圖表上最多顯示的歷史點數
    }, options);

    // 數據序列
    this.priceHistory = []; // Array<{ timestamp, price, volume }>
    this.candles = [];      // Array<{ timestamp, open, high, low, close, volume }>
    this.currentPrice = 150.00;

    // 內部繪圖快取尺寸
    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;

    // 十字游標交互狀態
    this.mousePos = null; // { x, y }

    this.init();
  }

  init() {
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());

    // 監聽滑鼠移動以呈現十字游標
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      this.render();
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mousePos = null;
      this.render();
    });
  }

  handleResize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);

    this.render();
  }

  /**
   * 切換顯示模式 ('line' 或 'candle')
   * @param {'line'|'candle'} mode 
   */
  setMode(mode) {
    if (mode === 'line' || mode === 'candle') {
      this.options.mode = mode;
      this.render();
    }
  }

  /**
   * 設定全新數據集
   * @param {Array} priceHistory 
   * @param {Array} candles 
   */
  setData(priceHistory = [], candles = []) {
    // 兼容純數值陣列 [150, 150.25] 與物件陣列 [{ price: 150 }]，徹底杜絕 NaN
    this.priceHistory = (Array.isArray(priceHistory) ? priceHistory : [])
      .map(item => {
        const price = typeof item === 'number' ? item : (item && typeof item.price === 'number' ? item.price : 0);
        const validPrice = Number.isFinite(price) ? price : 0;
        const timestamp = (item && typeof item === 'object' && typeof item.timestamp === 'number') ? item.timestamp : Date.now();
        return { timestamp, price: validPrice };
      })
      .slice(-this.options.maxPoints);

    this.candles = (Array.isArray(candles) ? candles : []).slice(-this.options.maxPoints);

    if (this.priceHistory.length > 0) {
      const last = this.priceHistory[this.priceHistory.length - 1];
      this.currentPrice = (last && Number.isFinite(last.price)) ? last.price : 0;
    }
    this.render();
  }

  /**
   * 插入最新即時 Tick
   * @param {{ timestamp: number, price: number, volume?: number }|number} tick 
   * @param {{ timestamp: number, open: number, high: number, low: number, close: number, volume?: number }} [candle]
   */
  addTick(tick, candle) {
    let normalizedTick = tick;
    if (typeof tick === 'number') {
      normalizedTick = { timestamp: Date.now(), price: tick };
    }
    if (!normalizedTick || typeof normalizedTick.price !== 'number' || isNaN(normalizedTick.price)) return;

    this.priceHistory.push(normalizedTick);
    if (this.priceHistory.length > this.options.maxPoints) {
      this.priceHistory.shift();
    }
    this.currentPrice = normalizedTick.price;

    if (candle) {
      // 若該分鐘/秒級 K 線已存在則更新，若跨週期則新增
      const lastCandle = this.candles[this.candles.length - 1];
      if (lastCandle && lastCandle.timestamp === candle.timestamp) {
        this.candles[this.candles.length - 1] = candle;
      } else {
        this.candles.push(candle);
        if (this.candles.length > this.options.maxPoints) {
          this.candles.shift();
        }
      }
    }

    this.render();
  }

  /**
   * 核心 Canvas 渲染管線
   */
  render() {
    if (!this.width || !this.height) return;

    const ctx = this.ctx;
    const { top, right, bottom, left } = this.options.padding;
    const plotW = this.width - left - right;
    const plotH = this.height - top - bottom;

    // 清空背景
    ctx.clearRect(0, 0, this.width, this.height);

    // 取得數據範圍
    const { minVal, maxVal } = this.calculatePriceRange();
    const valRange = maxVal - minVal || 1;

    // 座標轉換輔助函數
    const getX = (idx, total) => {
      if (total <= 1) return left + plotW / 2;
      return left + (idx / (total - 1)) * plotW;
    };
    const getY = (val) => {
      return top + plotH - ((val - minVal) / valRange) * plotH;
    };

    // 1. 繪製參考網格與座標標籤
    this.drawGridAndAxes(ctx, left, top, plotW, plotH, minVal, maxVal, getY);

    // 2. 根據模式繪製主要圖表
    if (this.options.mode === 'candle' && this.candles.length > 0) {
      this.drawCandlesticks(ctx, left, top, plotW, plotH, minVal, maxVal, getY);
    } else {
      this.drawLineChart(ctx, left, top, plotW, plotH, minVal, maxVal, getX, getY);
    }

    // 3. 繪製最新價格橫向虛線標尺與右側標籤
    this.drawCurrentPriceLine(ctx, left, plotW, right, getY(this.currentPrice));

    // 4. 繪製滑鼠懸停 Crosshair (十字游標)
    if (this.mousePos && this.mousePos.x >= left && this.mousePos.x <= left + plotW &&
        this.mousePos.y >= top && this.mousePos.y <= top + plotH) {
      this.drawCrosshair(ctx, left, top, plotW, plotH, minVal, maxVal);
    }
  }

  /**
   * 計算當前數據集之最高最低價（包含 5% 內縮邊距）
   */
  calculatePriceRange() {
    let min = Infinity;
    let max = -Infinity;

    if (this.options.mode === 'candle' && this.candles.length > 0) {
      for (const c of this.candles) {
        if (c.low < min) min = c.low;
        if (c.high > max) max = c.high;
      }
    } else if (this.priceHistory.length > 0) {
      for (const p of this.priceHistory) {
        if (p.price < min) min = p.price;
        if (p.price > max) max = p.price;
      }
    } else {
      min = this.currentPrice * 0.95;
      max = this.currentPrice * 1.05;
    }

    if (!isFinite(min) || !isFinite(max) || min === max) {
      min = this.currentPrice * 0.98;
      max = this.currentPrice * 1.02;
    }

    const padding = (max - min) * 0.08 || 1;
    return {
      minVal: Math.max(0.01, min - padding),
      maxVal: max + padding
    };
  }

  /**
   * 繪製網格線與價格標籤
   */
  drawGridAndAxes(ctx, left, top, plotW, plotH, minVal, maxVal, getY) {
    ctx.save();
    ctx.strokeStyle = this.options.gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);

    const steps = 5;
    ctx.font = this.options.fontMono;
    ctx.fillStyle = this.options.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= steps; i++) {
      const price = minVal + (i / steps) * (maxVal - minVal);
      const y = Math.round(getY(price));

      // 橫向網格線
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();

      // 右側價格文字刻度
      const formattedPrice = price >= 100 ? price.toFixed(2) : (price >= 1 ? price.toFixed(2) : price.toFixed(4));
      ctx.fillText(`$${formattedPrice}`, left + plotW + 8, y);
    }

    // 繪製縱向時間網格線 (4條)
    for (let j = 1; j < 4; j++) {
      const x = Math.round(left + (j / 4) * plotW);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 繪製分時折線圖 (含微光外邊框與下方漸層填充)
   */
  drawLineChart(ctx, left, top, plotW, plotH, minVal, maxVal, getX, getY) {
    const data = this.priceHistory;
    if (data.length === 0) return;

    const total = data.length;
    const isUp = total > 1 ? data[total - 1].price >= data[0].price : true;
    const strokeColor = isUp ? this.options.colorUp : this.options.colorDown;

    ctx.save();

    // 1. 下方漸層填充
    const grad = ctx.createLinearGradient(0, top, 0, top + plotH);
    if (isUp) {
      grad.addColorStop(0, 'rgba(0, 240, 144, 0.28)');
      grad.addColorStop(1, 'rgba(0, 240, 144, 0.00)');
    } else {
      grad.addColorStop(0, 'rgba(255, 51, 102, 0.28)');
      grad.addColorStop(1, 'rgba(255, 51, 102, 0.00)');
    }

    ctx.beginPath();
    ctx.moveTo(getX(0, total), top + plotH);
    for (let i = 0; i < total; i++) {
      const x = getX(i, total);
      const y = getY(data[i].price);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(getX(total - 1, total), top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 2. 主趨勢曲線
    ctx.beginPath();
    for (let i = 0; i < total; i++) {
      const x = getX(i, total);
      const y = getY(data[i].price);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = strokeColor;
    ctx.shadowBlur = 8;
    ctx.stroke();

    // 3. 最新價格端點動態高亮圓點
    const lastX = getX(total - 1, total);
    const lastY = getY(data[total - 1].price);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = strokeColor;
    ctx.shadowBlur = 12;
    ctx.fill();

    ctx.restore();
  }

  /**
   * 繪製 K 線蠟燭圖 (Candlesticks)
   */
  drawCandlesticks(ctx, left, top, plotW, plotH, minVal, maxVal, getY) {
    const data = this.candles;
    if (data.length === 0) return;

    const total = data.length;
    const candleWidth = Math.max(3, Math.min(18, Math.floor((plotW / total) * 0.75)));
    const step = plotW / Math.max(1, total);

    ctx.save();

    for (let i = 0; i < total; i++) {
      const c = data[i];
      const centerX = left + i * step + step / 2;
      const isGreen = c.close >= c.open;
      const color = isGreen ? this.options.colorUp : this.options.colorDown;

      const yHigh = getY(c.high);
      const yLow = getY(c.low);
      const yOpen = getY(c.open);
      const yClose = getY(c.close);

      // 繪製最高最低影線
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(Math.round(centerX), Math.round(yHigh));
      ctx.lineTo(Math.round(centerX), Math.round(yLow));
      ctx.stroke();

      // 繪製蠟燭實體
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
      const bodyLeft = Math.round(centerX - candleWidth / 2);

      ctx.fillStyle = color;
      ctx.fillRect(bodyLeft, Math.round(bodyTop), candleWidth, Math.round(bodyHeight));
    }

    ctx.restore();
  }

  /**
   * 繪製當前最新市價橫向虛線與右側跳動標籤
   */
  drawCurrentPriceLine(ctx, left, plotW, right, currentY) {
    if (isNaN(currentY)) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    ctx.moveTo(left, currentY);
    ctx.lineTo(left + plotW, currentY);
    ctx.stroke();

    // 右側標籤框
    const badgeW = 60;
    const badgeH = 20;
    const badgeX = left + plotW + 2;
    const badgeY = currentY - badgeH / 2;

    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`$${this.currentPrice.toFixed(2)}`, badgeX + badgeW / 2, currentY);

    ctx.restore();
  }

  /**
   * 繪製滑鼠 Crosshair 交叉線與數值提示
   */
  drawCrosshair(ctx, left, top, plotW, plotH, minVal, maxVal) {
    const { x, y } = this.mousePos;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    // 垂直線
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();

    // 水平線
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
    ctx.stroke();

    // 計算指針處價格
    const priceAtCursor = maxVal - ((y - top) / plotH) * (maxVal - minVal);
    const badgeW = 60;
    const badgeH = 18;

    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(left + plotW + 2, y - badgeH / 2, badgeW, badgeH);

    ctx.font = this.options.fontMono;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`$${priceAtCursor.toFixed(2)}`, left + plotW + 2 + badgeW / 2, y);

    ctx.restore();
  }
}
