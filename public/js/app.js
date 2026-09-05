/**
 * 前端核心應用程式狀態機 (StockBattleApp)
 * 負責 WebSocket 通訊、同步交易回合、走勢圖、下單、資產與回合排行榜渲染
 */

import { StockChart } from './chart.js';

class StockBattleApp {
  constructor() {
    // 通訊狀態
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 2000;
    this.heartbeatTimer = null;

    // 玩家與房間狀態
    this.playerId = localStorage.getItem('stock_player_id') || `p_${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem('stock_player_id', this.playerId);
    this.playerName = localStorage.getItem('stock_player_name') || '操盤手大亨';
    this.roomCode = null;
    this.isHost = false;
    this.roomStatus = 'WAITING';
    this.remainingSeconds = 0;
    this.durationSeconds = 300;
    this.totalRounds = 10;
    this.currentRound = 0;
    this.players = [];

    // 股票市場資料 (初始 4 檔)
    this.stocks = {
      MEGA: {
        symbol: 'MEGA',
        name: '穩健藍籌 (科技權值)',
        price: 150.00,
        change: 0,
        changePercent: 0,
        open: 150.00,
        high: 150.00,
        low: 150.00,
        depth: 100000,
        history: [{ timestamp: Date.now() - 5000, price: 150.00 }, { timestamp: Date.now(), price: 150.00 }],
        candles: [{ timestamp: Date.now(), open: 150.00, high: 150.00, low: 150.00, close: 150.00 }]
      },
      NVTX: {
        symbol: 'NVTX',
        name: '高科龍頭 (AI算力)',
        price: 320.00,
        change: 0,
        changePercent: 0,
        open: 320.00,
        high: 320.00,
        low: 320.00,
        depth: 30000,
        history: [{ timestamp: Date.now() - 5000, price: 320.00 }, { timestamp: Date.now(), price: 320.00 }],
        candles: [{ timestamp: Date.now(), open: 320.00, high: 320.00, low: 320.00, close: 320.00 }]
      },
      SOLR: {
        symbol: 'SOLR',
        name: '新能源 (儲能光電)',
        price: 45.00,
        change: 0,
        changePercent: 0,
        open: 45.00,
        high: 45.00,
        low: 45.00,
        depth: 15000,
        history: [{ timestamp: Date.now() - 5000, price: 45.00 }, { timestamp: Date.now(), price: 45.00 }],
        candles: [{ timestamp: Date.now(), open: 45.00, high: 45.00, low: 45.00, close: 45.00 }]
      },
      MEME: {
        symbol: 'MEME',
        name: '迷因妖股 (狂熱社群)',
        price: 12.50,
        change: 0,
        changePercent: 0,
        open: 12.50,
        high: 12.50,
        low: 12.50,
        depth: 5000,
        history: [{ timestamp: Date.now() - 5000, price: 12.50 }, { timestamp: Date.now(), price: 12.50 }],
        candles: [{ timestamp: Date.now(), open: 12.50, high: 12.50, low: 12.50, close: 12.50 }]
      }
    };
    this.selectedSymbol = 'MEGA';
    this.chartMode = 'line';

    // 帳戶資產資料
    this.account = {
      cash: 1000000,
      initialCash: 1000000,
      margin: 0,
      netWorth: 1000000,
      unrealized: 0,
      roi: 0,
      positions: {} // symbol -> { longShares, avgCost, shortShares, shortAvgPrice, frozenMargin }
    };

    // 下單面板狀態
    this.orderSide = 'BUY'; // BUY, SELL, SHORT, COVER
    this.orderShares = 100;

    // Canvas 走勢圖引擎實例
    this.chart = null;

    // 初始化應用
    this.initElements();
    this.initChart();
    this.initEventListeners();
    this.initWebSocket();
  }

  // 快取 DOM 元素
  initElements() {
    this.dom = {
      // 頂部
      statusDot: document.getElementById('statusDot'),
      statusText: document.getElementById('statusText'),
      roomPill: document.getElementById('roomPill'),
      roomCodeDisplay: document.getElementById('roomCodeDisplay'),
      gameStatusBadge: document.getElementById('gameStatusBadge'),
      timerDigits: document.getElementById('timerDigits'),
      roundLabel: document.getElementById('roundLabel'),
      userNameDisplay: document.getElementById('userNameDisplay'),
      btnStartGame: document.getElementById('btnStartGame'),
      btnOpenLobby: document.getElementById('btnOpenLobby'),
      newsTickerTrack: document.getElementById('newsTickerTrack'),

      // 股票分頁
      stockTabsBar: document.getElementById('stockTabsBar'),
      stockTabs: document.querySelectorAll('.stock-tab'),

      // 走勢圖 Toolbar
      heroSymbol: document.getElementById('heroSymbol'),
      heroName: document.getElementById('heroName'),
      heroPrice: document.getElementById('heroPrice'),
      heroChange: document.getElementById('heroChange'),
      heroDepth: document.getElementById('heroDepth'),
      btnChartModeLine: document.getElementById('btnChartModeLine'),
      btnChartModeCandle: document.getElementById('btnChartModeCandle'),
      canvas: document.getElementById('stockCanvas'),

      // 走勢圖 Footer
      statOpen: document.getElementById('statOpen'),
      statHigh: document.getElementById('statHigh'),
      statLow: document.getElementById('statLow'),
      statAlpha: document.getElementById('statAlpha'),

      // 下單面板
      sideButtons: document.querySelectorAll('.side-btn'),
      orderSharesInput: document.getElementById('orderSharesInput'),
      pctButtons: document.querySelectorAll('.btn-pct'),
      prevAvgPrice: document.getElementById('prevAvgPrice'),
      prevImpact: document.getElementById('prevImpact'),
      prevCostLabel: document.getElementById('prevCostLabel'),
      prevCostAmount: document.getElementById('prevCostAmount'),
      btnSubmitOrder: document.getElementById('btnSubmitOrder'),

      // 資產面板
      valNetWorth: document.getElementById('valNetWorth'),
      valRoi: document.getElementById('valRoi'),
      valCash: document.getElementById('valCash'),
      valMargin: document.getElementById('valMargin'),
      valUnrealized: document.getElementById('valUnrealized'),
      valPositionValue: document.getElementById('valPositionValue'),
      positionsTableBody: document.getElementById('positionsTableBody'),
      userRoleBadge: document.getElementById('userRoleBadge'),

      // 排行榜
      leaderboardList: document.getElementById('leaderboardList'),
      playerCountTag: document.getElementById('playerCountTag'),

      // 模態框
      lobbyModal: document.getElementById('lobbyModal'),
      tabCreateRoom: document.getElementById('tabCreateRoom'),
      tabJoinRoom: document.getElementById('tabJoinRoom'),
      formCreateRoom: document.getElementById('formCreateRoom'),
      formJoinRoom: document.getElementById('formJoinRoom'),
      createHostName: document.getElementById('createHostName'),
      createDuration: document.getElementById('createDuration'),
      createRoundDuration: document.getElementById('createRoundDuration'),
      createInitialCash: document.getElementById('createInitialCash'),
      joinRoomCode: document.getElementById('joinRoomCode'),
      joinPlayerName: document.getElementById('joinPlayerName'),

      // 結算頒獎
      settlementModal: document.getElementById('settlementModal'),
      winnerName: document.getElementById('winnerName'),
      winnerNetWorth: document.getElementById('winnerNetWorth'),
      winnerRoi: document.getElementById('winnerRoi'),
      finalRankingsBody: document.getElementById('finalRankingsBody'),
      btnRestartGame: document.getElementById('btnRestartGame'),

      // Toast 容器
      toastContainer: document.getElementById('toastContainer')
    };

    // 填入預設玩家名稱
    this.dom.userNameDisplay.textContent = this.playerName;
    if (this.dom.createHostName) this.dom.createHostName.value = this.playerName;
    if (this.dom.joinPlayerName) this.dom.joinPlayerName.value = this.playerName;
  }

  // 初始化走勢圖引擎
  initChart() {
    this.chart = new StockChart(this.dom.canvas, {
      mode: this.chartMode
    });
    this.updateHeroAndChart();
  }

  // 初始化 WebSocket 連線與事件
  initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.updateConnectionStatus('connecting', '連線中...');

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WS] 連線成功建立:', wsUrl);
        this.reconnectAttempts = 0;
        this.updateConnectionStatus('connected', '已連線');
        this.showToast('成功連線至撮合伺服器', 'success');

        // 定期發送心跳 PING
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          this.sendMessage('PING', { timestamp: Date.now() });
        }, 20000);
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        console.warn('[WS] 連線中斷:', event);
        this.updateConnectionStatus('disconnected', '連線中斷');
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[WS] 連線異常:', err);
      };
    } catch (e) {
      console.error('[WS] 建立連線失敗:', e);
      this.scheduleReconnect();
    }
  }

  // 自動重連機制
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.showToast('無法連線至伺服器，請重新整理頁面', 'error');
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.log(`[WS] 將在 ${delay}ms 後嘗試第 ${this.reconnectAttempts} 次重連...`);
    setTimeout(() => {
      this.initWebSocket();
    }, delay);
  }

  // 安全傳送訊息
  sendMessage(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      this.showToast('連線尚未就緒，無法發送請求', 'error');
    }
  }

  // 處理收到的訊息路由
  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('[WS] 解析訊息失敗:', raw);
      return;
    }

    const { type, payload } = msg;

    switch (type) {
      case 'PONG':
        // 心跳回應，略過
        break;

      case 'ROOM_STATE':
        this.handleRoomState(payload);
        break;

      case 'MARKET_TICK':
        this.handleMarketTick(payload);
        break;

      case 'NEWS_FLASH':
        this.handleNewsFlash(payload);
        break;

      case 'ORDER_ACK':
        this.handleOrderAck(payload);
        break;

      case 'ACCOUNT_UPDATE':
        this.handleAccountUpdate(payload);
        break;

      case 'TURN_STATE':
        this.currentRound = payload.currentRound;
        this.totalRounds = payload.totalRounds;
        this.remainingSeconds = payload.remainingTurnSeconds ?? this.remainingSeconds;
        this.dom.roundLabel.textContent = `第 ${this.currentRound}/${this.totalRounds} 輪`;
        this.updateTimerDisplay(this.remainingSeconds);
        if (payload.phase === 'REVEAL') this.showToast(payload.message, 'success');
        break;

      case 'LEADERBOARD':
        this.handleLeaderboard(payload);
        break;

      case 'GAME_OVER':
        this.handleGameOver(payload);
        break;

      case 'ERROR':
        this.showToast(payload.message || '發生錯誤', 'error');
        break;

      default:
        console.log('[WS] 未知訊息類型:', type, payload);
        break;
    }
  }

  // 處理房間狀態變更
  handleRoomState(state) {
    if (!state) return;

    this.roomCode = state.roomCode;
    this.roomStatus = state.status;
    this.durationSeconds = state.durationSeconds;
    this.remainingSeconds = state.remainingSeconds;
    this.totalRounds = state.totalRounds || 10;
    this.currentRound = state.currentRound || 0;
    this.players = state.players || [];
    this.isHost = state.hostId === this.playerId;

    // 更新頂部房間資訊
    this.dom.roomCodeDisplay.textContent = this.roomCode;
    this.dom.userRoleBadge.textContent = this.isHost ? '房主' : '參賽者';

    // 關閉大廳彈窗
    if (this.dom.lobbyModal.style.display !== 'none') {
      this.dom.lobbyModal.style.display = 'none';
    }

    // 更新狀態徽章
    this.updateStatusBadge(this.roomStatus);

    // 更新倒數時鐘
    this.updateTimerDisplay(this.remainingSeconds);
    this.dom.roundLabel.textContent = this.roomStatus === 'WAITING'
      ? `共 ${this.totalRounds} 輪`
      : `第 ${this.currentRound}/${this.totalRounds} 輪`;

    // 房主控制按鈕切換
    if (this.isHost && this.roomStatus === 'WAITING') {
      this.dom.btnStartGame.style.display = 'inline-block';
    } else {
      this.dom.btnStartGame.style.display = 'none';
    }

    // 更新即時排行榜與玩家人數標籤
    this.dom.playerCountTag.textContent = `玩家: ${this.players.length}/${state.maxPlayers || 8}`;
    this.renderPlayersList(this.players);
  }

  // 處理即時市場行情推播
  handleMarketTick(payload) {
    if (!payload || !payload.stocks) return;

    if (payload.remainingSeconds !== undefined) {
      this.remainingSeconds = payload.remainingSeconds;
      this.updateTimerDisplay(this.remainingSeconds);
    }

    // 更新全域股票數據
    for (const sym of Object.keys(payload.stocks)) {
      const incoming = payload.stocks[sym];
      if (this.stocks[sym]) {
        Object.assign(this.stocks[sym], incoming);
      } else {
        this.stocks[sym] = incoming;
      }

      // 更新股票標籤卡片
      this.updateStockTabUI(sym);
    }

    // 若當前標的在推播內，更新圖表與報價
    const cur = this.stocks[this.selectedSymbol];
    if (cur) {
      this.updateHeroAndChart();
    }

    // 重新預算委託金額與衝擊
    this.updateOrderPreview();
  }

  // 處理突發新聞快訊推播
  handleNewsFlash(flash) {
    if (!flash) return;
    const { title, shockPercent, affectedSymbol } = flash;
    const itemEl = document.createElement('span');
    itemEl.className = 'news-item highlight';
    if (shockPercent > 0) {
      itemEl.classList.add('positive');
      itemEl.textContent = ` [利多 +${shockPercent}%] ${title} `;
    } else if (shockPercent < 0) {
      itemEl.classList.add('negative');
      itemEl.textContent = ` [利空 ${shockPercent}%] ${title} `;
    } else {
      itemEl.textContent = ` [市場快訊] ${title} `;
    }

    this.dom.newsTickerTrack.appendChild(itemEl);
    this.showToast(`📰 ${title}`, shockPercent >= 0 ? 'warning' : 'error');
  }

  // 處理訂單確認 (ORDER_ACK)
  handleOrderAck(ack) {
    if (ack.success) {
      this.showToast(`✅ 下單成功: ${ack.side} ${ack.shares}股 @ $${Number(ack.price).toFixed(2)}`, 'success');
    } else {
      this.showToast(`❌ 下單被拒: ${ack.message || '未知原因'}`, 'error');
    }
  }

  // 處理資產面板更新
  handleAccountUpdate(acc) {
    if (!acc) return;
    Object.assign(this.account, acc);

    const netWorth = Number(this.account.netWorth !== undefined ? this.account.netWorth : (this.account.cash || 0));
    const cash = Number(this.account.cash || 0);
    const margin = Number(this.account.frozenMargin !== undefined ? this.account.frozenMargin : (this.account.margin || 0));
    const roi = Number(this.account.pnlPercent !== undefined ? this.account.pnlPercent : (this.account.roi || 0));
    const pnl = Number(this.account.pnl !== undefined ? this.account.pnl : (this.account.unrealized || 0));

    this.dom.valNetWorth.textContent = `$${Math.round(netWorth).toLocaleString()}`;
    this.dom.valCash.textContent = `$${Math.round(cash).toLocaleString()}`;
    this.dom.valMargin.textContent = `$${Math.round(margin).toLocaleString()}`;

    this.dom.valRoi.textContent = `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`;
    this.dom.valRoi.className = `metric-value ${roi > 0 ? 'up' : (roi < 0 ? 'down' : 'neutral')}`;

    this.dom.valUnrealized.textContent = `${pnl >= 0 ? '+' : ''}$${Math.round(pnl).toLocaleString()}`;
    this.dom.valUnrealized.className = `metric-value ${pnl > 0 ? 'up' : (pnl < 0 ? 'down' : 'neutral')}`;

    this.renderPositionsTable(this.account.positions);
  }

  // 處理排行榜推播
  handleLeaderboard(payload) {
    if (payload && Array.isArray(payload.rankings)) {
      this.renderRankings(payload.rankings);
    }
  }

  // 處理比賽結束與結算
  handleGameOver(payload) {
    this.roomStatus = 'FINISHED';
    this.updateStatusBadge('FINISHED');
    this.dom.timerDigits.textContent = '00:00';
    this.dom.timerDigits.className = 'timer-digits';

    const rankings = payload.rankings || [];
    const winner = payload.winner || rankings[0];

    if (winner) {
      this.dom.winnerName.textContent = winner.name || winner.playerName || '勝利者';
      this.dom.winnerNetWorth.textContent = `$${Math.round(winner.netWorth).toLocaleString()}`;
      const rate = Number(winner.returnRate || winner.pnlPercent || 0);
      this.dom.winnerRoi.textContent = `${rate >= 0 ? '+' : ''}${rate.toFixed(2)}%`;
      this.dom.winnerRoi.className = rate >= 0 ? 'up' : 'down';
    }

    // 渲染最終名次表
    this.dom.finalRankingsBody.innerHTML = '';
    rankings.forEach((r, idx) => {
      const tr = document.createElement('tr');
      const pnl = (r.netWorth || 0) - (r.initialCash || 1000000);
      const rate = Number(r.returnRate || r.pnlPercent || 0);
      const rankBadge = idx === 0 ? '🥇 1' : (idx === 1 ? '🥈 2' : (idx === 2 ? '🥉 3' : `${idx + 1}`));

      tr.innerHTML = `
        <td><strong>${rankBadge}</strong></td>
        <td>${r.playerName || r.name}</td>
        <td>$${Math.round(r.netWorth).toLocaleString()}</td>
        <td class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${Math.round(pnl).toLocaleString()}</td>
        <td class="${rate >= 0 ? 'up' : 'down'}">${rate >= 0 ? '+' : ''}${rate.toFixed(2)}%</td>
      `;
      this.dom.finalRankingsBody.appendChild(tr);
    });

    this.dom.settlementModal.style.display = 'flex';
  }

  // 更新股票標籤頁 UI
  updateStockTabUI(symbol) {
    const stock = this.stocks[symbol];
    if (!stock) return;

    const priceEl = document.getElementById(`tabPrice_${symbol}`);
    const changeEl = document.getElementById(`tabChange_${symbol}`);

    if (priceEl) priceEl.textContent = `$${stock.price.toFixed(2)}`;
    if (changeEl) {
      const sign = stock.changePercent >= 0 ? '+' : '';
      changeEl.textContent = `${sign}${stock.changePercent.toFixed(2)}%`;
      changeEl.className = `tab-change ${stock.changePercent > 0 ? 'up' : (stock.changePercent < 0 ? 'down' : 'neutral')}`;
    }
  }

  // 更新走勢圖與頂部詳細報價
  updateHeroAndChart() {
    const stock = this.stocks[this.selectedSymbol];
    if (!stock) return;

    this.dom.heroSymbol.textContent = stock.symbol;
    this.dom.heroName.textContent = stock.name;
    this.dom.heroPrice.textContent = `$${stock.price.toFixed(2)}`;

    const sign = stock.changePercent >= 0 ? '+' : '';
    this.dom.heroChange.textContent = `${sign}${(stock.change || 0).toFixed(2)} (${sign}${stock.changePercent.toFixed(2)}%)`;
    this.dom.heroChange.className = `hero-change ${stock.changePercent > 0 ? 'up' : (stock.changePercent < 0 ? 'down' : 'neutral')}`;
    this.dom.heroDepth.textContent = `做市深度: ${(stock.depth || 10000).toLocaleString()} 股`;

    // 統計數據
    this.dom.statOpen.textContent = `$${(stock.open || stock.price).toFixed(2)}`;
    this.dom.statHigh.textContent = `$${(stock.high || stock.price).toFixed(2)}`;
    this.dom.statLow.textContent = `$${(stock.low || stock.price).toFixed(2)}`;

    // 更新圖表
    if (this.chart) {
      this.chart.setData(stock.history, stock.candles);
    }
  }

  // 渲染持倉部位表
  renderPositionsTable(positions = {}) {
    const tbody = this.dom.positionsTableBody;
    tbody.innerHTML = '';

    const syms = Object.keys(positions);
    if (syms.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">尚未持有任何標的部位</td></tr>';
      return;
    }

    let hasAnyPosition = false;
    for (const sym of syms) {
      const pos = positions[sym];
      const curPrice = (this.stocks[sym] && this.stocks[sym].price) || 0;

      // 多頭部位
      if (pos.longShares > 0) {
        hasAnyPosition = true;
        const pnl = (curPrice - pos.avgCost) * pos.longShares;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${sym}</strong></td>
          <td class="up">多 (BUY)</td>
          <td>${pos.longShares}</td>
          <td>$${pos.avgCost.toFixed(2)}</td>
          <td class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${Math.round(pnl)}</td>
        `;
        tbody.appendChild(tr);
      }

      // 空頭部位
      if (pos.shortShares > 0) {
        hasAnyPosition = true;
        const pnl = (pos.shortAvgPrice - curPrice) * pos.shortShares;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${sym}</strong></td>
          <td class="down" style="color: var(--color-short) !important;">空 (SHORT)</td>
          <td>${pos.shortShares}</td>
          <td>$${pos.shortAvgPrice.toFixed(2)}</td>
          <td class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${Math.round(pnl)}</td>
        `;
        tbody.appendChild(tr);
      }
    }

    if (!hasAnyPosition) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">尚未持有任何標的部位</td></tr>';
    }
  }

  // 渲染即時排行榜名單
  renderRankings(rankings) {
    this.dom.leaderboardList.innerHTML = '';
    rankings.forEach((r, idx) => {
      const item = document.createElement('div');
      item.className = `leaderboard-item ${idx === 0 ? 'rank-1' : ''}`;

      const rate = Number(r.returnRate !== undefined ? r.returnRate : (r.pnlPercent || 0));
      const medal = idx === 0 ? '🥇 1' : (idx === 1 ? '🥈 2' : (idx === 2 ? '🥉 3' : `${idx + 1}`));
      const isMe = r.playerId === this.playerId ? ' (你)' : '';

      item.innerHTML = `
        <span class="rank-num">${medal}</span>
        <span class="player-name">${r.playerName || r.name}${isMe}</span>
        <span class="player-networth">$${Math.round(r.netWorth || 0).toLocaleString()}</span>
        <span class="player-roi ${rate >= 0 ? 'up' : 'down'}">${rate >= 0 ? '+' : ''}${rate.toFixed(2)}%</span>
      `;
      this.dom.leaderboardList.appendChild(item);
    });
  }

  renderPlayersList(players) {
    // 預設將 players 轉換為排行榜格式
    const formatted = players.map((p, idx) => ({
      playerId: p.id,
      playerName: p.name,
      netWorth: p.netWorth || 1000000,
      returnRate: p.pnlPercent || 0
    }));
    this.renderRankings(formatted);
  }

  // 更新倒數時間視覺
  updateTimerDisplay(seconds) {
    const s = Math.max(0, parseInt(seconds, 10) || 0);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    const str = `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    this.dom.timerDigits.textContent = str;

    if (s <= 15 && s > 0 && this.roomStatus === 'PLAYING') {
      this.dom.timerDigits.classList.add('urgent');
    } else {
      this.dom.timerDigits.classList.remove('urgent');
    }
  }

  // 更新房間生命週期狀態標籤
  updateStatusBadge(status) {
    const badge = this.dom.gameStatusBadge;
    badge.className = 'game-status-badge';

    switch (status) {
      case 'WAITING':
        badge.classList.add('waiting');
        badge.textContent = '等待玩家加入';
        break;
      case 'PLAYING':
        badge.classList.add('playing');
        badge.textContent = '自由交易中 · 回合結束揭曉';
        break;
      case 'SETTLING':
        badge.classList.add('settling');
        badge.textContent = '封盤強制平倉結算中...';
        break;
      case 'FINISHED':
        badge.classList.add('finished');
        badge.textContent = '比賽已結束';
        break;
    }
  }

  // 更新頂部連線狀態燈
  updateConnectionStatus(status, text) {
    this.dom.statusDot.className = `status-dot ${status}`;
    this.dom.statusText.textContent = text;
  }

  // 委託下單試算預覽
  updateOrderPreview() {
    const stock = this.stocks[this.selectedSymbol];
    if (!stock) return;

    const shares = Math.max(1, parseInt(this.dom.orderSharesInput.value, 10) || 1);
    const midPrice = stock.price;
    const depth = stock.depth || 10000;

    // 依 Kyle's Lambda 雙曲正切計算預估衝擊
    const ratio = Math.min(1.0, shares / depth);
    const alpha = 0.5;
    const impactPercent = Math.tanh(ratio * alpha) * 100;

    let execPrice = midPrice;
    let totalCost = 0;

    if (this.orderSide === 'BUY') {
      execPrice = midPrice * (1 + (impactPercent / 100) * 0.5);
      totalCost = shares * execPrice;
      this.dom.prevCostLabel.textContent = '預估所需現金:';
      this.dom.prevCostAmount.textContent = `$${Math.round(totalCost).toLocaleString()}`;
      this.dom.btnSubmitOrder.textContent = `確認買進 ${shares} 股`;
    } else if (this.orderSide === 'SELL') {
      execPrice = midPrice * (1 - (impactPercent / 100) * 0.5);
      totalCost = shares * execPrice;
      this.dom.prevCostLabel.textContent = '預估回收現金:';
      this.dom.prevCostAmount.textContent = `$${Math.round(totalCost).toLocaleString()}`;
      this.dom.btnSubmitOrder.textContent = `確認賣出 ${shares} 股`;
    } else if (this.orderSide === 'SHORT') {
      execPrice = midPrice * (1 - (impactPercent / 100) * 0.5);
      // 融券質押 100% 保證金
      totalCost = shares * execPrice;
      this.dom.prevCostLabel.textContent = '預估凍結保證金:';
      this.dom.prevCostAmount.textContent = `$${Math.round(totalCost).toLocaleString()}`;
      this.dom.btnSubmitOrder.textContent = `確認放空 ${shares} 股`;
    } else if (this.orderSide === 'COVER') {
      execPrice = midPrice * (1 + (impactPercent / 100) * 0.5);
      totalCost = shares * execPrice;
      this.dom.prevCostLabel.textContent = '預估平倉返還現金:';
      this.dom.prevCostAmount.textContent = `$${Math.round(totalCost).toLocaleString()}`;
      this.dom.btnSubmitOrder.textContent = `確認回補 ${shares} 股`;
    }

    this.dom.prevAvgPrice.textContent = `$${execPrice.toFixed(2)}`;
    const sign = (this.orderSide === 'BUY' || this.orderSide === 'COVER') ? '+' : '-';
    this.dom.prevImpact.textContent = `${sign}${impactPercent.toFixed(2)}%`;
  }

  // 綁定所有使用者介面操作監聽器
  initEventListeners() {
    // 1. 股票分頁切換
    this.dom.stockTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const sym = tab.dataset.symbol;
        if (sym && this.stocks[sym]) {
          this.selectedSymbol = sym;
          this.dom.stockTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          this.updateHeroAndChart();
          this.updateOrderPreview();
        }
      });
    });

    // 2. 圖表模式切換 (折線 vs K線)
    this.dom.btnChartModeLine.addEventListener('click', () => {
      this.chartMode = 'line';
      this.dom.btnChartModeLine.classList.add('active');
      this.dom.btnChartModeCandle.classList.remove('active');
      if (this.chart) this.chart.setMode('line');
    });

    this.dom.btnChartModeCandle.addEventListener('click', () => {
      this.chartMode = 'candle';
      this.dom.btnChartModeCandle.classList.add('active');
      this.dom.btnChartModeLine.classList.remove('active');
      if (this.chart) this.chart.setMode('candle');
    });

    // 3. 點擊複製房間代碼
    this.dom.roomPill.addEventListener('click', () => {
      if (this.roomCode && this.roomCode !== '------') {
        navigator.clipboard.writeText(this.roomCode).then(() => {
          this.showToast(`已複製房間代碼: ${this.roomCode}`, 'info');
        }).catch(() => {
          this.showToast(`房間代碼: ${this.roomCode}`, 'info');
        });
      }
    });

    // 4. 大廳對話框切換 (建立 vs 加入)
    this.dom.tabCreateRoom.addEventListener('click', () => {
      this.dom.tabCreateRoom.classList.add('active');
      this.dom.tabJoinRoom.classList.remove('active');
      this.dom.formCreateRoom.classList.add('active');
      this.dom.formJoinRoom.classList.remove('active');
    });

    this.dom.tabJoinRoom.addEventListener('click', () => {
      this.dom.tabJoinRoom.classList.add('active');
      this.dom.tabCreateRoom.classList.remove('active');
      this.dom.formJoinRoom.classList.add('active');
      this.dom.formCreateRoom.classList.remove('active');
    });

    this.dom.btnOpenLobby.addEventListener('click', () => {
      this.dom.lobbyModal.style.display = 'flex';
    });

    // 5. 建立房間提交
    this.dom.formCreateRoom.addEventListener('submit', (e) => {
      e.preventDefault();
      const hostName = this.dom.createHostName.value.trim() || '房主';
      const totalRounds = parseInt(this.dom.createDuration.value, 10) || 10;
      const roundDurationSeconds = parseInt(this.dom.createRoundDuration.value, 10) || 30;
      const initialCash = parseInt(this.dom.createInitialCash.value, 10) || 1000000;

      this.playerName = hostName;
      localStorage.setItem('stock_player_name', hostName);
      this.dom.userNameDisplay.textContent = hostName;

      this.sendMessage('CREATE_ROOM', {
        hostName,
        totalRounds,
        roundDurationSeconds,
        initialCash,
        playerId: this.playerId
      });
    });

    // 6. 加入房間提交
    this.dom.formJoinRoom.addEventListener('submit', (e) => {
      e.preventDefault();
      const roomCode = this.dom.joinRoomCode.value.trim().toUpperCase();
      const playerName = this.dom.joinPlayerName.value.trim() || '挑戰者';

      if (!roomCode || roomCode.length < 4) {
        this.showToast('請輸入正確的房間代碼', 'error');
        return;
      }

      this.playerName = playerName;
      localStorage.setItem('stock_player_name', playerName);
      this.dom.userNameDisplay.textContent = playerName;

      this.sendMessage('JOIN_ROOM', {
        roomCode,
        playerName,
        playerId: this.playerId
      });
    });

    // 7. 房主點擊開始比賽
    this.dom.btnStartGame.addEventListener('click', () => {
      if (!this.roomCode) return;
      this.sendMessage('START_GAME', { roomCode: this.roomCode });
    });

    // 8. 交易方向切換
    this.dom.sideButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const side = btn.dataset.side;
        if (!side) return;

        this.orderSide = side;
        this.dom.sideButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // 切換下單按鈕風格
        this.dom.btnSubmitOrder.className = `btn btn-action-submit ${side.toLowerCase()}`;
        this.updateOrderPreview();
      });
    });

    // 9. 委託股數輸入
    this.dom.orderSharesInput.addEventListener('input', () => {
      this.updateOrderPreview();
    });

    // 10. 快速百分比下單
    this.dom.pctButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = parseInt(btn.dataset.pct, 10);
        const stock = this.stocks[this.selectedSymbol];
        if (!stock) return;

        let maxShares = 0;
        const price = stock.price;

        if (this.orderSide === 'BUY' || this.orderSide === 'SHORT') {
          // 依可用現金計算
          maxShares = Math.floor(this.account.cash / price);
        } else if (this.orderSide === 'SELL') {
          // 依持股計算
          const pos = this.account.positions[this.selectedSymbol];
          maxShares = (pos && pos.longShares) || 0;
        } else if (this.orderSide === 'COVER') {
          // 依空單部位計算
          const pos = this.account.positions[this.selectedSymbol];
          maxShares = (pos && pos.shortShares) || 0;
        }

        const calculated = Math.max(1, Math.floor((maxShares * pct) / 100));
        this.dom.orderSharesInput.value = calculated;
        this.updateOrderPreview();
      });
    });

    // 11. 提交訂單
    this.dom.btnSubmitOrder.addEventListener('click', () => {
      if (!this.roomCode) {
        this.showToast('尚未加入任何對戰房間', 'error');
        this.dom.lobbyModal.style.display = 'flex';
        return;
      }

      if (this.roomStatus !== 'PLAYING') {
        this.showToast('目前非競技比賽中，無法下單', 'warning');
        return;
      }

      const shares = parseInt(this.dom.orderSharesInput.value, 10);
      if (!shares || shares <= 0) {
        this.showToast('請輸入合法的委託股數', 'error');
        return;
      }

      this.sendMessage('PLACE_ORDER', {
        roomCode: this.roomCode,
        stockSymbol: this.selectedSymbol,
        side: this.orderSide,
        shares
      });
    });

    // 12. 返回大廳 / 再玩一局
    this.dom.btnRestartGame.addEventListener('click', () => {
      this.dom.settlementModal.style.display = 'none';
      this.dom.lobbyModal.style.display = 'flex';
    });
  }

  // Toast 訊息彈窗提示
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    this.dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(30px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => {
        if (toast.parentElement) toast.parentElement.removeChild(toast);
      }, 300);
    }, 3500);
  }
}

// 頁面加載完成後啟動應用
window.addEventListener('DOMContentLoaded', () => {
  window.app = new StockBattleApp();
});
