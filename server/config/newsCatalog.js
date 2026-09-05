/**
 * 突發新聞事件資料庫 (News Event Catalog)
 * 涵蓋宏觀黑天鵝、產業板塊利多/利空、個股重大快訊
 * 依據 financial_models.md §5 與 PROJECT.md §3 規格定義
 */

export const NEWS_CATALOG = [
  // ----------------------------------------------------
  // 1. 宏觀經濟黑天鵝 / 利多 (Macro Shocks - Scope: 'ALL')
  // ----------------------------------------------------
  {
    id: 'EVT_MACRO_RATE_CUT',
    title: '【宏觀快訊】全球央行緊急降息 2 碼！流動性盛宴引爆全市場狂歡',
    content: '為防禦潛在衰退風險，主要央行聯手宣布緊急降息 50 基點，釋出數千億流動性，風險性資產迎來暴漲！',
    category: 'MACRO',
    scope: 'ALL',
    affectedSymbol: 'ALL',
    affectedSymbols: ['MEGA', 'NVTX', 'SOLR', 'MEME'],
    shockPercent: 15,
    stockShocks: {
      MEGA: 6,
      NVTX: 14,
      SOLR: 8,
      MEME: 22
    },
    driftIntensity: 0.015,
    durationSec: 15
  },
  {
    id: 'EVT_MACRO_CRASH',
    title: '【突發黑天鵝】重要航道突發軍事衝突，全球避險情緒急速升溫！',
    content: '全球關鍵能源海運航道爆發突發軍事交火，原油與原物料供應鏈嚴重受阻，全球股市爆發恐慌性拋售浪潮！',
    category: 'MACRO',
    scope: 'ALL',
    affectedSymbol: 'ALL',
    affectedSymbols: ['MEGA', 'NVTX', 'SOLR', 'MEME'],
    shockPercent: -15,
    stockShocks: {
      MEGA: -8,
      NVTX: -18,
      SOLR: -12,
      MEME: -28
    },
    driftIntensity: -0.020,
    durationSec: 15
  },
  {
    id: 'EVT_MACRO_INFLATION',
    title: '【宏觀警報】核心通膨數據意外衝高，市場預期緊縮循環重啟',
    content: '最新發布之核心通膨數據遠超市場預估上限，利率掉期市場預期恐將連續升息，成長股與投機標的重挫。',
    category: 'MACRO',
    scope: 'ALL',
    affectedSymbol: 'ALL',
    affectedSymbols: ['NVTX', 'MEME', 'SOLR', 'MEGA'],
    shockPercent: -12,
    stockShocks: {
      MEGA: -5,
      NVTX: -15,
      SOLR: -10,
      MEME: -20
    },
    driftIntensity: -0.012,
    durationSec: 12
  },

  // ----------------------------------------------------
  // 2. 科技股特異性事件 (NVTX - 神經視界)
  // ----------------------------------------------------
  {
    id: 'EVT_NVTX_BREAKTHROUGH',
    title: '【科技重磅】NVTX 宣布量子神經晶片算力突破千倍！',
    content: '神經視界發表新一代神經光子算力單元，能耗降低 90% 且算力提升千倍，全球雲端巨頭排隊包下三年產能！',
    category: 'EARNINGS',
    scope: 'STOCK',
    affectedSymbol: 'NVTX',
    affectedSymbols: ['NVTX'],
    shockPercent: 25,
    driftIntensity: 0.025,
    durationSec: 15
  },
  {
    id: 'EVT_NVTX_ANTITRUST',
    title: '【科技風暴】監管當局啟動反壟斷立案調查，NVTX 面臨巨額罰款',
    content: '反壟斷委員會與司法機關正式針對神經視界在算力晶片市場之定價行為發起聯合調查，股價應聲暴跌。',
    category: 'REGULATORY',
    scope: 'STOCK',
    affectedSymbol: 'NVTX',
    affectedSymbols: ['NVTX'],
    shockPercent: -20,
    driftIntensity: -0.020,
    durationSec: 12
  },
  {
    id: 'EVT_NVTX_BEAT',
    title: '【財報暴賺】NVTX 單季營收與獲利暴增 300%，獲全線評級調升！',
    content: '神經視界最新一季財報全線擊碎華爾街最樂觀預期，毛利率突破 80%，多家投行閃電調升目標價！',
    category: 'EARNINGS',
    scope: 'STOCK',
    affectedSymbol: 'NVTX',
    affectedSymbols: ['NVTX'],
    shockPercent: 20,
    driftIntensity: 0.018,
    durationSec: 10
  },

  // ----------------------------------------------------
  // 3. 迷因股狂熱與崩盤事件 (MEME - 火箭狂潮)
  // ----------------------------------------------------
  {
    id: 'EVT_MEME_SQUEEZE',
    title: '【妖股警報】WallStreetBets 散戶大軍發動軋空，MEME 火箭升空！',
    content: '知名社群論壇百萬散戶集結掃光市面上流通籌碼，對抗機構空頭，引發史詩級空頭踩踏回補！',
    category: 'EARNINGS',
    scope: 'STOCK',
    affectedSymbol: 'MEME',
    affectedSymbols: ['MEME'],
    shockPercent: 30,
    driftIntensity: 0.040,
    durationSec: 20
  },
  {
    id: 'EVT_MEME_SEC_RAID',
    title: '【SEC 突擊】監管機關清查迷因股操縱，相關概念股血崩！',
    content: '主管機關全面清查社群哄抬與內部人高點倒貨，MEME 面臨退市聽證與刑事訴訟風險，多頭全面潰逃。',
    category: 'REGULATORY',
    scope: 'STOCK',
    affectedSymbol: 'MEME',
    affectedSymbols: ['MEME'],
    shockPercent: -25,
    driftIntensity: -0.035,
    durationSec: 15
  },
  {
    id: 'EVT_MEME_RUGPULL',
    title: '【突發閃崩】MEME 創辦人錢包轉出數百萬籌碼，市場疑跑路恐慌',
    content: '區塊鏈鏈上偵測到專案創始人核心錢包大額解鎖轉帳，社群恐慌情緒蔓延，引發踩踏式無底限拋售！',
    category: 'REGULATORY',
    scope: 'STOCK',
    affectedSymbol: 'MEME',
    affectedSymbols: ['MEME'],
    shockPercent: -30,
    driftIntensity: -0.040,
    durationSec: 15
  },

  // ----------------------------------------------------
  // 4. 新能源板塊與個股事件 (SOLR - 太陽前鋒)
  // ----------------------------------------------------
  {
    id: 'EVT_SOLR_SUBSIDY',
    title: '【綠能利多】跨國清潔能源專項法案過審，SOLR 獲百億補貼！',
    content: '零碳新政重大法案獲議會閃電表決通過，太陽前鋒獲得百億美元專案租稅抵減與電網優先採購配額！',
    category: 'SECTOR',
    scope: 'STOCK',
    affectedSymbol: 'SOLR',
    affectedSymbols: ['SOLR'],
    shockPercent: 20,
    driftIntensity: 0.020,
    durationSec: 15
  },
  {
    id: 'EVT_SOLR_TARIFF',
    title: '【板塊重挫】關鍵太陽能原物料遭實施懲罰性關稅，成本暴增',
    content: '進出口主管機關無預警宣布對高純度光伏矽料實施 50% 懲罰性關稅，SOLR 產能成本暴增，毛利腰斬。',
    category: 'SECTOR',
    scope: 'STOCK',
    affectedSymbol: 'SOLR',
    affectedSymbols: ['SOLR'],
    shockPercent: -18,
    driftIntensity: -0.018,
    durationSec: 12
  },

  // ----------------------------------------------------
  // 5. 超級藍籌金融事件 (MEGA - 巨石金控)
  // ----------------------------------------------------
  {
    id: 'EVT_MEGA_FRAUD',
    title: '【金融地震】審計師辭職！巨石金控涉隱瞞海外衍生品巨虧',
    content: '獨立審計機構發表保留意見並集體辭職，巨石金控遭曝海外空殼公司存在數百億美元未申報衍生品虧損！',
    category: 'REGULATORY',
    scope: 'STOCK',
    affectedSymbol: 'MEGA',
    affectedSymbols: ['MEGA'],
    shockPercent: -16,
    driftIntensity: -0.015,
    durationSec: 15
  },
  {
    id: 'EVT_MEGA_DIVIDEND',
    title: '【藍籌驚喜】巨石金控宣布派發超額股利並啟動五百億庫藏股',
    content: '巨石金控資本適足率遠超監管要求，董事會全票通過派發史上最高現金股利並展開大規模股份回購註銷。',
    category: 'EARNINGS',
    scope: 'STOCK',
    affectedSymbol: 'MEGA',
    affectedSymbols: ['MEGA'],
    shockPercent: 10,
    driftIntensity: 0.008,
    durationSec: 10
  }
];
