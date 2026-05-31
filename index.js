require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { Redis } = require('@upstash/redis');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── config ────────────────────────────────────────────────
const PREFIX       = process.env.PREFIX || '!';
const LOG_CHANNEL  = process.env.LOG_CHANNEL_ID;
const SPAM_CHANNELS = (process.env.SPAM_CHANNEL_ID || '')
  .split(',').map(id => id.trim()).filter(Boolean); // รองรับหลายห้อง คั่นด้วย ,
const CACHE_TTL    = 30;
const SNIPE_CD     = 5000;
const RAID_WINDOW  = 10;
const RAID_THRESH  = 5;
const NUKE_THRESH  = 3;

// anti-spam
const SPAM_MSG_LIMIT   = 1;
const SPAM_WINDOW_SEC  = 5;
const WARN_BEFORE_BAN  = 0;   // warn กี่ครั้งก่อนแบน (0 = แบนทันที)

// anti-invite link
// ALLOWED_INVITES ใน .env: คั่นด้วย , เช่น  ALLOWED_INVITES=abc123,xyz456
const INVITE_REGEX     = /discord(?:\.gg|(?:app)?\.com\/invite)\/([a-zA-Z0-9\-]+)/gi;
const ALLOWED_INVITES  = (process.env.ALLOWED_INVITES || '')
  .split(',').map(c => c.trim().toLowerCase()).filter(Boolean);

// ── helpers ───────────────────────────────────────────────
async function getLog(guild) {
  return guild?.channels.cache.get(LOG_CHANNEL);
}

function embed(color, title, desc) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();
}

function isMod(member) {
  if (!member) return false;
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

async function logAction(userId, guildId, action) {
  if (!userId || !guildId) return;
  const key = `userlog:${guildId}:${userId}`;
  await redis.lpush(key, `[${new Date().toISOString()}] ${action}`);
  await redis.ltrim(key, 0, 49);
  await redis.expire(key, 60 * 60 * 24 * 7);
}

// ── anti-spam (ห้อง SPAM_CHANNEL หรือทุกห้องถ้าไม่ตั้งค่า) ──
async function checkSpam(msg) {
  if (msg.author.bot) return;
  if (!msg.member) return;
  if (isMod(msg.member)) return;

  const key   = `spam:${msg.guild.id}:${msg.author.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, SPAM_WINDOW_SEC);
  if (count < SPAM_MSG_LIMIT) return;

  await logAction(msg.author.id, msg.guild.id, `SPAM detected (${count} ข้อความใน ${SPAM_WINDOW_SEC} วิ)`);

  // ลบข้อความ
  try {
    const msgs     = await msg.channel.messages.fetch({ limit: 20 });
    const toDelete = msgs.filter(m => m.author.id === msg.author.id && Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    if (toDelete.size > 1) await msg.channel.bulkDelete(toDelete);
    else await msg.delete().catch(() => {});
  } catch {}

  const warnKey = `spamwarn:${msg.guild.id}:${msg.author.id}`;
  const warns   = await redis.incr(warnKey);
  await redis.expire(warnKey, 60 * 60 * 24);

  const log = await getLog(msg.guild);

  if (warns <= WARN_BEFORE_BAN) {
    // warn ก่อน
    const warnMsg = await msg.channel.send({ embeds: [
      embed('#FEE75C', '⚠️ คำเตือน',
        `<@${msg.author.id}> หยุดส่งสแปม! (เตือนครั้งที่ ${warns}/${WARN_BEFORE_BAN})\nอีก ${WARN_BEFORE_BAN - warns + 1} ครั้งจะถูกแบนอัตโนมัติ`)
    ]});
    setTimeout(() => warnMsg.delete().catch(() => {}), 8000);
    log?.send({ embeds: [embed('#FEE75C', '⚠️ Spam Warn',
      `**${msg.author.tag}** (\`${msg.author.id}\`) ถูกเตือนสแปมในห้อง <#${msg.channel.id}> (ครั้งที่ ${warns})`)] });
  } else {
    // แบนเลย
    try {
      await msg.member.ban({ deleteMessageSeconds: 3600, reason: `Auto-ban: spam (${warns} ครั้ง)` });
      log?.send({ embeds: [embed('#ED4245', '🔨 Auto Ban — Spam',
        `**${msg.author.tag}** (\`${msg.author.id}\`) ถูก ban เนื่องจากสแปมซ้ำ ${warns} ครั้ง ในห้อง <#${msg.channel.id}>`)] });
      await redis.del(warnKey);
    } catch {
      log?.send({ embeds: [embed('#ED4245', '❌ Ban Failed',
        `ไม่สามารถ ban **${msg.author.tag}** ได้ — ตรวจสอบ permission บอท`)] });
    }
  }
}

// ── anti-invite link (ทุกห้อง) ────────────────────────────
async function checkInvite(msg) {
  if (msg.author.bot) return;
  if (!msg.member) return;
  if (isMod(msg.member)) return;

  const matches = [...msg.content.matchAll(INVITE_REGEX)];
  if (!matches.length) return;

  const blocked = matches.filter(m => !ALLOWED_INVITES.includes(m[1].toLowerCase()));
  if (!blocked.length) return;

  // ลบข้อความที่มีลิงก์
  await msg.delete().catch(() => {});
  await logAction(msg.author.id, msg.guild.id,
    `ส่ง invite link ที่ไม่ได้รับอนุญาต: ${blocked.map(m => m[0]).join(', ')}`);

  const warnKey = `invwarn:${msg.guild.id}:${msg.author.id}`;
  const warns   = await redis.incr(warnKey);
  await redis.expire(warnKey, 60 * 60 * 24);

  const log = await getLog(msg.guild);

  if (warns <= WARN_BEFORE_BAN) {
    const warnMsg = await msg.channel.send({ embeds: [
      embed('#FEE75C', '⚠️ คำเตือน',
        `<@${msg.author.id}> ห้ามส่งลิงก์เชิญดิสคอร์ดในเซิร์ฟนี้! (ครั้งที่ ${warns}/${WARN_BEFORE_BAN})\nอีก ${WARN_BEFORE_BAN - warns + 1} ครั้งจะถูกแบนอัตโนมัติ`)
    ]});
    setTimeout(() => warnMsg.delete().catch(() => {}), 8000);
    log?.send({ embeds: [embed('#FEE75C', '⚠️ Invite Link Warn',
      `**${msg.author.tag}** (\`${msg.author.id}\`) ส่ง invite ที่ไม่ได้รับอนุญาตใน <#${msg.channel.id}> (ครั้งที่ ${warns})\n\`${blocked.map(m => m[0]).join(', ')}\``)] });
  } else {
    try {
      await msg.member.ban({ deleteMessageSeconds: 3600, reason: `Auto-ban: invite link (${warns} ครั้ง)` });
      log?.send({ embeds: [embed('#ED4245', '🔨 Auto Ban — Invite Link',
        `**${msg.author.tag}** (\`${msg.author.id}\`) ถูก ban เนื่องจากส่ง invite link ซ้ำ ${warns} ครั้ง`)] });
      await redis.del(warnKey);
    } catch {
      log?.send({ embeds: [embed('#ED4245', '❌ Ban Failed',
        `ไม่สามารถ ban **${msg.author.tag}** ได้ — ตรวจสอบ permission บอท`)] });
    }
  }
}

// ── events ────────────────────────────────────────────────
client.on('messageDelete', async (msg) => {
  if (msg.author?.bot) return;
  await redis.set(`snipe:${msg.channel.id}`, JSON.stringify({
    content: msg.content || '[embed/attachment]',
    author: msg.author?.tag,
    avatar: msg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL });
  await logAction(msg.author?.id, msg.guild?.id, `ลบข้อความใน #${msg.channel.name}: "${msg.content?.slice(0, 80)}"`);

  if (msg.mentions.users.size > 0 || msg.mentions.roles.size > 0) {
    await logAction(msg.author?.id, msg.guild?.id, `GHOST PING ใน #${msg.channel.name}`);
    const log = await getLog(msg.guild);
    log?.send({ embeds: [embed('#ED4245', '👻 Ghost Ping',
      `**${msg.author?.tag}** (\`${msg.author?.id}\`) ping แล้วลบใน <#${msg.channel.id}>\n\`${msg.content}\``)] });
  }

  const inWatch = await redis.sismember(`watchlist:${msg.guild?.id}`, msg.author?.id);
  if (inWatch) {
    const log = await getLog(msg.guild);
    log?.send({ embeds: [embed('#FEE75C', '👁 Watchlist Alert — ลบข้อความ',
      `**${msg.author?.tag}** (\`${msg.author?.id}\`) ลบข้อความใน <#${msg.channel.id}>\n\`${msg.content?.slice(0, 200)}\``)] });
  }
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
  await redis.set(`editsnipe:${oldMsg.channel.id}`, JSON.stringify({
    before: oldMsg.content, after: newMsg.content,
    author: oldMsg.author?.tag, avatar: oldMsg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL });
  await logAction(oldMsg.author?.id, oldMsg.guild?.id,
    `แก้ข้อความใน #${oldMsg.channel.name}: "${oldMsg.content?.slice(0, 60)}" → "${newMsg.content?.slice(0, 60)}"`);
});

client.on('guildMemberAdd', async (member) => {
  await logAction(member.user.id, member.guild.id,
    `เข้าเซิร์ฟ (บัญชีอายุ ${Math.floor((Date.now() - member.user.createdTimestamp) / 86400000)} วัน)`);

  const key   = `joins:${member.guild.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RAID_WINDOW);
  if (count >= RAID_THRESH) {
    const log = await getLog(member.guild);
    log?.send({ embeds: [embed('#ED4245', '🚨 Raid Detected',
      `มีคนเข้าเซิร์ฟ **${count}** คนใน ${RAID_WINDOW} วิ\nใช้ \`${PREFIX}lockdown\` ถ้าจำเป็น`)] });
  }

  const inWatch = await redis.sismember(`watchlist:${member.guild.id}`, member.user.id);
  if (inWatch) {
    const log = await getLog(member.guild);
    log?.send({ embeds: [embed('#FEE75C', '👁 Watchlist Alert — เข้าเซิร์ฟ',
      `**${member.user.tag}** (\`${member.user.id}\`) ที่อยู่ใน watchlist เพิ่งเข้าเซิร์ฟ!`)] });
  }
});

client.on('channelDelete', async (channel) => {
  const key   = `nukes:${channel.guild?.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 10);
  if (count >= NUKE_THRESH) {
    const log = channel.guild?.channels.cache.get(LOG_CHANNEL);
    log?.send({ embeds: [embed('#ED4245', '💣 Nuke Attempt',
      `ลบห้องไปแล้ว **${count}** ห้องใน 10 วิ — ตรวจสอบ Audit Log ทันที!\nใช้ \`${PREFIX}lockdown\` ฉุกเฉิน`)] });
  }
});

// ── commands ──────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  // anti-spam เฉพาะห้องที่ตั้งค่า หรือทุกห้องถ้าไม่ตั้งค่า
  if (!SPAM_CHANNELS.length || SPAM_CHANNELS.includes(msg.channel.id)) {
    await checkSpam(msg);
  }

  // anti-invite ทุกห้อง
  await checkInvite(msg);

  await logAction(msg.author.id, msg.guild?.id, `ส่งข้อความใน #${msg.channel.name}: "${msg.content.slice(0, 80)}"`);

  if (!msg.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
  const cooldowns = client.cooldowns || (client.cooldowns = new Map());

  const checkCD = () => {
    const last = cooldowns.get(msg.author.id) || 0;
    const diff = Date.now() - last;
    if (diff < SNIPE_CD) { msg.reply(`⏳ cooldown อีก ${Math.ceil((SNIPE_CD - diff) / 1000)} วิ`); return false; }
    cooldowns.set(msg.author.id, Date.now());
    return true;
  };

  // !snipe
  if (cmd === 'snipe') {
    if (!checkCD()) return;
    const raw = await redis.get(`snipe:${msg.channel.id}`);
    if (!raw) return msg.reply('ไม่มีข้อความที่ถูกลบใน 30 วิที่ผ่านมา');
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return msg.channel.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('Delete Snipe')
      .setAuthor({ name: d.author, iconURL: d.avatar }).setDescription(d.content).setTimestamp()] });
  }

  // !editsnipe
  if (cmd === 'editsnipe') {
    if (!checkCD()) return;
    const raw = await redis.get(`editsnipe:${msg.channel.id}`);
    if (!raw) return msg.reply('ไม่มีข้อความที่ถูก edit ใน 30 วิที่ผ่านมา');
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return msg.channel.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('Edit Snipe')
      .setAuthor({ name: d.author, iconURL: d.avatar })
      .addFields({ name: 'ก่อน', value: d.before || '–' }, { name: 'หลัง', value: d.after || '–' })
      .setTimestamp()] });
  }

  // !whois
  if (cmd === 'whois') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    const targetId = args[0]?.replace(/[<@!>]/g, '');
    if (!targetId) return msg.reply('ระบุ user: `!whois @user`');
    let member;
    try { member = await msg.guild.members.fetch(targetId); } catch { return msg.reply('ไม่พบ user นี้'); }
    const logs      = await redis.lrange(`userlog:${msg.guild.id}:${targetId}`, 0, 9) || [];
    const spamWarns = await redis.get(`spamwarn:${msg.guild.id}:${targetId}`) || 0;
    const invWarns  = await redis.get(`invwarn:${msg.guild.id}:${targetId}`) || 0;
    return msg.channel.send({ embeds: [
      new EmbedBuilder().setColor('#5865F2')
        .setTitle(`🔍 ข้อมูล: ${member.user.tag}`)
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'User ID',       value: `\`${member.user.id}\``, inline: true },
          { name: 'อายุบัญชี',    value: `${Math.floor((Date.now() - member.user.createdTimestamp) / 86400000)} วัน`, inline: true },
          { name: 'Spam warns',    value: `${spamWarns} ครั้ง`, inline: true },
          { name: 'Invite warns',  value: `${invWarns} ครั้ง`, inline: true },
          { name: 'เข้าเซิร์ฟ',  value: member.joinedAt?.toLocaleString('th-TH') || '?', inline: false },
          { name: 'Roles',         value: member.roles.cache.filter(r => r.id !== msg.guild.id).map(r => r.name).join(', ') || 'ไม่มี' },
          { name: '10 action ล่าสุด', value: logs.length ? logs.map((l, i) => `\`${i+1}.\` ${l}`).join('\n') : 'ไม่มี' },
        )
    ]});
  }

  // !userlog
  if (cmd === 'userlog') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    const uid = args[0]?.replace(/[<@!>]/g, '');
    if (!uid) return msg.reply('ระบุ user: `!userlog @user`');
    const logs = await redis.lrange(`userlog:${msg.guild.id}:${uid}`, 0, 49) || [];
    if (!logs.length) return msg.reply('ไม่พบ log');
    for (let i = 0; i < logs.length; i += 10) {
      await msg.channel.send({ embeds: [embed('#5865F2', `📋 Log: ${uid}`,
        logs.slice(i, i+10).map((l, j) => `\`${i+j+1}.\` ${l}`).join('\n'))] });
    }
    return;
  }

  // !watchlist
  if (cmd === 'watchlist') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    const sub  = args[0];
    const wkey = `watchlist:${msg.guild.id}`;
    if (sub === 'add') {
      const uid = args[1]?.replace(/[<@!>]/g, '');
      await redis.sadd(wkey, uid);
      return msg.reply(`✅ เพิ่ม \`${uid}\` ใน watchlist แล้ว`);
    }
    if (sub === 'remove') {
      const uid = args[1]?.replace(/[<@!>]/g, '');
      await redis.srem(wkey, uid);
      return msg.reply(`✅ ลบ \`${uid}\` ออกจาก watchlist แล้ว`);
    }
    if (sub === 'list') {
      const list = await redis.smembers(wkey) || [];
      if (!list.length) return msg.reply('watchlist ว่างอยู่');
      return msg.channel.send({ embeds: [embed('#FEE75C', '👁 Watchlist',
        list.map(id => `<@${id}> (\`${id}\`)`).join('\n'))] });
    }
    return msg.reply('ใช้: `!watchlist add/remove/list`');
  }

  // !clearwarns
  if (cmd === 'clearwarns') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    const uid = args[0]?.replace(/[<@!>]/g, '');
    if (!uid) return msg.reply('ระบุ user: `!clearwarns @user`');
    await redis.del(`spamwarn:${msg.guild.id}:${uid}`);
    await redis.del(`invwarn:${msg.guild.id}:${uid}`);
    return msg.reply(`✅ ล้าง warns ทั้งหมดของ \`${uid}\` แล้ว (spam + invite)`);
  }

  // !allowedinvites — ดู invite ที่อนุญาต
  if (cmd === 'allowedinvites') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    if (!ALLOWED_INVITES.length) return msg.reply('ไม่มี invite ที่อนุญาตในขณะนี้ (ตั้งค่าใน .env → ALLOWED_INVITES)');
    return msg.channel.send({ embeds: [embed('#57F287', '✅ Allowed Invites',
      ALLOWED_INVITES.map(c => `discord.gg/${c}`).join('\n'))] });
  }

  // !lockdown / !unlock
  if (cmd === 'lockdown') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: false });
    return msg.reply('🔒 ล็อคห้องนี้แล้ว ใช้ `!unlock` เพื่อเปิด');
  }
  if (cmd === 'unlock') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: null });
    return msg.reply('🔓 เปิดห้องแล้ว');
  }

  // !help
  if (cmd === 'help') {
    return msg.channel.send({ embeds: [
      new EmbedBuilder().setColor('#5865F2').setTitle('Security Bot — คำสั่ง')
        .addFields(
          { name: `\`${PREFIX}snipe\``,                value: 'ดูข้อความที่ถูกลบล่าสุด' },
          { name: `\`${PREFIX}editsnipe\``,             value: 'ดูข้อความก่อน/หลัง edit' },
          { name: `\`${PREFIX}whois @user\``,           value: 'ดู User ID, log, warns (mod)' },
          { name: `\`${PREFIX}userlog @user\``,         value: 'ดู action log เต็ม 50 รายการ (mod)' },
          { name: `\`${PREFIX}clearwarns @user\``,      value: 'ล้าง spam+invite warns (mod)' },
          { name: `\`${PREFIX}allowedinvites\``,        value: 'ดู invite ที่อนุญาต (mod)' },
          { name: `\`${PREFIX}watchlist add @user\``,   value: 'เพิ่มคนใน watchlist (mod)' },
          { name: `\`${PREFIX}watchlist list\``,        value: 'ดู watchlist (mod)' },
          { name: `\`${PREFIX}lockdown\``,              value: 'ล็อคห้อง (mod)' },
          { name: `\`${PREFIX}unlock\``,                value: 'เปิดห้อง (mod)' },
        )
        .setFooter({ text: `Spam: ${SPAM_MSG_LIMIT} ข้อความ/${SPAM_WINDOW_SEC}วิ → warn×${WARN_BEFORE_BAN} → ban | Invite: warn×${WARN_BEFORE_BAN} → ban` })
    ]});
  }
});

// ── keep-alive (สำหรับ Render Web Service) ───────────────
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

// เปิด port ก่อน แล้วค่อย login บอท
// เพื่อให้ Render ตรวจเจอ port ก่อน timeout
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 HTTP server listening on port ${process.env.PORT || 3000}`);
  client.login(process.env.DISCORD_TOKEN);
});

client.once('ready', () => console.log(`✅ ${client.user.tag} online`));
