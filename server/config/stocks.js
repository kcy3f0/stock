/**
/**
 * 股票市場初始標的組態 (Stock Universe Configuration)
 * 定義 4 檔具備反差性格、互補戰術特徵之股票標的
 * 依據 financial_models.md 與 PROJECT.md §2 規格定義
 */

export const STOCKS_CONFIG = {
  MEGA: {
    symbol: 'MEGA',
    name: '巨石金控 (Megalith Financial)',
    price: 100.00,
    basePrice: 100.00,
    depth: 300000,           // 流動性深度係數 D (股)
    tickVolatility: 0.0015,  // 每秒隨機波動率 sigma (0.15%)
    meanReversionKappa: 0.02,// OU 均值回歸係數 kappa
    anchorTheta: 100.00,     // 長期均值錨點 theta
    shortMarginInit: 1.0,    // 做空初始保證金率 (100%)
    shortMarginMaint: 1.2,   // 做空維持保證金率 (120%)
    maxImpact: 0.15,         // 單筆最大衝擊上限 (15%)
    type: 'BLUECHIP',
    description: '重裝防禦 / 大資金避風港。深度極厚，抗衝擊力最強，價格平穩不易暴漲暴跌。'
  },
  NVTX: {
    symbol: 'NVTX',
    name: '神經視界 (NeuroVortex AI)',
    price: 250.00,
    basePrice: 250.00,
    depth: 60000,            // 流動性深度係數 D (股)
    tickVolatility: 0.0050,  // 每秒隨機波動率 sigma (0.50%)
    meanReversionKappa: 0.005,// OU 均值回歸係數 kappa
    anchorTheta: 250.00,     // 長期均值錨點 theta
    shortMarginInit: 1.0,    // 做空初始保證金率 (100%)
    shortMarginMaint: 1.2,   // 做空維持保證金率 (120%)
    maxImpact: 0.15,         // 單筆最大衝擊上限 (15%)
    type: 'TECH',
    description: '主戰場 / 趨勢動能指標。高股價、中高流動性、對科技與財報事件極度敏感。'
  },
  SOLR: {
    symbol: 'SOLR',
    name: '太陽前鋒 (Solarpunk Energy)',
    price: 45.00,
    basePrice: 45.00,
    depth: 100000,           // 流動性深度係數 D (股)
    tickVolatility: 0.0035,  // 每秒隨機波動率 sigma (0.35%)
    meanReversionKappa: 0.06,// OU 均值回歸係數 kappa
    anchorTheta: 45.00,      // 長期均值錨點 theta
    shortMarginInit: 1.0,    // 做空初始保證金率 (100%)
    shortMarginMaint: 1.2,   // 做空維持保證金率 (120%)
    maxImpact: 0.15,         // 單筆最大衝擊上限 (15%)
    type: 'ENERGY',
    description: '波段箱型 / 均值回歸標的。具有強回歸特性，政策頒布時常有跳空大行情。'
  },
  MEME: {
    symbol: 'MEME',
    name: '火箭狂潮 (MoonRocket Inc.)',
    price: 10.00,
    basePrice: 10.00,
    depth: 15000,            // 流動性深度係數 D (股)
    tickVolatility: 0.0150,  // 每秒隨機波動率 sigma (1.50%)
    meanReversionKappa: 0.000,// OU 均值回歸係數 kappa (無均值回歸)
    anchorTheta: 10.00,      // 長期均值錨點 theta
    shortMarginInit: 1.5,    // 做空初始保證金率 (150%)
    shortMarginMaint: 1.35,  // 做空維持保證金率 (135%)
    maxImpact: 0.15,         // 單筆最大衝擊上限 (15%)
    type: 'MEME',
    description: '暴賺暴賠 / 軋空修羅場。深度極淺，大額買單引發火箭衝天，極易爆倉。'
  }
};

/**
 * 建立房間獨立之股票市場初始執行期狀態 (Deep Clone)
 * @returns {Record<string, Object>} 股票標的執行期資料物件字典
 */
export function createInitialStockState() {
  const state = {};
  for (const [symbol, config] of Object.entries(STOCKS_CONFIG)) {
    state[symbol] = {
      ...config,
      price: config.basePrice,
      open: config.basePrice,
      high: config.basePrice,
      low: config.basePrice,
      change: 0.0,
      changePercent: 0.0,
      driftMomentum: 0.0,     // 新聞事件注入之動能漂移項
      impactOffset: 0.0,      // 做市商彈性衰減之累積衝擊偏移
      history: [config.basePrice]
    };
  }
  return state;
}
