# 貢獻指南

感謝你願意改善 Discord 回合制股票對戰。Bug 回報、功能提案、文件修正與程式碼貢獻都很歡迎。

參與本專案即表示你同意遵守 [行為準則](CODE_OF_CONDUCT.md)。安全性問題請勿建立公開 Issue，請改依 [安全政策](SECURITY.md) 通報。

## 開始之前

- 搜尋現有 Issue，確認問題尚未被回報。
- 大型功能或會改變遊戲規則的提案，請先建立功能建議 Issue 討論範圍。
- 請勿提交 Discord Bot Token、伺服器 ID 或其他機密資料。

## 本機開發

需要 Node.js 20 以上版本。

```powershell
git clone https://github.com/kcy3f0/stock.git
cd stock
npm ci
Copy-Item .env.example .env
npm test
```

啟動 Discord Bot 前，請在 `.env` 或目前 shell 中設定 `DISCORD_TOKEN`。若只要使用網頁版，可執行 `npm run start:web`。

## 提交變更

1. 從最新的預設分支建立主題分支。
2. 讓每個 commit 聚焦於單一目的，commit 訊息使用清楚的祈使句。
3. 為行為變更新增或更新測試，並執行 `npm test`。
4. 若使用方式或玩家可見行為有變，請同步更新 `README.md` 或 `PROJECT.md`。
5. 建立 Pull Request，說明問題、解法、測試方式與任何相容性影響。

## 程式碼原則

- 維持現有 ESM 與 Node.js 內建測試框架的風格。
- 伺服器必須是遊戲狀態的唯一權威來源；不要信任客戶端傳來的價格、資產或身分資料。
- 對外部輸入做邊界檢查，錯誤訊息應可理解但不可洩漏機密。
- 不要把產生檔、日誌、`.env` 或 `node_modules` 納入版本控制。

## Pull Request 檢查

維護者會檢查功能正確性、測試、向後相容性、安全性與文件。Review 意見是協作的一部分；請在更新後標記已處理的討論。
