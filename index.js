require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, AuditLogEvent } = require('discord.js');
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

const PREFIX       = process.env.PREFIX || '!';
const LOG_CHANNEL  = process.env.LOG_CHANNEL_ID;
const CACHE_TTL    = 30;   // seconds (Redis TTL)
const SNIPE_CD     = 5000; // ms
const RAID_WINDOW  = 10;   // seconds
const RAID_THRESH  = 5;    // members joining within window = raid
const NUKE_THRESH  = 3;    // channel deletes within 10s = nuke attempt

// ── helpers ──────────────────────────────────────────────
async function getLog(guild) {
  const ch = guild.channels.cache.get(LOG_CHANNEL);
  return ch;
}

function embed(color, title, desc) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc)
    .setTimestamp();
}

// ── snipe: cache deleted messages ────────────────────────
client.on('messageDelete', async (msg) => {
  if (msg.author?.bot) return;
  const key = `snipe:${msg.channel.id}`;
  await redis.set(key, JSON.stringify({
    content: msg.content || '[embed/attachment]',
    author:  msg.author?.tag,
    avatar:  msg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL });

  // ghost ping detection
  if (msg.mentions.users.size > 0 || msg.mentions.roles.size > 0) {
    const log = await getLog(msg.guild);
    log?.send({ embeds: [embed('#ED4245', '👻 Ghost Ping', `**${msg.author?.tag}** ping แล้วลบใน <#${msg.channel.id}>\n\`${msg.content}\``)] });
  }
});

// ── editsnipe: cache edited messages ─────────────────────
client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
  const key = `editsnipe:${oldMsg.channel.id}`;
  await redis.set(key, JSON.stringify({
    before: oldMsg.content,
    after:  newMsg.content,
    author: oldMsg.author?.tag,
    avatar: oldMsg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL });
});

// ── anti-raid: rate limit joins ───────────────────────────
client.on('guildMemberAdd', async (member) => {
  const key   = `joins:${member.guild.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RAID_WINDOW);

  if (count >= RAID_THRESH) {
    const log = await getLog(member.guild);
    log?.send({ embeds: [embed('#ED4245', '🚨 Raid Detected',
      `มีคนเข้าเซิร์ฟ **${count}** คนใน ${RAID_WINDOW} วิ\nพิจารณาเปิด lockdown: \`${PREFIX}lockdown\``)] });
  }
});

// ── anti-nuke: detect mass channel delete ────────────────
client.on('channelDelete', async (channel) => {
  const key   = `nukes:${channel.guild?.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 10);

  if (count >= NUKE_THRESH) {
    const log = channel.guild?.channels.cache.get(LOG_CHANNEL);
    log?.send({ embeds: [embed('#ED4245', '💣 Nuke Attempt',
      `ลบห้องไปแล้ว **${count}** ห้องใน 10 วิ — ตรวจสอบ Audit Log ทันที!`)] });
  }
});

// ── commands ──────────────────────────────────────────────
const cooldowns = new Map();

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = msg.content.slice(1).trim().split(/\s+/);

  const checkCD = () => {
    const last = cooldowns.get(msg.author.id) || 0;
    const diff = Date.now() - last;
    if (diff < SNIPE_CD) {
      msg.reply(`⏳ cooldown อีก ${Math.ceil((SNIPE_CD - diff) / 1000)} วิ`);
      return false;
    }
    cooldowns.set(msg.author.id, Date.now());
    return true;
  };

  // !snipe
  if (cmd === 'snipe') {
    if (!checkCD()) return;
    const raw = await redis.get(`snipe:${msg.channel.id}`);
    if (!raw) return msg.reply('ไม่มีข้อความที่ถูกลบใน 30 วิที่ผ่านมา');
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    msg.channel.send({ embeds: [
      new EmbedBuilder().setColor('#ED4245').setTitle('Delete Snipe')
        .setAuthor({ name: d.author, iconURL: d.avatar })
        .setDescription(d.content).setTimestamp()
    ]});
  }

  // !editsnipe
  if (cmd === 'editsnipe') {
    if (!checkCD()) return;
    const raw = await redis.get(`editsnipe:${msg.channel.id}`);
    if (!raw) return msg.reply('ไม่มีข้อความที่ถูก edit ใน 30 วิที่ผ่านมา');
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    msg.channel.send({ embeds: [
      new EmbedBuilder().setColor('#FEE75C').setTitle('Edit Snipe')
        .setAuthor({ name: d.author, iconURL: d.avatar })
        .addFields({ name: 'ก่อน', value: d.before || '–' }, { name: 'หลัง', value: d.after || '–' })
        .setTimestamp()
    ]});
  }

  // !lockdown  (mod only)
  if (cmd === 'lockdown') {
    if (!msg.member.permissions.has('ManageChannels')) return msg.reply('ไม่มีสิทธิ์');
    const channel = msg.channel;
    await channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: false });
    msg.reply('🔒 ล็อคห้องนี้แล้ว ใช้ `!unlock` เพื่อเปิด');
  }

  // !unlock
  if (cmd === 'unlock') {
    if (!msg.member.permissions.has('ManageChannels')) return msg.reply('ไม่มีสิทธิ์');
    await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: null });
    msg.reply('🔓 เปิดห้องแล้ว');
  }

  // !help
  if (cmd === 'help') {
    msg.channel.send({ embeds: [
      new EmbedBuilder().setColor('#5865F2').setTitle('Security Bot — คำสั่ง')
        .addFields(
          { name: `\`${PREFIX}snipe\``,     value: 'ดูข้อความที่ถูกลบล่าสุด' },
          { name: `\`${PREFIX}editsnipe\``, value: 'ดูข้อความก่อน/หลัง edit' },
          { name: `\`${PREFIX}lockdown\``,  value: 'ล็อคห้อง (mod)' },
          { name: `\`${PREFIX}unlock\``,    value: 'เปิดห้อง (mod)' },
        )
    ]});
  }
});

client.once('ready', () => console.log(`✅ ${client.user.tag} online`));
client.login(process.env.DISCORD_TOKEN);
