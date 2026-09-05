import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../../server/models/roomManager.js';

function socket(id) {
  return {
    readyState: 1,
    playerId: id,
    roomId: null,
    messages: [],
    send(raw) { this.messages.push(JSON.parse(raw)); }
  };
}

const messagesOf = (ws, type) => ws.messages.filter(message => message.type === type);

test('同步回合：固定時間內自由交易，回合結束才公開行情與排名', () => {
  const manager = new RoomManager();
  const alice = socket('alice');
  const bob = socket('bob');
  const room = manager.createRoom(alice, {
    hostName: 'Alice', totalRounds: 2, roundDurationSeconds: 10, initialCash: 1000000
  });
  manager.joinRoom(bob, { roomCode: room.roomCode, playerName: 'Bob' });
  manager.startGame(alice, { roomCode: room.roomCode });
  clearInterval(room.timer);
  room.timer = null;

  assert.equal(room.currentRound, 1);
  assert.equal(room.remainingTurnSeconds, 10);
  alice.messages.length = 0;
  bob.messages.length = 0;

  // 同一玩家與不同玩家都能在同一回合不限次下單。
  manager.handleOrder(alice, { roomCode: room.roomCode, stockSymbol: 'MEGA', side: 'BUY', shares: 10 });
  manager.handleOrder(alice, { roomCode: room.roomCode, stockSymbol: 'MEGA', side: 'BUY', shares: 10 });
  manager.handleOrder(bob, { roomCode: room.roomCode, stockSymbol: 'MEME', side: 'SHORT', shares: 10 });
  assert.equal(messagesOf(alice, 'ORDER_ACK').filter(m => m.payload.success).length, 2);
  assert.equal(messagesOf(bob, 'ORDER_ACK').filter(m => m.payload.success).length, 1);

  // 盤中不對全房公開變動行情與排行榜。
  assert.equal(messagesOf(alice, 'MARKET_TICK').length, 0);
  assert.equal(messagesOf(bob, 'MARKET_TICK').length, 0);
  assert.equal(messagesOf(alice, 'LEADERBOARD').length, 0);

  room.remainingTurnSeconds = 1;
  manager.handleTick(room);
  assert.equal(room.currentRound, 2);
  assert.equal(room.remainingTurnSeconds, 10);
  assert.equal(messagesOf(alice, 'MARKET_TICK').length, 1);
  assert.equal(messagesOf(bob, 'LEADERBOARD').length, 1);
  assert.ok(messagesOf(alice, 'TURN_STATE').some(m => m.payload.phase === 'REVEAL'));

  room.remainingTurnSeconds = 1;
  manager.handleTick(room);
  assert.equal(room.status, 'FINISHED');
  assert.equal(messagesOf(alice, 'GAME_OVER').length, 1);
  assert.equal(messagesOf(bob, 'GAME_OVER').length, 1);
});

test('同步回合：每秒只同步倒數，不推進或公開市場', () => {
  const manager = new RoomManager();
  const host = socket('host');
  const room = manager.createRoom(host, { hostName: 'Host', totalRounds: 3, roundDurationSeconds: 15 });
  manager.startGame(host, { roomCode: room.roomCode });
  clearInterval(room.timer);
  room.timer = null;
  host.messages.length = 0;
  const publicPrice = room.marketState.MEGA.price;

  manager.handleTick(room);

  assert.equal(room.remainingTurnSeconds, 14);
  assert.equal(room.currentRound, 1);
  assert.equal(room.marketState.MEGA.price, publicPrice);
  assert.equal(messagesOf(host, 'MARKET_TICK').length, 0);
});
