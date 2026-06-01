require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, Events,
  PermissionFlagsBits, ChannelType, AuditLogEvent,
} = require('discord.js');
const { Redis } = require('@upstash/redis');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PANEL_TOKEN   = process.env.PANEL_TOKEN   || 'changeme';
const PORT          = parseInt(process.env.PORT) || 3000;

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ─── In-memory spam tracker ───────────────────────────────────────────────────
// spamMap[guildId][userId] = [timestamps]
const spamMap = {};
// raidMap[guildId] = [timestamps]
const raidMap = {};
// nukeMap[guildId] = { channelDeletes: [ts] }
const nukeMap = {};

// ─── Default settings ─────────────────────────────────────────────────────────
function defaultSettings() {
  return {
    antiSpam:       true,
    antiInvite:     true,
    antiToken:      true,
    antiGhostPing:  true,
    raidProtect:    true,
    nukeProtect:    true,
    logChannelId:   '',
    spamMsgLimit:   5,
    spamWindowSec:  5,
    warnBeforeBan:  3,
    spamChannelIds: [],
    raidThresh:     10,
    raidWindow:     10,
    nukeThresh:     3,
    allowedInvites: [],
    logNotify: {
      spam:       true,
      invite:     true,
      token:      true,
      ghostPing:  true,
      watchlist:  true,
      raid:       true,
      nuke:       true,
      newAccount: true,
      memberJoin: false,
      mute:       false,
      ban:        true,
    },
  };
}

// ─── Redis helpers ────────────────────────────────────────────────────────────
async function getSettings(guildId) {
  const raw = await redis.get(`settings:${guildId}`);
  const def = defaultSettings();
  if (!raw) return def;
  const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { ...def, ...saved, logNotify: { ...def.logNotify, ...(saved.logNotify || {}) } };
}
async function saveSettings(guildId, settings) {
  await redis.set(`settings:${guildId}`, JSON.stringify(settings));
}

async function getWarns(guildId) {
  const raw = await redis.get(`warns:${guildId}`);
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveWarns(guildId, warns) {
  await redis.set(`warns:${guildId}`, JSON.stringify(warns));
}

async function addWarn(guildId, userId, type) {
  const warns = await getWarns(guildId);
  if (!warns[userId]) warns[userId] = { spam: 0, invite: 0 };
  warns[userId][type] = (warns[userId][type] || 0) + 1;
  await saveWarns(guildId, warns);
  return warns[userId];
}

async function getWatchlist(guildId) {
  const raw = await redis.get(`watchlist:${guildId}`);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveWatchlist(guildId, list) {
  await redis.set(`watchlist:${guildId}`, JSON.stringify(list));
}

async function getNewAccs(guildId) {
  const raw = await redis.get(`newaccs:${guildId}`);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function saveNewAccs(guildId, list) {
  await redis.set(`newaccs:${guildId}`, JSON.stringify(list));
}

async function getDismissed(guildId) {
  const raw = await redis.get(`dismissed:${guildId}`);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// Action logs (สูงสุด 500 รายการ)
async function appendActionLog(guildId, userId, text) {
  const key  = `actionlogs:${guildId}`;
  const line = `[${new Date().toISOString()}] ${text}`;
  const raw  = await redis.get(key);
  const logs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  logs.unshift({ uid: userId, line });
  if (logs.length > 500) logs.length = 500;
  await redis.set(key, JSON.stringify(logs));
}

// Message store (สูงสุด 500 ข้อความ)
async function storeMessage(guildId, msgObj) {
  const key = `messages:${guildId}`;
  const raw = await redis.get(key);
  const msgs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  msgs.unshift(msgObj);
  if (msgs.length > 500) msgs.length = 500;
  await redis.set(key, JSON.stringify(msgs));
}
async function getMessages(guildId) {
  const raw = await redis.get(`messages:${guildId}`);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ─── Discord helpers ──────────────────────────────────────────────────────────
async function sendLog(guild, settings, embed) {
  if (!settings.logChannelId) return;
  try {
    const ch = await guild.channels.fetch(settings.logChannelId);
    if (ch) await ch.send({ embeds: [embed] });
  } catch (_) {}
}

function makeEmbed(color, title, description, fields = []) {
  return {
    color,
    title,
    description,
    fields,
    timestamp: new Date().toISOString(),
  };
}

async function muteUser(guild, userId, minutes, reason) {
  let muteRole = guild.roles.cache.find(r => r.name === 'Muted');
  if (!muteRole) {
    muteRole = await guild.roles.create({
      name: 'Muted',
      permissions: [],
      reason: 'Auto-created by SecureBot',
    });
    for (const [, ch] of guild.channels.cache) {
      try {
        await ch.permissionOverwrites.create(muteRole, {
          SendMessages: false,
          AddReactions: false,
          Speak: false,
        });
      } catch (_) {}
    }
  }
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new Error('ไม่พบ user');
  await member.roles.add(muteRole, reason);
  if (minutes > 0) {
    setTimeout(async () => {
      try { await member.roles.remove(muteRole); } catch (_) {}
    }, minutes * 60 * 1000);
  }
}

async function unmuteUser(guild, userId) {
  const muteRole = guild.roles.cache.find(r => r.name === 'Muted');
  if (!muteRole) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new Error('ไม่พบ user');
  await member.roles.remove(muteRole);
}

// ─── Anti-Spam ────────────────────────────────────────────────────────────────
async function checkSpam(message, settings) {
  const { guildId, author, channelId } = message;
  if (!settings.antiSpam) return;
  if (settings.spamChannelIds.length && !settings.spamChannelIds.includes(channelId)) return;

  if (!spamMap[guildId]) spamMap[guildId] = {};
  if (!spamMap[guildId][author.id]) spamMap[guildId][author.id] = [];

  const now    = Date.now();
  const window = settings.spamWindowSec * 1000;
  spamMap[guildId][author.id] = spamMap[guildId][author.id].filter(t => now - t < window);
  spamMap[guildId][author.id].push(now);

  if (spamMap[guildId][author.id].length >= settings.spamMsgLimit) {
    spamMap[guildId][author.id] = [];
    const guild  = message.guild;
    const member = await guild.members.fetch(author.id).catch(() => null);
    if (!member) return;

    const warns = await addWarn(guildId, author.id, 'spam');
    await appendActionLog(guildId, author.id, `Spam detected — warns: spam=${warns.spam}`);

    if (settings.warnBeforeBan > 0 && warns.spam < settings.warnBeforeBan) {
      await muteUser(guild, author.id, 10, 'Anti-Spam').catch(() => {});
      try { await message.reply(`⚠️ ${author} ส่งข้อความเร็วเกินไป! เตือนครั้งที่ ${warns.spam}/${settings.warnBeforeBan}`); } catch (_) {}
      if (settings.logNotify?.spam) {
        await sendLog(guild, settings, makeEmbed(0xed4245, '🚫 Spam Detected',
          `<@${author.id}> ส่งข้อความ spam — muted 10 นาที`,
          [{ name: 'Warn', value: `${warns.spam}/${settings.warnBeforeBan}` }]));
      }
    } else {
      await member.ban({ reason: 'Auto-ban: Spam' }).catch(() => {});
      if (settings.logNotify?.spam) {
        await sendLog(guild, settings, makeEmbed(0xed4245, '🚫 Spam → Auto Ban',
          `<@${author.id}> ถูก ban อัตโนมัติจาก spam`));
      }
    }
  }
}

// ─── Anti-Invite ──────────────────────────────────────────────────────────────
const INVITE_REGEX = /discord(?:\.gg|app\.com\/invite|\.com\/invite)\/([a-zA-Z0-9\-]+)/gi;

async function checkInvite(message, settings) {
  if (!settings.antiInvite) return;
  const matches = [...message.content.matchAll(INVITE_REGEX)];
  if (!matches.length) return;

  const allowed = (settings.allowedInvites || []).map(s => s.toLowerCase());
  const blocked = matches.filter(m => !allowed.includes(m[1].toLowerCase()));
  if (!blocked.length) return;

  await message.delete().catch(() => {});
  const { guildId, author, guild } = message;
  const warns = await addWarn(guildId, author.id, 'invite');
  await appendActionLog(guildId, author.id, `Invite link detected — warns: invite=${warns.invite}`);

  if (settings.warnBeforeBan > 0 && warns.invite < settings.warnBeforeBan) {
    try { await message.channel.send(`⚠️ ${author} ห้ามส่งลิงก์ invite! เตือนครั้งที่ ${warns.invite}/${settings.warnBeforeBan}`); } catch (_) {}
    if (settings.logNotify?.invite) {
      await sendLog(guild, settings, makeEmbed(0xfaa61a, '🔗 Invite Link Detected',
        `<@${author.id}> ส่งลิงก์ invite — ลบแล้ว`,
        [{ name: 'Warn', value: `${warns.invite}/${settings.warnBeforeBan}` }]));
    }
  } else {
    const member = await guild.members.fetch(author.id).catch(() => null);
    if (member) await member.ban({ reason: 'Auto-ban: Invite spam' }).catch(() => {});
    if (settings.logNotify?.invite) {
      await sendLog(guild, settings, makeEmbed(0xed4245, '🔗 Invite → Auto Ban',
        `<@${author.id}> ถูก ban จากการส่ง invite link ซ้ำ`));
    }
  }
}

// ─── Anti-Token ───────────────────────────────────────────────────────────────
const TOKEN_REGEX = /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/;

async function checkToken(message, settings) {
  if (!settings.antiToken) return;
  if (!TOKEN_REGEX.test(message.content)) return;
  await message.delete().catch(() => {});
  const { guild, author } = message;
  const member = await guild.members.fetch(author.id).catch(() => null);
  if (member) await member.ban({ reason: 'Token grabber detected' }).catch(() => {});
  await appendActionLog(message.guildId, author.id, 'Token grabber message detected — auto banned');
  if (settings.logNotify?.token) {
    await sendLog(guild, settings, makeEmbed(0xed4245, '🪝 Token Grabber Detected',
      `<@${author.id}> ส่งข้อความที่มี token — banned ทันที`));
  }
}

// ─── Ghost Ping ───────────────────────────────────────────────────────────────
const ghostPingMap = {}; // [guildId][msgId] = { mentions, author }

async function checkGhostPing(message) {
  if (!message.mentions.users.size) return;
  if (!ghostPingMap[message.guildId]) ghostPingMap[message.guildId] = {};
  ghostPingMap[message.guildId][message.id] = {
    mentions: [...message.mentions.users.keys()],
    author:   message.author.id,
    channel:  message.channelId,
  };
}

async function handleDeletedGhostPing(message, settings) {
  if (!settings.antiGhostPing) return;
  const data = ghostPingMap[message.guildId]?.[message.id];
  if (!data || !data.mentions.length) return;
  delete ghostPingMap[message.guildId][message.id];

  const pings = data.mentions.map(id => `<@${id}>`).join(', ');
  await appendActionLog(message.guildId, data.author, `Ghost ping detected — pinged: ${pings}`);
  if (settings.logNotify?.ghostPing) {
    const ch = await message.guild.channels.fetch(data.channel).catch(() => null);
    await sendLog(message.guild, settings, makeEmbed(0xfaa61a, '👻 Ghost Ping Detected',
      `<@${data.author}> ลบข้อความที่ ping ${pings}`,
      [{ name: 'ห้อง', value: ch ? `<#${ch.id}>` : data.channel }]));
  }
}

// ─── Raid Protection ──────────────────────────────────────────────────────────
async function checkRaid(member, settings) {
  if (!settings.raidProtect) return;
  const { guild } = member;
  if (!raidMap[guild.id]) raidMap[guild.id] = [];
  const now    = Date.now();
  const window = settings.raidWindow * 1000;
  raidMap[guild.id] = raidMap[guild.id].filter(t => now - t < window);
  raidMap[guild.id].push(now);

  if (raidMap[guild.id].length >= settings.raidThresh) {
    raidMap[guild.id] = [];
    await appendActionLog(guild.id, 'SYSTEM', `Raid detected — ${settings.raidThresh} joins in ${settings.raidWindow}s`);
    if (settings.logNotify?.raid) {
      await sendLog(guild, settings, makeEmbed(0xed4245, '🚨 Raid Detected!',
        `มีคนเข้าเซิร์ฟ ${settings.raidThresh} คนใน ${settings.raidWindow} วินาที!`,
        [{ name: 'คำแนะนำ', value: 'เปิด slowmode หรือ lockdown ชั่วคราว' }]));
    }
  }
}

// ─── Nuke Protection ──────────────────────────────────────────────────────────
async function checkNuke(guild, settings) {
  if (!settings.nukeProtect) return;
  if (!nukeMap[guild.id]) nukeMap[guild.id] = [];
  const now = Date.now();
  nukeMap[guild.id] = nukeMap[guild.id].filter(t => now - t < 10000);
  nukeMap[guild.id].push(now);

  if (nukeMap[guild.id].length >= settings.nukeThresh) {
    nukeMap[guild.id] = [];
    await appendActionLog(guild.id, 'SYSTEM', `Nuke attempt detected — ${settings.nukeThresh} channel deletes in 10s`);
    if (settings.logNotify?.nuke) {
      await sendLog(guild, settings, makeEmbed(0xed4245, '💣 Nuke Attempt Detected!',
        `มีการลบห้อง ${settings.nukeThresh} ห้องใน 10 วินาที!`,
        [{ name: 'คำแนะนำ', value: 'ตรวจสอบ audit log ทันที' }]));
    }
  }
}

// ─── Watchlist check ──────────────────────────────────────────────────────────
async function checkWatchlist(guildId, userId, event, settings, guild) {
  const list = await getWatchlist(guildId);
  if (!list.includes(userId)) return;
  await appendActionLog(guildId, userId, `Watchlist alert: ${event}`);
  if (settings.logNotify?.watchlist) {
    await sendLog(guild, settings, makeEmbed(0x5865f2, '👁️ Watchlist Alert',
      `<@${userId}> — ${event}`));
  }
}

// ─── New Account Check ────────────────────────────────────────────────────────
async function checkNewAccount(member, settings) {
  const accountAge = Date.now() - member.user.createdTimestamp;
  const ageDays    = Math.floor(accountAge / 86400000);
  if (ageDays >= 30) return;

  const dismissed = await getDismissed(member.guild.id);
  if (dismissed.includes(member.id)) return;

  const list = await getNewAccs(member.guild.id);
  if (list.find(a => a.id === member.id)) return;

  const entry = {
    id:       member.id,
    tag:      member.user.tag,
    avatar:   member.user.displayAvatarURL({ size: 64 }),
    ageDays,
    joinedAt: member.joinedTimestamp,
  };
  list.unshift(entry);
  if (list.length > 200) list.length = 200;
  await saveNewAccs(member.guild.id, list);

  if (settings.logNotify?.newAccount) {
    await sendLog(member.guild, settings, makeEmbed(0xfaa61a, '🆕 New Account Joined',
      `<@${member.id}> (${member.user.tag}) อายุบัญชีแค่ **${ageDays} วัน**!`));
  }
}

// ─── Discord Events ───────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  // บันทึกข้อความ
  await storeMessage(message.guildId, {
    id:      message.id,
    uid:     message.author.id,
    tag:     message.author.tag,
    avatar:  message.author.displayAvatarURL({ size: 64 }),
    content: message.content,
    channel: message.channel.name,
    ts:      message.createdTimestamp,
    deleted: false,
  });

  const settings = await getSettings(message.guildId);
  const member   = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  await checkSpam(message, settings);
  await checkInvite(message, settings);
  await checkToken(message, settings);
  await checkGhostPing(message);
  await checkWatchlist(message.guildId, message.author.id, 'ส่งข้อความ', settings, message.guild);
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guild || message.author?.bot) return;
  // mark as deleted in store
  const key  = `messages:${message.guildId}`;
  const raw  = await redis.get(key);
  const msgs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  const idx  = msgs.findIndex(m => m.id === message.id);
  if (idx !== -1) {
    msgs[idx].deleted   = true;
    msgs[idx].deletedAt = Date.now();
    await redis.set(key, JSON.stringify(msgs));
  }

  const settings = await getSettings(message.guildId);
  await handleDeletedGhostPing(message, settings);
});

client.on(Events.GuildMemberAdd, async (member) => {
  const settings = await getSettings(member.guild.id);
  await checkRaid(member, settings);
  await checkNewAccount(member, settings);
  await checkWatchlist(member.guild.id, member.id, 'เข้าเซิร์ฟเวอร์', settings, member.guild);

  if (settings.logNotify?.memberJoin) {
    await sendLog(member.guild, settings, makeEmbed(0x3ba55d, '🚪 Member Joined',
      `<@${member.id}> (${member.user.tag}) เข้าเซิร์ฟแล้ว`));
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild) return;
  const settings = await getSettings(channel.guild.id);
  await checkNuke(channel.guild, settings);
});

// ─── HTTP Panel API ───────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function authCheck(req, res) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${PANEL_TOKEN}`) {
    jsonRes(res, { error: 'Unauthorized' }, 401);
    return false;
  }
  return true;
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

async function userProfile(userId) {
  try {
    const u = await client.users.fetch(userId, { force: true });
    return {
      id:          u.id,
      username:    u.username,
      displayName: u.displayName || u.username,
      avatar:      u.displayAvatarURL({ size: 128 }),
      banner:      u.bannerURL?.({ size: 256 }) || null,
      accentColor: u.accentColor || null,
      bot:         u.bot,
      createdAt:   u.createdTimestamp,
    };
  } catch {
    return { id: userId, username: userId, displayName: userId, avatar: null };
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  // ── Serve panel.html ──────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/panel') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── API routes ────────────────────────────────────────────────────────────
  if (!pathname.startsWith('/api')) {
    res.writeHead(404); res.end('Not found'); return;
  }

  if (!authCheck(req, res)) return;

  // GET /api/guilds
  if (pathname === '/api/guilds' && req.method === 'GET') {
    const guilds = client.guilds.cache.map(g => ({
      id:          g.id,
      name:        g.name,
      icon:        g.iconURL({ size: 64 }),
      memberCount: g.memberCount,
    }));
    return jsonRes(res, guilds);
  }

  // GET /api/user/:uid/profile
  const userMatch = pathname.match(/^\/api\/user\/([^/]+)\/profile$/);
  if (userMatch && req.method === 'GET') {
    return jsonRes(res, await userProfile(userMatch[1]));
  }

  // Guild-specific routes
  const guildMatch = pathname.match(/^\/api\/guild\/([^/]+)(\/.*)?$/);
  if (!guildMatch) { res.writeHead(404); res.end(); return; }

  const guildId  = guildMatch[1];
  const subpath  = guildMatch[2] || '';
  const guild    = client.guilds.cache.get(guildId);
  if (!guild) return jsonRes(res, { error: 'Guild not found' }, 404);

  const settings = await getSettings(guildId);

  // GET /api/guild/:id
  if (subpath === '' && req.method === 'GET') {
    const channels = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const watchlist = await getWatchlist(guildId);
    return jsonRes(res, {
      id: guild.id, name: guild.name,
      memberCount: guild.memberCount,
      settings, channels, watchlist,
    });
  }

  // POST /api/guild/:id/settings
  if (subpath === '/settings' && req.method === 'POST') {
    const body = await readBody(req);
    await saveSettings(guildId, body);
    return jsonRes(res, { ok: true });
  }

  // GET /api/guild/:id/warns
  if (subpath === '/warns' && req.method === 'GET') {
    const warns = await getWarns(guildId);
    const list  = Object.entries(warns).map(([uid, w]) => ({ uid, ...w }));
    return jsonRes(res, { warns: list });
  }

  // POST /api/guild/:id/clearwarns
  if (subpath === '/clearwarns' && req.method === 'POST') {
    const body  = await readBody(req);
    const warns = await getWarns(guildId);
    delete warns[body.userId];
    await saveWarns(guildId, warns);
    return jsonRes(res, { ok: true });
  }

  // GET /api/guild/:id/actionlogs
  if (subpath === '/actionlogs' && req.method === 'GET') {
    const raw  = await redis.get(`actionlogs:${guildId}`);
    const logs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return jsonRes(res, { logs });
  }

  // GET /api/guild/:id/messages
  if (subpath === '/messages' && req.method === 'GET') {
    let msgs = await getMessages(guildId);
    if (query.uid)     msgs = msgs.filter(m => m.uid === query.uid);
    if (query.channel) msgs = msgs.filter(m => m.channel?.includes(query.channel));
    if (query.deleted) msgs = msgs.filter(m => m.deleted);
    return jsonRes(res, { messages: msgs.slice(0, 500) });
  }

  // GET /api/guild/:id/newaccs
  if (subpath === '/newaccs' && req.method === 'GET') {
    const dismissed = await getDismissed(guildId);
    const list = (await getNewAccs(guildId)).filter(a => !dismissed.includes(a.id));
    return jsonRes(res, { accounts: list });
  }

  // POST /api/guild/:id/dismiss-newacc
  if (subpath === '/dismiss-newacc' && req.method === 'POST') {
    const body = await readBody(req);
    const raw  = await redis.get(`dismissed:${guildId}`);
    const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    if (!list.includes(body.userId)) list.push(body.userId);
    await redis.set(`dismissed:${guildId}`, JSON.stringify(list));
    return jsonRes(res, { ok: true });
  }

  // POST /api/guild/:id/watchlist
  if (subpath === '/watchlist' && req.method === 'POST') {
    const body = await readBody(req);
    const list = await getWatchlist(guildId);
    if (body.action === 'add' && !list.includes(body.userId)) {
      list.push(body.userId);
      await appendActionLog(guildId, body.userId, 'Added to watchlist via Panel');
    } else if (body.action === 'remove') {
      const idx = list.indexOf(body.userId);
      if (idx !== -1) list.splice(idx, 1);
      await appendActionLog(guildId, body.userId, 'Removed from watchlist via Panel');
    }
    await saveWatchlist(guildId, list);
    return jsonRes(res, { ok: true });
  }

  // POST /api/guild/:id/mute
  if (subpath === '/mute' && req.method === 'POST') {
    const body = await readBody(req);
    await muteUser(guild, body.userId, body.minutes || 10, body.reason || 'Muted via Panel');
    await appendActionLog(guildId, body.userId, `Muted ${body.minutes || 10} นาที via Panel — ${body.reason || ''}`);
    if (settings.logNotify?.mute) {
      await sendLog(guild, settings, makeEmbed(0xf97316, '🔇 User Muted',
        `<@${body.userId}> ถูก mute ${body.minutes} นาที จาก Panel`));
    }
    return jsonRes(res, { ok: true });
  }

  // POST /api/guild/:id/unmute
  if (subpath === '/unmute' && req.method === 'POST') {
    const body = await readBody(req);
    await unmuteUser(guild, body.userId);
    await appendActionLog(guildId, body.userId, 'Unmuted via Panel');
    if (settings.logNotify?.mute) {
      await sendLog(guild, settings, makeEmbed(0x3ba55d, '🔊 User Unmuted',
        `<@${body.userId}> ถูก unmute จาก Panel`));
    }
    return jsonRes(res, { ok: true });
  }

  // POST /api/guild/:id/ban
  if (subpath === '/ban' && req.method === 'POST') {
    const body   = await readBody(req);
    const member = await guild.members.fetch(body.userId).catch(() => null);
    if (!member) return jsonRes(res, { error: 'Member not found' }, 404);
    await member.ban({ reason: body.reason || 'Banned via Panel' });
    await appendActionLog(guildId, body.userId, `Banned via Panel — ${body.reason || ''}`);
    if (settings.logNotify?.ban) {
      await sendLog(guild, settings, makeEmbed(0xed4245, '🔨 User Banned',
        `<@${body.userId}> ถูก ban จาก Panel`,
        [{ name: 'เหตุผล', value: body.reason || '—' }]));
    }
    return jsonRes(res, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

// ─── Keep-alive (Render free tier) ───────────────────────────────────────────
setInterval(() => {
  http.get(`http://localhost:${PORT}/`).on('error', () => {});
}, 14 * 60 * 1000); // ping ตัวเองทุก 14 นาที

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`🌐 Panel server running on port ${PORT}`));
client.login(DISCORD_TOKEN);
