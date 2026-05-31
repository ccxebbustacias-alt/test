require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, AuditLogEvent, PermissionsBitField } = require('discord.js');
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

const PREFIX      = process.env.PREFIX || '!';
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID;
const CACHE_TTL   = 30;
const SNIPE_CD    = 5000;
const RAID_WINDOW = 10;
const RAID_THRESH = 5;
const NUKE_THRESH = 3;

// ── helpers ───────────────────────────────────────────────
async function getLog(guild) {
  return guild?.channels.cache.get(LOG_CHANNEL);
}

function embed(color, title, desc) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();
}

function isMod(member) {
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

// ── log every action to Redis (per user) ─────────────────
async function logAction(userId, guildId, action) {
  const key = `userlog:${guildId}:${userId}`;
  const entry = `[${new Date().toISOString()}] ${action}`;
  await redis.lpush(key, entry);
  await redis.ltrim(key, 0, 49);   // keep last 50 actions
  await redis.expire(key, 60 * 60 * 24 * 7); // 7 days
}

// ── track every message (user activity log) ──────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
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

  // !whois <@user or ID>  — ดู profile + action log
  if (cmd === 'whois') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์ (ต้องการ Manage Server)');
    const targetId = args[0]?.replace(/[<@!>]/g, '');
    if (!targetId) return msg.reply('ระบุ user: `!whois @user` หรือ `!whois USER_ID`');

    let member;
    try { member = await msg.guild.members.fetch(targetId); } catch { return msg.reply('ไม่พบ user นี้ในเซิร์ฟ'); }

    const logs = await redis.lrange(`userlog:${msg.guild.id}:${targetId}`, 0, 9) || [];
    const joinedAt = member.joinedAt?.toLocaleString('th-TH') || 'ไม่ทราบ';
    const createdAt = member.user.createdAt?.toLocaleString('th-TH') || 'ไม่ทราบ';
    const roles = member.roles.cache.filter(r => r.id !== msg.guild.id).map(r => r.name).join(', ') || 'ไม่มี';
    const accountAge = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);

    const logText = logs.length ? logs.map((l, i) => `\`${i + 1}.\` ${l}`).join('\n') : 'ไม่มีประวัติ';

    return msg.channel.send({ embeds: [
      new EmbedBuilder().setColor('#5865F2')
        .setTitle(`🔍 ข้อมูล: ${member.user.tag}`)
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'User ID', value: `\`${member.user.id}\``, inline: true },
          { name: 'อายุบัญชี', value: `${accountAge} วัน`, inline: true },
          { name: 'เข้าเซิร์ฟ', value: joinedAt, inline: false },
          { name: 'สร้างบัญชี', value: createdAt, inline: true },
          { name: 'Roles', value: roles, inline: false },
          { name: '10 action ล่าสุด', value: logText },
        )
        .setFooter({ text: 'ข้อมูลจาก Redis log (7 วัน)' })
    ]});
  }

  // !watchlist add/remove/list  — จับตาดู user ที่น่าสงสัย
  if (cmd === 'watchlist') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    const sub = args[0];
    const wkey = `watchlist:${msg.guild.id}`;

    if (sub === 'add') {
      const uid = args[1]?.replace(/[<@!>]/g, '');
      if (!uid) return msg.reply('ระบุ user: `!watchlist add @user`');
      await redis.sadd(wkey, uid);
      return msg.reply(`✅ เพิ่ม \`${uid}\` ใน watchlist แล้ว`);
    }
    if (sub === 'remove') {
      const uid = args[1]?.replace(/[<@!>]/g, '');
      if (!uid) return msg.reply('ระบุ user: `!watchlist remove @user`');
      await redis.srem(wkey, uid);
      return msg.reply(`✅ ลบ \`${uid}\` ออกจาก watchlist แล้ว`);
    }
    if (sub === 'list') {
      const list = await redis.smembers(wkey) || [];
      if (!list.length) return msg.reply('watchlist ว่างอยู่');
      const lines = list.map(id => `<@${id}> (\`${id}\`)`).join('\n');
      return msg.channel.send({ embeds: [embed('#FEE75C', '👁 Watchlist', lines)] });
    }
    return msg.reply('ใช้: `!watchlist add/remove/list`');
  }

  // !userlog <@user or ID>  — ดู action log เต็ม 50 รายการ
  if (cmd === 'userlog') {
    if (!isMod(msg.member)) return msg.reply('ไม่มีสิทธิ์');
    const uid = args[0]?.replace(/[<@!>]/g, '');
    if (!uid) return msg.reply('ระบุ user: `!userlog @user`');
    const logs = await redis.lrange(`userlog:${msg.guild.id}:${uid}`, 0, 49) || [];
    if (!logs.length) return msg.reply('ไม่พบ log ของ user นี้');
    const chunks = [];
    for (let i = 0; i < logs.length; i += 10) {
      chunks.push(logs.slice(i, i + 10).map((l, j) => `\`${i + j + 1}.\` ${l}`).join('\n'));
    }
    for (const chunk of chunks) {
      await msg.channel.send({ embeds: [embed('#5865F2', `📋 Log: ${uid}`, chunk)] });
    }
    return;
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
          { name: `\`${PREFIX}snipe\``,              value: 'ดูข้อความที่ถูกลบล่าสุด' },
          { name: `\`${PREFIX}editsnipe\``,           value: 'ดูข้อความก่อน/หลัง edit' },
          { name: `\`${PREFIX}whois @user\``,         value: 'ดู User ID, join date, roles, action log (mod)' },
          { name: `\`${PREFIX}userlog @user\``,       value: 'ดู action log เต็ม 50 รายการ (mod)' },
          { name: `\`${PREFIX}watchlist add @user\``, value: 'เพิ่มคนที่น่าสงสัยใน watchlist (mod)' },
          { name: `\`${PREFIX}watchlist list\``,      value: 'ดู watchlist ทั้งหมด (mod)' },
          { name: `\`${PREFIX}lockdown\``,            value: 'ล็อคห้อง (mod)' },
          { name: `\`${PREFIX}unlock\``,              value: 'เปิดห้อง (mod)' },
        )
    ]});
  }
});

// ── track deleted messages ────────────────────────────────
client.on('messageDelete', async (msg) => {
  if (msg.author?.bot) return;
  await redis.set(`snipe:${msg.channel.id}`, JSON.stringify({
    content: msg.content || '[embed/attachment]',
    author: msg.author?.tag,
    avatar: msg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL });
  await logAction(msg.author?.id, msg.guild?.id, `ลบข้อความใน #${msg.channel.name}: "${msg.content?.slice(0, 80)}"`);

  // ghost ping
  if (msg.mentions.users.size > 0 || msg.mentions.roles.size > 0) {
    await logAction(msg.author?.id, msg.guild?.id, `GHOST PING ใน #${msg.channel.name}`);
    const log = await getLog(msg.guild);
    log?.send({ embeds: [embed('#ED4245', '👻 Ghost Ping',
      `**${msg.author?.tag}** (\`${msg.author?.id}\`) ping แล้วลบใน <#${msg.channel.id}>\n\`${msg.content}\``)] });
  }

  // แจ้งถ้าคนนี้อยู่ใน watchlist
  const inWatch = await redis.sismember(`watchlist:${msg.guild?.id}`, msg.author?.id);
  if (inWatch) {
    const log = await getLog(msg.guild);
    log?.send({ embeds: [embed('#FEE75C', '👁 Watchlist Alert — ลบข้อความ',
      `**${msg.author?.tag}** (\`${msg.author?.id}\`) ลบข้อความใน <#${msg.channel.id}>\n\`${msg.content?.slice(0, 200)}\``)] });
  }
});

// ── track edited messages ────────────────────────────────
client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
  await redis.set(`editsnipe:${oldMsg.channel.id}`, JSON.stringify({
    before: oldMsg.content, after: newMsg.content,
    author: oldMsg.author?.tag, avatar: oldMsg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL });
  await logAction(oldMsg.author?.id, oldMsg.guild?.id,
    `แก้ข้อความใน #${oldMsg.channel.name}: "${oldMsg.content?.slice(0, 60)}" → "${newMsg.content?.slice(0, 60)}"`);
});

// ── track joins ──────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  await logAction(member.user.id, member.guild.id,
    `เข้าเซิร์ฟ (บัญชีอายุ ${Math.floor((Date.now() - member.user.createdTimestamp) / 86400000)} วัน)`);

  const key = `joins:${member.guild.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RAID_WINDOW);
  if (count >= RAID_THRESH) {
    const log = await getLog(member.guild);
    log?.send({ embeds: [embed('#ED4245', '🚨 Raid Detected',
      `มีคนเข้าเซิร์ฟ **${count}** คนใน ${RAID_WINDOW} วิ\nใช้ \`${PREFIX}lockdown\` ถ้าจำเป็น`)] });
  }

  // แจ้งถ้าคนนี้อยู่ใน watchlist
  const inWatch = await redis.sismember(`watchlist:${member.guild.id}`, member.user.id);
  if (inWatch) {
    const log = await getLog(member.guild);
    log?.send({ embeds: [embed('#FEE75C', '👁 Watchlist Alert — เข้าเซิร์ฟ',
      `**${member.user.tag}** (\`${member.user.id}\`) ที่อยู่ใน watchlist เพิ่งเข้าเซิร์ฟ!`)] });
  }
});

// ── anti-nuke ────────────────────────────────────────────
client.on('channelDelete', async (channel) => {
  const key = `nukes:${channel.guild?.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 10);
  if (count >= NUKE_THRESH) {
    const log = channel.guild?.channels.cache.get(LOG_CHANNEL);
    log?.send({ embeds: [embed('#ED4245', '💣 Nuke Attempt',
      `ลบห้องไปแล้ว **${count}** ห้องใน 10 วิ — ตรวจสอบ Audit Log ทันที!\nใช้ \`${PREFIX}lockdown\` ฉุกเฉิน`)] });
  }
});

client.once('ready', () => console.log(`✅ ${client.user.tag} online`));
client.login(process.env.DISCORD_TOKEN);
