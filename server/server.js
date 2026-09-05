/**
 * 主伺服器入口 (Server Runtime)
 * 整合原生 node:http 靜態檔案伺服器與 ws WebSocketServer
 * 掛載 RoomManager、MarketEngine、NewsEngine、TradingEngine
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './models/roomManager.js';
import { MarketEngine } from './models/marketEngine.js';
import { NewsEngine } from './models/newsEngine.js';
import { TradingEngine } from './models/tradingEngine.js';
import { STOCKS_CONFIG } from './config/stocks.js';
import { NEWS_CATALOG } from './config/newsCatalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// MIME 類型對應表
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// 建立全域房間大廳狀態機管理員 (已內建掛載 M2/M3/M4 核心引擎)
export const roomManager = new RoomManager();

// 導出核心引擎類別與組態供外部模組使用
export { MarketEngine, NewsEngine, TradingEngine, STOCKS_CONFIG, NEWS_CATALOG };

/**
 * 處理 HTTP 靜態檔案請求
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse} res 
 */
function handleHttpRequest(req, res) {
  // 僅支援 GET 與 HEAD 方法
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // 解析 URL 路徑並去除 query string
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  // 防止路徑遍歷安全攻擊
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safePath);

  // 確保目標檔案嚴格限制在 PUBLIC_DIR 目錄內
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 禁止跨目錄存取');
    return;
  }

  // 檢查檔案是否存在
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 找不到檔案，回傳 404
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: 找不到請求的資源');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const readStream = fs.createReadStream(filePath);
    readStream.on('error', (streamErr) => {
      console.error('[HTTP] 檔案讀取串流錯誤:', streamErr);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('500 Internal Server Error');
    });

    readStream.pipe(res);
  });
}

// 建立原生 HTTP 伺服器
export const server = http.createServer(handleHttpRequest);

// 建立掛載於 HTTP 伺服器之 WebSocketServer
export const wss = new WebSocketServer({ server });

/**
 * 處理客戶端 WebSocket 訊息路由
 * @param {WebSocket} ws 
 * @param {string} rawMessage 
 */
function handleWsMessage(ws, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch (err) {
    console.warn('[WS] 收到無效之 JSON 格式訊息:', rawMessage.toString().slice(0, 100));
    roomManager.sendTo(ws, {
      type: 'ERROR',
      payload: { code: 'INVALID_JSON', message: '訊息格式必須為合法 JSON' }
    });
    return;
  }

  // 邊界防禦：檢驗訊息是否為有效非空之非陣列物件
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    console.warn('[WS] 收到非物件型別之 JSON 訊息:', message);
    roomManager.sendTo(ws, {
      type: 'ERROR',
      payload: { code: 'INVALID_PAYLOAD_TYPE', message: '訊息格式必須為包含 type 的 JSON 物件' }
    });
    return;
  }

  const { type, payload = {}, requestId } = message;
  const safePayload = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};

  switch (type) {
    case 'PING':
      roomManager.sendTo(ws, {
        type: 'PONG',
        payload: { timestamp: safePayload.timestamp || Date.now() },
        requestId
      });
      break;

    case 'CREATE_ROOM':
      roomManager.createRoom(ws, safePayload);
      break;

    case 'JOIN_ROOM':
      roomManager.joinRoom(ws, safePayload);
      break;

    case 'START_GAME':
      roomManager.startGame(ws, safePayload);
      break;

    case 'PLACE_ORDER':
      roomManager.handleOrder(ws, safePayload);
      break;

    case 'END_TURN':
      roomManager.endTurn(ws, safePayload);
      break;

    default:
      console.warn(`[WS] 收到未知訊息類型: ${type}`);
      roomManager.sendTo(ws, {
        type: 'ERROR',
        payload: { code: 'UNKNOWN_MESSAGE_TYPE', message: `未知訊息類型: ${type}` },
        requestId
      });
      break;
  }
}

// 監聽 WebSocket 連線生命週期
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.playerId = `p_${Math.random().toString(36).slice(2, 9)}`;

  // 心跳 Pong 保活
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // 接收訊息
  ws.on('message', (data) => {
    handleWsMessage(ws, data);
  });

  // 斷線處置
  ws.on('close', () => {
    roomManager.handleDisconnect(ws);
  });

  // 錯誤處置
  ws.on('error', (error) => {
    console.error(`[WS] 玩家連線發生錯誤 (${ws.playerId}):`, error);
    roomManager.handleDisconnect(ws);
  });
});

// 每 30 秒執行一次心跳檢測，清理逾期無效連線
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log(`[WS] 心跳超時，強制終止連線: ${ws.playerId}`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// 啟動監聽 (支援 PORT 環境變數，預設 3000)
const PORT = process.env.PORT || 3000;

if (!server.listening && process.env.NODE_ENV !== 'test' && !process.env.DISABLE_SERVER_AUTOSTART) {
  server.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🚀 股市即時對戰多人連線系統 (Stock Battle) 啟動成功！`);
    console.log(`🌐 本地網址: http://localhost:${PORT}`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}`);
    console.log(`📁 前端目錄: ${PUBLIC_DIR}`);
    console.log('====================================================');
  });
}

// 優雅關機處理
const gracefulShutdown = () => {
  console.log('\n[Server] 正在停止伺服器並釋放資源...');
  clearInterval(heartbeatInterval);

  // 清除所有房間定時器
  for (const room of roomManager.rooms.values()) {
    if (room.timer) clearInterval(room.timer);
  }

  wss.close(() => {
    server.close(() => {
      console.log('[Server] 伺服器已完全關閉。');
      process.exit(0);
    });
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
