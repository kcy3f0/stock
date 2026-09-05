# Discord 回合制股票對戰

所有玩家會在同一個固定時間回合內自由交易。盤中不公開最新行情與排行榜；每回合倒數結束後，機器人才會一次公布行情、新聞與排名。最後一輪揭曉後自動平倉並公布冠軍。

> [!IMPORTANT]
> 本專案是遊戲與教學用途的市場模擬器，不提供真實交易或投資建議。

## 功能特色

- Discord 斜線指令建立、加入與管理多人房間。
- 支援 BUY、SELL、SHORT、COVER 與保證金會計。
- 每回合結束批次揭曉模擬行情、突發新聞及排行榜。
- 保留免建置的 WebSocket 網頁介面。

## 系統需求

- Node.js 20 或更新版本
- npm
- Discord Bot Token（僅 Discord 模式需要）

## 安裝

```powershell
git clone https://github.com/kcy3f0/stock.git
cd stock
npm ci
Copy-Item .env.example .env
```

## 啟動 Discord 機器人

1. 在 Discord Developer Portal 建立 Application 與 Bot，邀請時勾選 `bot`、`applications.commands`，並給予「查看頻道、傳送訊息」權限。
2. 設定環境變數。`DISCORD_GUILD_ID` 選填；開發時設定它可讓斜線指令立即出現。

```powershell
$env:DISCORD_TOKEN = '你的 Bot Token'
$env:DISCORD_GUILD_ID = '測試伺服器 ID'
npm start
```

機器人只使用 Discord 的 Guilds intent，不需要開啟 Message Content privileged intent。

## 指令

- `/stock create [rounds] [seconds] [cash]`：建立遊戲。
- `/stock join code:<房間代碼>`：加入遊戲。
- `/stock start`：房主開局。
- `/stock trade symbol:<股票> side:<方向> shares:<股數>`：盤中自由交易，可重複使用。
- `/stock market`：查看最近一次已揭曉行情。
- `/stock portfolio`：私下查看自己的資產。
- `/stock status`：查看回合倒數與玩家。
- `/stock help`：顯示玩法。

網頁相容入口仍可用 `npm run start:web` 啟動。

## 驗證

```powershell
npm test
```

舊版即時制測試保留於 `npm run test:legacy`，其「每秒公開行情」預期與新規則刻意不相容。

## 參與專案

提交變更前請閱讀 [貢獻指南](CONTRIBUTING.md) 與 [社群行為準則](CODE_OF_CONDUCT.md)。安全性問題請依 [安全政策](SECURITY.md) 私下通報；版本變更請見 [變更紀錄](CHANGELOG.md)。

## 授權

本專案依 [ISC License](LICENSE) 開放使用。
