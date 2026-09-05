import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import { pathToFileURL } from 'node:url';
import { RoomManager } from './models/roomManager.js';

const commands = [
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('回合制股票對戰')
    .addSubcommand(s => s.setName('create').setDescription('建立房間')
      .addIntegerOption(o => o.setName('rounds').setDescription('總回合數').setMinValue(1).setMaxValue(50))
      .addIntegerOption(o => o.setName('seconds').setDescription('每回合交易秒數').setMinValue(10).setMaxValue(300))
      .addIntegerOption(o => o.setName('cash').setDescription('初始資金').setMinValue(10000)))
    .addSubcommand(s => s.setName('join').setDescription('加入房間')
      .addStringOption(o => o.setName('code').setDescription('六碼房間代碼').setRequired(true)))
    .addSubcommand(s => s.setName('start').setDescription('房主開始比賽'))
    .addSubcommand(s => s.setName('trade').setDescription('在本回合下單')
      .addStringOption(o => o.setName('symbol').setDescription('股票').setRequired(true)
        .addChoices(...['MEGA', 'NVTX', 'SOLR', 'MEME'].map(value => ({ name: value, value }))))
      .addStringOption(o => o.setName('side').setDescription('方向').setRequired(true)
        .addChoices(
          { name: '買進', value: 'BUY' }, { name: '賣出', value: 'SELL' },
          { name: '放空', value: 'SHORT' }, { name: '回補', value: 'COVER' }
        ))
      .addIntegerOption(o => o.setName('shares').setDescription('股數').setRequired(true).setMinValue(1).setMaxValue(10000000)))
    .addSubcommand(s => s.setName('market').setDescription('查看最近一次揭曉行情'))
    .addSubcommand(s => s.setName('portfolio').setDescription('查看自己的資產與持倉'))
    .addSubcommand(s => s.setName('status').setDescription('查看目前回合與玩家'))
    .addSubcommand(s => s.setName('help').setDescription('查看玩法與指令'))
].map(command => command.toJSON());

const money = value => `$${Number(value || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`;

function marketText(room) {
  const lines = Object.values(room.marketState || {}).map(stock => {
    const sign = stock.changePercent >= 0 ? '+' : '';
    return `**${stock.symbol}** ${money(stock.price)} (${sign}${Number(stock.changePercent || 0).toFixed(2)}%)`;
  });
  return `📊 **第 ${room.currentRound} 輪揭曉行情**\n${lines.join('\n')}`;
}

function rankingText(room) {
  const rows = [...room.players.values()]
    .sort((a, b) => b.netWorth - a.netWorth)
    .map((p, index) => `${index + 1}. ${p.name} — ${money(p.netWorth)} (${Number(p.pnlPercent || 0).toFixed(2)}%)`);
  return `🏆 **排行榜**\n${rows.join('\n')}`;
}

function roomText(room) {
  const phase = room.status === 'PLAYING'
    ? `第 ${room.currentRound}/${room.totalRounds} 輪，剩餘 ${room.remainingTurnSeconds} 秒`
    : room.status;
  return `**房間 ${room.roomCode}** · ${phase}\n每輪 ${room.roundDurationSeconds} 秒｜玩家：${[...room.players.values()].map(p => p.name).join('、')}`;
}

function portfolioText(player) {
  const positions = Object.entries(player.positions || {})
    .filter(([, p]) => p.longShares || p.shortShares)
    .map(([symbol, p]) => `${symbol}: 多 ${p.longShares || 0} / 空 ${p.shortShares || 0}`);
  return `💼 **${player.name} 的資產**\n淨值 ${money(player.netWorth)}｜現金 ${money(player.cash)}｜報酬 ${Number(player.pnlPercent || 0).toFixed(2)}%\n${positions.length ? positions.join('\n') : '目前沒有持倉'}`;
}

export class DiscordStockBot {
  constructor({ token, guildId, roomManager = new RoomManager(), client } = {}) {
    if (!token) throw new Error('缺少 DISCORD_TOKEN');
    this.token = token;
    this.guildId = guildId;
    this.roomManager = roomManager;
    this.client = client || new Client({ intents: [GatewayIntentBits.Guilds] });
    this.transports = new Map();
  }

  getTransport(userId) {
    return this.transports.get(userId);
  }

  createTransport(interaction, announcer = false) {
    const userId = interaction.user.id;
    const transport = {
      readyState: 1,
      playerId: `discord:${userId}`,
      roomId: null,
      messages: [],
      announcedNewsCount: 0,
      send: raw => {
        const message = JSON.parse(raw);
        transport.messages.push(message);
        if (transport.messages.length > 50) transport.messages.shift();
        if (announcer && message.type === 'TURN_STATE' && message.payload.phase === 'REVEAL') {
          const room = this.roomManager.getRoom(transport.roomId);
          if (room) {
            const freshNews = room.newsHistory.slice(transport.announcedNewsCount);
            transport.announcedNewsCount = room.newsHistory.length;
            const newsText = freshNews.length
              ? `\n\n📰 **本輪新聞**\n${freshNews.map(item => `• ${item.title}`).join('\n')}`
              : '';
            interaction.channel?.send(`${marketText(room)}${newsText}\n\n${rankingText(room)}`).catch(console.error);
          }
        }
        if (announcer && message.type === 'GAME_OVER') {
          const winner = message.payload.winner;
          interaction.channel?.send(`🎉 **比賽結束！${winner?.name || '無人'} 獲勝**\n最終淨值 ${money(winner?.netWorth)}\n\n${rankingText(this.roomManager.getRoom(transport.roomId))}`).catch(console.error);
        }
      }
    };
    this.transports.set(userId, transport);
    return transport;
  }

  take(transport, type) {
    for (let i = transport.messages.length - 1; i >= 0; i--) {
      if (transport.messages[i].type === type) return transport.messages[i].payload;
    }
    return null;
  }

  async registerCommands() {
    const rest = new REST({ version: '10' }).setToken(this.token);
    const applicationId = this.client.application.id;
    const route = this.guildId
      ? Routes.applicationGuildCommands(applicationId, this.guildId)
      : Routes.applicationCommands(applicationId);
    await rest.put(route, { body: commands });
    console.log(`[Discord] 已註冊 ${this.guildId ? '伺服器' : '全域'} /stock 指令`);
  }

  async handleInteraction(interaction) {
    if (!(interaction instanceof ChatInputCommandInteraction) || interaction.commandName !== 'stock') return;
    const sub = interaction.options.getSubcommand();

    if (sub === 'help') {
      await interaction.reply('每輪所有玩家可用 `/stock trade` 自由交易；盤中價格與排名不公開，倒數結束後才統一揭曉。\n指令：`create`、`join`、`start`、`trade`、`market`、`portfolio`、`status`。');
      return;
    }

    if (sub === 'create') {
      const existing = this.getTransport(interaction.user.id);
      if (existing?.roomId && this.roomManager.getRoom(existing.roomId)?.status !== 'FINISHED') {
        await interaction.reply({ content: '你已在一個尚未結束的房間中。', ephemeral: true });
        return;
      }
      const ws = this.createTransport(interaction, true);
      const room = this.roomManager.createRoom(ws, {
        playerId: ws.playerId,
        hostName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
        totalRounds: interaction.options.getInteger('rounds') || 10,
        roundDurationSeconds: interaction.options.getInteger('seconds') || 30,
        initialCash: interaction.options.getInteger('cash') || 1000000
      });
      await interaction.reply(`✅ 已建立 ${roomText(room)}\n使用 \`/stock join code:${room.roomCode}\` 加入。`);
      return;
    }

    if (sub === 'join') {
      const ws = this.getTransport(interaction.user.id) || this.createTransport(interaction, false);
      ws.messages.length = 0;
      const code = interaction.options.getString('code').trim().toUpperCase();
      const room = this.roomManager.joinRoom(ws, {
        roomCode: code,
        playerId: ws.playerId,
        playerName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username
      });
      const error = this.take(ws, 'ERROR');
      await interaction.reply(room ? `✅ 已加入 ${roomText(room)}` : { content: error?.message || '無法加入房間', ephemeral: true });
      return;
    }

    const ws = this.getTransport(interaction.user.id);
    const room = ws?.roomId ? this.roomManager.getRoom(ws.roomId) : null;
    if (!ws || !room) {
      await interaction.reply({ content: '請先建立或加入房間。', ephemeral: true });
      return;
    }

    if (sub === 'start') {
      ws.messages.length = 0;
      this.roomManager.startGame(ws, { roomCode: room.roomCode });
      const error = this.take(ws, 'ERROR');
      await interaction.reply(error ? { content: error.message, ephemeral: true } : `🚦 ${roomText(room)}\n所有玩家現在都可自由下單。`);
    } else if (sub === 'trade') {
      ws.messages.length = 0;
      this.roomManager.handleOrder(ws, {
        roomCode: room.roomCode,
        stockSymbol: interaction.options.getString('symbol'),
        side: interaction.options.getString('side'),
        shares: interaction.options.getInteger('shares')
      });
      const result = this.take(ws, 'ORDER_ACK');
      await interaction.reply({
        content: result?.success
          ? `✅ ${result.message}：${result.symbol} ${result.shares} 股，成交均價 ${money(result.price)}`
          : `❌ ${result?.message || '下單失敗'}`,
        ephemeral: true
      });
    } else if (sub === 'market') {
      await interaction.reply(marketText(room));
    } else if (sub === 'portfolio') {
      await interaction.reply({ content: portfolioText(room.players.get(ws.playerId)), ephemeral: true });
    } else if (sub === 'status') {
      await interaction.reply(roomText(room));
    }
  }

  async start() {
    this.client.once('ready', async () => {
      console.log(`[Discord] ${this.client.user.tag} 已上線`);
      try { await this.registerCommands(); } catch (error) { console.error('[Discord] 註冊指令失敗:', error); }
    });
    this.client.on('interactionCreate', interaction => this.handleInteraction(interaction).catch(async error => {
      console.error('[Discord] 指令處理失敗:', error);
      const payload = { content: '指令執行失敗，請稍後再試。', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }));
    await this.client.login(this.token);
  }
}

export async function startDiscordBot(env = process.env) {
  const bot = new DiscordStockBot({ token: env.DISCORD_TOKEN, guildId: env.DISCORD_GUILD_ID });
  await bot.start();
  return bot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDiscordBot().catch(error => {
    console.error('[Discord] 啟動失敗:', error.message);
    process.exitCode = 1;
  });
}
