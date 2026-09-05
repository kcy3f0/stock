# TEST_READY: 股市即時對戰多人連線模擬系統 E2E 自動化測試就緒報告

## 1. 測試套件概述 (Overview)
本測試套件為專案「股市即時對戰多人連線模擬系統」之全流程端到端 (E2E) 自動化黑箱驗收測試套件，完全符合 `TEST_INFRA.md`、`PROJECT.md` 與 `ORIGINAL_REQUEST.md` 規範：
- **測試執行器 (Test Runner)**: 採用 Node.js 24 原生內建之 `node:test` 與 `node:assert/strict`，零外部測試套件依賴，啟動快速且可移植。
- **機器人客戶端引擎 (Bot Client)**: `tests/e2e/bot_client.mjs`，採用 Node 24 原生 `globalThis.WebSocket` 封裝 `StockBotClient`，完整支援心跳、房間大廳、雙向交易下單、秒級行情接收、突發新聞監聽與終局強制結算。
- **多層級端到端驗收 (Multi-Tier E2E Battle)**: `tests/e2e/bot_battle.test.mjs`，涵蓋 Tier 1 至 Tier 4 共 13 個測試案例，模擬 3 個獨立機器人 (Alice, Bob, Charlie) 進入同房間進行高頻多空博弈、新聞跳空衝擊與終局公允平倉結算。

---

## 2. 檔案清單與責任歸屬 (File Inventory)
| 檔案路徑 | 模組名稱 | 說明 |
|---|---|---|
| `tests/e2e/bot_client.mjs` | `StockBotClient` | 原生 Node 24 WebSocket 虛擬交易機器人客戶端封裝 |
| `tests/e2e/bot_battle.test.mjs` | E2E Battle Test | 涵蓋 Tier 1 ~ Tier 4 之全自動化驗收測試套件 |
| `TEST_READY.md` | Test Ready Report | 測試套件執行指南、覆蓋報告與檢驗矩陣 |

---

## 3. 測試執行方式 (Execution Commands)

### 3.1 透過 npm 執行全部測試
```bash
npm test
```

### 3.2 透過 node 原生指令執行特定 E2E 測試
```bash
node --test tests/e2e/bot_battle.test.mjs
```

---

## 4. 測試層級覆蓋清單與檢核矩陣 (Coverage Checklist)

### Tier 1: 基礎通訊與房間大廳 (Lobby & Market Tick)
- [x] **T1.1 房主建立房間與自訂時長 (`CREATE_ROOM`)**
  - 驗證產生唯一 6 碼大寫英數房間代碼。
  - 驗證初始狀態為 `WAITING`，時長與初始資金符合設定。
  - 驗證建立者身分為房主 (`isHost = true`)。
- [x] **T1.2 多玩家連線加入同房間 (`JOIN_ROOM`)**
  - 驗證多名玩家（Bob, Charlie）透過房間代碼加入 Alice 房間。
  - 驗證全房各客戶端即時同步收到更新後的玩家名冊與人數。
- [x] **T1.3 房主啟動遊戲切換狀態 (`START_GAME`)**
  - 驗證房主發送開局指令後，房間狀態切換為 `PLAYING`。
  - 驗證全房客戶端同步切換至比賽進行狀態。
- [x] **T1.4 全房玩家於 1 秒內收到 `MARKET_TICK` 即時行情推播**
  - 驗證 1 秒內全房收到秒級行情推播。
  - 驗證 4 檔股票標的池 (`MEGA`, `NVTX`, `SOLR`, `MEME`) 價格皆大於 0 且包含 high, low, changePercent 數值結構。

### Tier 2: 邊界測試與異常防禦 (Boundary & Defensive Rules)
- [x] **T2.1 加入不存在之無效房間代碼 (`ROOM_NOT_FOUND`)**
  - 客戶端嘗試加入幽靈房間代碼，驗證伺服器回傳 `ROOM_NOT_FOUND` 錯誤。
- [x] **T2.2 現貨買入可用現金不足拒單防禦 (`INSUFFICIENT_FUNDS`)**
  - 嘗試下單買進遠超現金餘額的巨量部位，驗證伺服器拒絕成交。
- [x] **T2.3 融券做空超額保證金防禦 (`INSUFFICIENT_MARGIN`)**
  - 嘗試做空超出帳戶保證金之部位，驗證伺服器拒單防禦。
- [x] **T2.4 零持股賣出與零空單平倉防禦 (`INSUFFICIENT_SHARES` / `INSUFFICIENT_SHORT_POSITION`)**
  - 嘗試在無部位狀態下進行現貨賣出或空單平倉，驗證伺服器攔截拒單。
- [x] **T2.5 非房主嘗試啟動遊戲權限防禦 (`NOT_HOST`)**
  - 非房主玩家嘗試發送 `START_GAME`，驗證伺服器拒絕並回傳 `NOT_HOST`。

### Tier 3: 價格衝擊模型與雙向交易 (Price Impact & Trading Depth)
- [x] **T3.1 大單現貨買入推升股價 (`Price Impact - BUY`)**
  - 驗證買入大單時，成交均價包含滑價，成交後市場最新報價被顯著推升。
  - 驗證帳戶現金減少、多頭持股增加、未實現損益動態更新。
- [x] **T3.2 大單融券做空打壓股價 (`Price Impact - SHORT`)**
  - 驗證融券做空大單時，成交後市場最新報價被顯著壓低。
  - 驗證 100% 保證金凍結、空頭部位建立與浮動損益計算。
- [x] **T3.3 雙向平倉操作 (`SELL` 現貨賣出與 `COVER` 空單買回)**
  - 驗證現貨賣出獲利了結，持股歸零，現金返還。
  - 驗證融券買回平倉，做空部位歸零，保證金解凍釋放，損益結算入帳。

### Tier 4: 核心 3-Bot 高頻博弈、事件跳空與終局強制平倉結算 (Real-World 3-Bot Battle)
- [x] **T4.1 多機器人同房高頻博弈全流程驗收**
  - 啟動 3 個獨立虛擬機器人 (`Alice_Bull`, `Bob_Bear`, `Charlie_Scalper`) 加入同房間開局。
  - 3 機發動並發高頻多空下單（追多、打空、高頻套利），驗證並發交易撮合無崩潰。
  - 突發黑天鵝新聞事件注入：廣播 `NEWS_FLASH`，驗證全房客戶端收到通知，且對應標的即時跳空暴跌 (-25%)。
  - 歷經限時倒數歸零：驗證伺服器自動鎖盤、觸發全場公允市價強制平倉。
  - 終局結算榜單驗證：驗證 `GAME_OVER` 廣播，斷言排行榜恰好 3 人、名次嚴格遞增、淨資產嚴格降序排列、冠軍名稱與第一名一致、所有數值為有限合法數字（無 NaN/Infinity/null）、結算後所有部位清空變現。

---

## 5. 測試執行實測數據 (Test Run Statistics)
- **執行環境**: Windows 11 / Node.js v24.19.0 (ESM)
- **測試框架**: 原生 `node:test` + `node:assert/strict`
- **通訊協定**: 原生 `globalThis.WebSocket` (Node 24)
- **執行結果**:
  - Suites: 5 passed (100%)
  - Tests: 13 passed, 0 failed, 0 skipped
  - Total Duration: ~5.2 秒
  - 資源管理: 伺服器、定時器與 WebSocket 連線於 `after` 勾點全數釋放關閉，無未結句柄或記憶體洩漏。

---

## 6. 需求驗收矩陣 (Acceptance Criteria Matrix)
| 原始需求條款 | 驗收項目 | 測試驗證點 | 結果 |
|---|---|---|---|
| R1. 多人連線房間與大廳 | 多視窗/玩家加入同房間、WebSocket 雙向即時通訊 | T1.1, T1.2, T1.3 | **PASS** |
| R2. 動態市場與價格衝擊 | 秒級 1 tick 行情跳動、做市流動性、買推升/賣壓低價格衝擊 | T1.4, T3.1, T3.2 | **PASS** |
| R3. 突發新聞事件機制 | 跑馬燈快訊廣播、即時價格幾何跳空衝擊 | T4.1 (NEWS_FLASH) | **PASS** |
| R4. 雙向交易與限時競技 | 現貨做多、融券做空、保證金凍結、倒數歸零自動強制平倉、淨資產排名結算 | T2.2~T2.4, T3.3, T4.1 | **PASS** |
| AC. 自動化 E2E 驗證 | 至少 3 機器人同房高頻博弈、經歷倒數與結算榜單數值平衡無崩潰 | T4.1 | **PASS** |
