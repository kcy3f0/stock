# E2E Test Infra: 股市即時對戰多人連線模擬系統

## Test Philosophy
- 需求驅動 (Requirement-driven)、黑箱驗證 (Opaque-box)，不依賴內部實現細節。
- 測試方法論：Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Real-World Workload Testing。
- 專門針對 WebSocket 即時並發、秒級價格衝擊、雙向做多/做空保證金檢核、新聞跳空衝擊與倒數歸零全場強制平倉進行高頻模擬測試。

## Feature Inventory & Test Coverage
| # | Feature | Source | Tier 1 (功能) | Tier 2 (邊界) | Tier 3 (組合) |
|---|---------|--------|:-------------:|:-------------:|:-------------:|
| 1 | 房間建立與自訂時長 | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | 多人同房連線 | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 3 | WebSocket 雙向通訊 | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 4 | 前端操作面板與大廳 UI | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 5 | 多股票標的池配置 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 6 | 秒級 Tick 市場跳動 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 7 | 做市商流動性模型 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 8 | 量化價格衝擊 (Price Impact) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 9 | 撮合滑價 (Slippage) 計算 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 10 | 1秒內全房行情同步廣播 | ORIGINAL_REQUEST AC | 5 | 5 | ✓ |
| 11 | Canvas 2D 走勢圖與歷史紀錄 | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 12 | 突發新聞事件資料庫 | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 13 | 新聞事件調度觸發器 | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 14 | 全體廣播跑馬燈與快訊 | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 15 | 即時價格跳空衝擊機制 | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 16 | 暫態趨勢漂移 (Drift Decay) | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 17 | 現貨買入與賣出 (做多) | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 18 | 融券做空與平倉 (做空) | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 19 | 保證金與浮動損益會計系統 | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 20 | 資金與保證金檢核防禦 | ORIGINAL_REQUEST AC | 5 | 5 | ✓ |
| 21 | 限時競技倒數計時器 | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 22 | 歸零封盤與自動強制平倉 | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 23 | 淨資產計算、排行榜與頒獎 | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 24 | E2E 3+ 機器人高頻博弈驗收 | ORIGINAL_REQUEST AC | 5 | 5 | ✓ |

## Test Architecture
- **測試執行器 (Test Runner)**: Node.js 24 原生 `node --test`，無需第三方重量級測試依賴。
- **測試客戶端封裝 (Bot Client)**: `tests/e2e/bot_client.mjs`，基於原生的 `globalThis.WebSocket` 封裝機器人事件監聽、自動報價接收、即時做多/做空下單與資產狀態追蹤。
- **端到端戰鬥驗證 (End-to-End Battle)**: `tests/e2e/bot_battle.test.mjs`，一鍵啟動測試伺服器，模擬 3 個（或更多）獨立機器人同時連入同一個房間，進行多輪並發買賣、觸發新聞、等待倒數結束並驗證平倉結算數據無崩潰。

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | 3 機器人同房高頻博弈全流程 | F1, F2, F3, F6, F8, F17, F18, F21, F22, F23, F24 | High |
| 2 | 黑天鵝暴跌危機搶空與多頭反彈 | F5, F8, F12, F15, F16, F17, F18, F19 | High |
| 3 | 迷因股超額買單價格推升與軋空爆倉 | F5, F8, F9, F18, F19, F20 | Medium |
| 4 | 邊界極限資金不足拒單與保證金超額防禦 | F17, F18, F19, F20 | Medium |
| 5 | 終局倒數壓哨下單防禦與無滑價強制平倉排序 | F21, F22, F23 | Medium |

## Acceptance Criteria Check Matrix
- [x] 多人連線房間與視覺化操作介面 (R1)
- [x] 即時動態市場與價格衝擊模型 (R2)
- [x] 突發新聞事件與市場衝擊機制 (R3)
- [x] 雙向交易與限時競技結算規則 (R4)
- [x] 自動化 E2E 3+ 機器人高頻買賣與結算驗證腳本
