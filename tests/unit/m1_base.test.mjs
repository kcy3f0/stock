/**
 * Milestone 1 基礎設施與大廳系統自動化驗證測試
 * 驗證 HTTP 靜態檔案伺服、安全性、WebSocket 連線生命週期與房間大廳狀態機
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { server, wss, roomManager } from '../../server/server.js';

let baseHttpUrl = '';
let baseWsUrl = '';

// 啟動與關閉伺服器
test.before(async () => {
  await new Promise((resolve) => {
    if (server.listening) {
      const port = server.address().port;
      baseHttpUrl = `http://127.0.0.1:${port}`;
      baseWsUrl = `ws://127.0.0.1:${port}`;
      resolve();
    } else {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseHttpUrl = `http://127.0.0.1:${port}`;
        baseWsUrl = `ws://127.0.0.1:${port}`;
        resolve();
      });
    }
  });
});

test.after(async () => {
  await new Promise((resolve) => {
    // 終止所有客戶端連線
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close(() => {
      server.close(() => {
        resolve();
      });
    });
  });
});

// Helper: 發送 HTTP GET 請求
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseHttpUrl}${path}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    }).on('error', reject);
  });
}

// Helper: 建立 WebSocket 客戶端並等待 open
function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseWsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Helper: 等待接收符合條件的 WebSocket 訊息
function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error(`等待訊息逾時 (${timeoutMs}ms)`));
    }, timeoutMs);

    function onMsg(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener('message', onMsg);
          resolve(msg);
        }
      } catch (e) {
        // ignore parse errors
      }
    }

    ws.on('message', onMsg);
  });
}

test('HTTP 靜態檔案伺服驗證', async (t) => {
  await t.test('GET / 應返回 200 OK 且內容為 index.html', async () => {
    const res = await httpGet('/');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /STOCK BATTLE/);
  });

  await t.test('GET /css/style.css 應返回 200 OK 與正確 MIME 類型', async () => {
    const res = await httpGet('/css/style.css');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/css/);
    assert.match(res.body, /terminal-body/);
  });

  await t.test('GET /js/chart.js 應返回 200 OK 與正確 MIME 類型', async () => {
    const res = await httpGet('/js/chart.js');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/javascript/);
    assert.match(res.body, /StockChart/);
  });

  await t.test('GET /js/app.js 應返回 200 OK 與正確 MIME 類型', async () => {
    const res = await httpGet('/js/app.js');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/javascript/);
    assert.match(res.body, /StockBattleApp/);
  });

  await t.test('GET 不存在檔案應返回 404', async () => {
    const res = await httpGet('/nonexistent_file_xyz.txt');
    assert.equal(res.statusCode, 404);
  });

  await t.test('目錄遍歷安全攻擊應被防禦阻擋 (403 或 404)', async () => {
    const res = await httpGet('/../package.json');
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
  });
});

test('WebSocket 協定與心跳保活驗證', async (t) => {
  await t.test('PING / PONG 機制應正確運作', async () => {
    const client = await createClient();
    const sentTime = Date.now();

    const waitPong = waitForMessage(client, m => m.type === 'PONG');
    client.send(JSON.stringify({ type: 'PING', payload: { timestamp: sentTime } }));

    const pong = await waitPong;
    assert.equal(pong.type, 'PONG');
    assert.equal(pong.payload.timestamp, sentTime);

    client.close();
  });

  await t.test('非法格式 JSON 應返回 INVALID_JSON 錯誤', async () => {
    const client = await createClient();
    const waitErr = waitForMessage(client, m => m.type === 'ERROR');
    client.send('INVALID_RAW_JSON_TEXT{{{');

    const err = await waitErr;
    assert.equal(err.type, 'ERROR');
    assert.equal(err.payload.code, 'INVALID_JSON');

    client.close();
  });
});

test('房間大廳狀態機與多人加入連線驗證', async (t) => {
  let hostClient;
  let playerClient;
  let createdRoomCode;

  await t.test('建立房間 (CREATE_ROOM) 應產生合法 6 碼代碼與 WAITING 狀態', async () => {
    hostClient = await createClient();
    const waitRoom = waitForMessage(hostClient, m => m.type === 'ROOM_STATE');

    hostClient.send(JSON.stringify({
      type: 'CREATE_ROOM',
      payload: {
        hostName: '測試房主',
        durationSeconds: 180,
        initialCash: 1000000
      }
    }));

    const msg = await waitRoom;
    assert.equal(msg.type, 'ROOM_STATE');
    assert.equal(typeof msg.payload.roomCode, 'string');
    assert.equal(msg.payload.roomCode.length, 6);
    assert.equal(msg.payload.status, 'WAITING');
    assert.equal(msg.payload.durationSeconds, 180);
    assert.equal(msg.payload.players.length, 1);
    assert.equal(msg.payload.players[0].name, '測試房主');
    assert.equal(msg.payload.players[0].isHost, true);

    createdRoomCode = msg.payload.roomCode;
  });

  await t.test('第二名玩家透過房間代碼加入 (JOIN_ROOM) 應同步推播至全房', async () => {
    playerClient = await createClient();

    const waitHostUpdate = waitForMessage(hostClient, m => m.type === 'ROOM_STATE' && m.payload.players.length === 2);
    const waitPlayerUpdate = waitForMessage(playerClient, m => m.type === 'ROOM_STATE' && m.payload.players.length === 2);

    playerClient.send(JSON.stringify({
      type: 'JOIN_ROOM',
      payload: {
        roomCode: createdRoomCode,
        playerName: '挑戰玩家2'
      }
    }));

    const [hostMsg, playerMsg] = await Promise.all([waitHostUpdate, waitPlayerUpdate]);
    assert.equal(hostMsg.payload.players.length, 2);
    assert.equal(playerMsg.payload.players.length, 2);
    assert.ok(playerMsg.payload.players.some(p => p.name === '挑戰玩家2'));
  });

  await t.test('非房主嘗試開始遊戲 (START_GAME) 應被拒絕', async () => {
    const waitErr = waitForMessage(playerClient, m => m.type === 'ERROR');

    playerClient.send(JSON.stringify({
      type: 'START_GAME',
      payload: { roomCode: createdRoomCode }
    }));

    const err = await waitErr;
    assert.equal(err.type, 'ERROR');
    assert.equal(err.payload.code, 'NOT_HOST');
  });

  await t.test('房主開始遊戲 (START_GAME) 應將房間狀態切換為 PLAYING 並開始倒數', async () => {
    const waitHostPlaying = waitForMessage(hostClient, m => m.type === 'ROOM_STATE' && m.payload.status === 'PLAYING');
    const waitPlayerPlaying = waitForMessage(playerClient, m => m.type === 'ROOM_STATE' && m.payload.status === 'PLAYING');

    hostClient.send(JSON.stringify({
      type: 'START_GAME',
      payload: { roomCode: createdRoomCode }
    }));

    const [hostMsg, playerMsg] = await Promise.all([waitHostPlaying, waitPlayerPlaying]);
    assert.equal(hostMsg.payload.status, 'PLAYING');
    assert.equal(playerMsg.payload.status, 'PLAYING');
    assert.equal(hostMsg.payload.remainingSeconds, 180);
  });

  await t.test('遊戲進行中禁止新玩家加入', async () => {
    const lateClient = await createClient();
    const waitErr = waitForMessage(lateClient, m => m.type === 'ERROR');

    lateClient.send(JSON.stringify({
      type: 'JOIN_ROOM',
      payload: {
        roomCode: createdRoomCode,
        playerName: '遲到玩家'
      }
    }));

    const err = await waitErr;
    assert.equal(err.type, 'ERROR');
    assert.equal(err.payload.code, 'GAME_ALREADY_STARTED');

    lateClient.close();
  });

  // 清理連線
  hostClient.close();
  playerClient.close();
});
