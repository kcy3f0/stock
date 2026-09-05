# Project: Discord 回合制多人股市對戰

> 現行版本採「同步交易回合」：所有玩家在每回合固定時間內自由交易，盤中價格與排名不公開；倒數結束後才批次揭曉行情、新聞與排行榜。Discord Bot 是主要入口，網頁 WebSocket 入口保留相容使用。

## Current gameplay

- 房主設定 1–50 個回合、每回合 10–300 秒與初始資金。
- 每回合內所有玩家可不限次使用 BUY、SELL、SHORT、COVER。
- 個人成交回報立即私下提供；全房行情、新聞及排名只在回合結束公開一次。
- 最後一輪揭曉後，以最終公允價強制平倉並公布冠軍。
- Discord 使用單一 `/stock` 斜線指令與 create、join、start、trade、market、portfolio、status、help 子指令。

## Architecture
本專案為高效能、低延遲多人即時股票交易對戰模擬系統，採用權威伺服器 (Authoritative Server) 與雙向低延遲 WebSocket 架構。

### 1. 系統分層架構
- **伺服器端 (Server Runtime)**: Node.js (ESM, v24.19.0)
  - `server/server.js`: 整合原生 `node:http` 靜態檔案伺服與 `ws` WebSocket 協定分發，處理連線生命週期與訊息路由。
  - `server/models/roomManager.js`: 房間大廳狀態機管理（WAITING, PLAYING, SETTLING, FINISHED）、玩家加入/離開、定時廣播與計時器。
  - `server/models/marketEngine.js`: 4 檔差異化標的 (MEGA, NVTX, SOLR, MEME)、秒級離散 GBM+OU 隨機漫步、做市商流動性與雙曲正切飽和價格衝擊與滑價模型。
  - `server/models/newsEngine.js`: 突發新聞事件庫（宏觀、板塊、個股黑天鵝）、定時/隨機觸發器、即時跳空衝擊與指數衰減趨勢漂移。
  - `server/models/tradingEngine.js`: 現貨做多、融券做空保證金會計、浮動損益計算、倒數歸零自動強制平倉與淨資產結算。
- **客戶端 (Client Frontend)**: 零構建輕量 SPA (HTML5 + CSS3 + Vanilla ES Modules)
  - `public/index.html`: 沉浸式深色財經終端 UI，整合大廳、走勢圖、標的切換、資產儀表板、交易下單面板、即時新聞跑馬燈、即時排行榜與結算頒獎模態框。
  - `public/js/chart.js`: 高效能 HTML5 Canvas 2D 60FPS 走勢圖引擎，支援秒級折線/K線模式、均線與歷史軌跡。
  - `public/js/app.js`: WebSocket 客戶端狀態管理、心跳保活、下單互動與事件渲染。
  - `public/css/style.css`: 專業終端暗色主題、響應式佈局與動態跳空/新聞視覺反饋。
- **測試軌道 (Testing Track)**:
  - `tests/e2e/bot_harness.mjs`: 基於 Node 24 原生 WebSocket 之多機器人併發客戶端引擎，模擬 3+ 機器人加入同房進行高頻多空搏殺與結算驗證。

---

## Feature Inventory
所有自 Phase 0 調研萃取之功能特性盤點如下，全數對應至相應里程碑：

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | 房間大廳與房間建立 | 建立自訂時長房間、產生 4-6 碼房間代碼、房主控制遊戲開始 | M1 | ORIGINAL_REQUEST §R1 |
| 2 | 多人加入與同房連線 | 多玩家跨視窗/分頁透過房間代碼加入同房間，維護玩家清單 | M1 | ORIGINAL_REQUEST §R1 |
| 3 | WebSocket 低延遲雙向通訊 | 前後端 JSON 協定雙向通訊，傳遞心跳、操作意圖與全域狀態廣播 | M1 | ORIGINAL_REQUEST §R1 |
| 4 | 前端操作面板與大廳 UI | 大廳介面、房間列表、自訂時長、加入介面與連線狀態指示 | M1 | ORIGINAL_REQUEST §R1 |
| 5 | 多股票標的池配置 | 內建 4 檔具反差性格之股票 (MEGA藍籌, NVTX科技, SOLR新能源, MEME迷因) | M2 | ORIGINAL_REQUEST §R2 |
| 6 | 秒級 Tick 市場動態引擎 | 每秒 1 tick 離散隨機跳動，幾何布朗運動結合 OU 均值回歸，保證價格恆正 | M2 | ORIGINAL_REQUEST §R2 |
| 7 | 做市商流動性模型 | 系統自動做市保證流動性永遠充足，小房間 (2-8人) 亦能即時成交 | M2 | ORIGINAL_REQUEST §R2 |
| 8 | 量化價格衝擊 (Price Impact) | 買單推升股價、賣單打壓股價，訂單量越大衝擊越大，具雙曲正切飽和限制 | M2 | ORIGINAL_REQUEST §R2 |
| 9 | 撮合滑價 (Slippage) 計算 | 依下單規模與流動性深度計算梯形積分成交均價，非固定價成交 | M2 | ORIGINAL_REQUEST §R2 |
| 10 | 1秒內全房即時行情同步廣播 | 每次價格變動在 1 秒內同步推播至房間全體玩家 | M2 | ORIGINAL_REQUEST AC |
| 11 | Canvas 2D 即時動態走勢圖 | 支援即時秒級折線圖與 K 線圖動態更新、高格率平滑繪製 | M1 / M2 | ORIGINAL_REQUEST §R1 |
| 12 | 突發新聞事件資料庫 | 涵蓋宏觀經濟黑天鵝、產業板塊利多/利空、個股財報與監管突襲 | M3 | ORIGINAL_REQUEST §R3 |
| 13 | 新聞事件調度觸發器 | 賽局進行中定期或隨機觸發事件，並維持冷卻機制 | M3 | ORIGINAL_REQUEST §R3 |
| 14 | 全體廣播跑馬燈與快訊彈窗 | 突發事件觸發時以醒目跑馬燈與彈出視窗同步廣播全體玩家 | M3 | ORIGINAL_REQUEST §R3 |
| 15 | 即時價格跳空衝擊機制 | 新聞發布當下施加 $\pm 10\% \sim \pm 30\%$ 幾何價格跳空與均值位移 | M3 | ORIGINAL_REQUEST §R3 |
| 16 | 暫態趨勢漂移 (Drift Decay) | 事件後給予 10~20 秒指數衰減之趨勢動能，提供玩家應變與跟單空間 | M3 | ORIGINAL_REQUEST §R3 |
| 17 | 現貨買入與賣出 (做多) | 支援現貨買入做多、賣出平倉，動態扣除/返還可用現金 | M4 | ORIGINAL_REQUEST §R4 |
| 18 | 融券做空與買回平倉 (做空) | 支援融券賣出建立空頭部位，買回平倉釋放保證金並結算價差 | M4 | ORIGINAL_REQUEST §R4 |
| 19 | 保證金與浮動損益會計系統 | 精確計算 100% 融券保證金凍結、標記市價、持股與做空未實現損益 | M4 | ORIGINAL_REQUEST §R4 |
| 20 | 資金與保證金檢核防禦 | 防止餘額不足或超保證金之無效委託，提供清楚錯誤回饋 | M4 | ORIGINAL_REQUEST AC |
| 21 | 限時競技倒數計時器 | 支援 3~5 分鐘（可自訂）倒數計時，全房同步倒數並以毫秒同步 | M4 | ORIGINAL_REQUEST §R4 |
| 22 | 歸零封盤與自動強制平倉 | 倒數歸零立即切換封盤狀態，以最終公允價清空所有部位轉為現金 | M4 | ORIGINAL_REQUEST §R4 |
| 23 | 淨資產計算、排行榜與頒獎 | 計算最終總淨資產、排序結算榜單、收益率與冠軍頒獎模態框 | M4 | ORIGINAL_REQUEST §R4 |
| 24 | E2E 自動化測試機器人套件 | 模擬至少 3 機器人同房高頻多空買賣、事件跳空、經歷倒數並驗證結算 | M5 | ORIGINAL_REQUEST AC |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | 基礎通訊與房間大廳系統 (R1) | 專案環境建置、HTTP 靜態服務、WebSocket 協定、房間大廳、Canvas 走勢圖與終端 UI 骨架 | none | DONE |
| M2 | 動態市場與價格衝擊引擎 (R2) | 4 檔股票標的池、秒級離散 GBM+OU 跳動、流動性池、雙曲正切價格衝擊與滑價計算 | M1 | DONE |
| M3 | 突發新聞事件與市場衝擊系統 (R3) | 事件資料庫、定期/隨機調度器、醒目跑馬燈推播、瞬時價格跳空與趨勢漂移衰減 | M2 | DONE |
| M4 | 雙向交易、保證金會計與競技結算 (R4) | 現貨做多、融券做空、保證金檢核、浮動損益、倒數計時、歸零強制平倉與結算榜單頒獎 | M2, M3 | DONE |
| M5 | 最終驗收與 E2E 測試對抗強化 (Acceptance) | 執行完整 E2E 測試套件 (含 3+ 機器人高頻對戰模擬)、Tier 5 對抗漏洞強化、誠信稽核通過 | M1, M2, M3, M4 | IN_PROGRESS |

---

## Interface Contracts

### 1. Client ↔ Server WebSocket 協定契約
所有的訊息格式均為 JSON 字串：`{ type: string, payload: object, requestId?: string }`

#### 客戶端請求 (Client -> Server):
- `CREATE_ROOM`: `{ hostName: string, durationSeconds: number }`
- `JOIN_ROOM`: `{ roomCode: string, playerName: string }`
- `START_GAME`: `{ roomCode: string }`
- `PLACE_ORDER`: `{ roomCode: string, stockSymbol: string, side: "BUY"|"SELL"|"SHORT"|"COVER", shares: number }`
- `PING`: `{ timestamp: number }`

#### 伺服器推播/回應 (Server -> Client):
- `ROOM_STATE`: `{ roomCode, status, players, hostId, durationSeconds, remainingSeconds }`
- `MARKET_TICK`: `{ timestamp, stocks: { [symbol]: { price, change, changePercent, open, high, low, history: [] } } }`
- `NEWS_FLASH`: `{ id, title, content, scope, affectedSymbol?, shockPercent, timestamp }`
- `ORDER_ACK`: `{ success: boolean, orderId, symbol, side, shares, price, message?: string }`
- `ACCOUNT_UPDATE`: `{ cash, netWorth, pnl, pnlPercent, positions: { [symbol]: { longShares, avgCost, shortShares, shortAvgPrice, frozenMargin } } }`
- `LEADERBOARD`: `{ rankings: [ { rank, playerId, playerName, netWorth, pnlPercent } ] }`
- `GAME_OVER`: `{ rankings: [...], winner: { name, netWorth, returnRate } }`
- `ERROR`: `{ code: string, message: string }`

### 2. MarketEngine ↔ TradingEngine 內部契約
```javascript
// 取得最新標的報價與做市流動性
marketEngine.getStock(symbol) => { symbol, name, price, depth, volatility, ... }

// 執行訂單價格衝擊運算並取得成交均價與新市價
marketEngine.executePriceImpact(symbol, side, shares) => {
  executedPrice: number, // 包含滑價之成交均價
  newPrice: number,      // 衝擊後之最新市場價
  impactRatio: number    // 價格變動百分比
}

// 突發新聞事件跳空與趨勢注入
marketEngine.applyNewsShock(symbol, shockPercent, driftIntensity, durationSec) => void
```

### 3. RoomManager ↔ TradingEngine 內部契約
```javascript
// 玩家下單檢驗與原子執行
tradingEngine.processOrder(room, player, { symbol, side, shares }) => {
  success: boolean,
  error?: string,
  executedOrder?: { orderId, symbol, side, shares, executedPrice, postPrice }
}

// 倒數計時結束強制公允市價全場平倉
tradingEngine.forceLiquidateAll(room) => {
  finalRankings: Array<{ rank, playerId, playerName, finalCash, initialCash, returnRate }>
}
```

---

## Code Layout
```
c:/Users/kcy3f/stock/
├── package.json               # 專案組態 (type: "module", ws 依賴, test 指令)
├── server/
│   ├── server.js              # 主入口 (HTTP 靜態服務 + WebSocket 伺服器)
│   ├── config/
│   │   ├── stocks.js          # 4 檔股票初始參數 (MEGA, NVTX, SOLR, MEME)
│   │   └── newsCatalog.js     # 突發新聞事件庫 (宏觀、板塊、個股利多/利空)
│   └── models/
│       ├── roomManager.js     # 房間大廳狀態機與計時器管理
│       ├── marketEngine.js    # 秒級 Tick 跳動、GBM+OU、做市流動性與雙曲價格衝擊
│       ├── newsEngine.js      # 新聞排程觸發器、跳空與趨勢衰減動力學
│       └── tradingEngine.js   # 多空雙向交易、保證金會計、未實現損益、強制平倉結算
├── public/
│   ├── index.html             # 終端單頁面 UI
│   ├── css/
│   │   └── style.css          # 終端深色主題、排版與動畫樣式
│   └── js/
│       ├── app.js             # 前端主程式、WebSocket 通訊與狀態綁定
│       └── chart.js           # HTML5 Canvas 2D 60FPS 走勢與 K 線圖繪製引擎
└── tests/
    ├── e2e/
    │   ├── bot_client.mjs     # 虛擬機器人客戶端封裝
    │   └── bot_battle.test.mjs# 3+ 機器人高頻買賣、做空、事件衝擊與結算驗收測試
    └── unit/
        ├── market.test.mjs    # 市場跳動與價格衝擊單元測試
        └── trading.test.mjs   # 保證金與強制平倉會計單元測試
```
