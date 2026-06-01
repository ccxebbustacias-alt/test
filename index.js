require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { Redis } = require('@upstash/redis');
const http = require('http');

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
const PREFIX        = process.env.PREFIX || '!';
const LOG_CHANNEL   = process.env.LOG_CHANNEL_ID;
const SPAM_CHANNELS = (process.env.SPAM_CHANNEL_ID || '')
  .split(',').map(id => id.trim()).filter(Boolean);
const CACHE_TTL     = 30;
const SNIPE_CD      = 5000;
const RAID_WINDOW   = 10;
const RAID_THRESH   = 5;
const NUKE_THRESH   = 3;

const SPAM_MSG_LIMIT  = 1;
const SPAM_WINDOW_SEC = 5;
const WARN_BEFORE_BAN = 0;

const NEW_ACC_DAYS = 30; // บัญชีอายุน้อยกว่านี้ → แจ้งเตือน + จับตาดู

const INVITE_REGEX    = /discord(?:\.gg|(?:app)?\.com\/invite)\/([a-zA-Z0-9\-]+)/gi;
const ALLOWED_INVITES = (process.env.ALLOWED_INVITES || '')
  .split(',').map(c => c.trim().toLowerCase()).filter(Boolean);

// ── anti-token grabber config ──────────────────────────────
// โทเคน Discord จริงมี 3 ส่วนคั่นด้วย . (base64.base64.base64)
const TOKEN_REGEX = /[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}/g;

// domains ที่รู้จักว่าเป็น token grabber / IP logger / phishing
const GRABBER_DOMAINS = [
  // token grabbers / stealers ที่พบบ่อย
  'grabify.link','iplogger.org','iplogger.com','2no.co','yip.su',
  'ps3cfw.com','loveget.ga','blasze.com','leakinfo.net',
  'discord-nitro.gift','discordnitro.gift','dlscord.com','dicsord.com',
  'steamcommunity.ru','steamcornmunity.com','freestuff.gg',
  'discord-app.com','discord-gifts.com','disccord.com',
  'luna.fyi','ngrok.io','ngrok.app',            // tunnel ที่ใช้ host grabber
  'webhook.site','pipedream.net',               // webhook collectors
  // URL shortener ที่ใช้ซ่อนลิงก์อันตราย
  'bit.ly','tinyurl.com','rebrand.ly','cutt.ly',
  't.co','rb.gy','is.gd','v.gd','gg.gg',
];

// คำที่มักอยู่ใน path ของ grabber script
const GRABBER_PATH_PATTERNS = [
  /\/token/i, /\/grab/i, /\/steal/i, /\/webhook/i,
  /\/nitro/i, /\/gift/i, /\/free/i, /\/giveaway/i,
  /login\.php/i, /auth\.php/i,
];

// ── in-memory cache สำหรับ log channel (ไม่ต้อง fetch ทุกครั้ง) ──
const logChannelCache = new Map(); // guildId → channel | null

// ── helpers ───────────────────────────────────────────────
function getLog(guild) {
  if (!guild) return null;
  if (logChannelCache.has(guild.id)) return logChannelCache.get(guild.id);
  const ch = guild.channels.cache.get(LOG_CHANNEL) ?? null;
  logChannelCache.set(guild.id, ch);
  return ch;
}

function embed(color, title, desc) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();
}

function isMod(member) {
  if (!member) return false;
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

// ── logAction แบบ fire-and-forget (ไม่ await ในสายหลัก) ──
function logAction(userId, guildId, action) {
  if (!userId || !guildId) return;
  const key  = `userlog:${guildId}:${userId}`;
  const line = `[${new Date().toISOString()}] ${action}`;
  // pipeline 3 คำสั่งรวมกันในครั้งเดียว
  redis.pipeline()
    .lpush(key, line)
    .ltrim(key, 0, 49)
    .expire(key, 60 * 60 * 24 * 7)
    .exec()
    .catch(() => {});
}

// ── anti-spam ──────────────────────────────────────────────
async function checkSpam(msg) {
  const key   = `spam:${msg.guild.id}:${msg.author.id}`;
  const count = await redis.incr(key);
  if (count === 1) redis.expire(key, SPAM_WINDOW_SEC).catch(() => {});
  if (count < SPAM_MSG_LIMIT) return;

  logAction(msg.author.id, msg.guild.id, `SPAM detected (${count} ข้อความใน ${SPAM_WINDOW_SEC} วิ)`);
  console.log(`[Anti-Spam] ${msg.author.tag} spam ×${count} in ${msg.guild.name}`);

  const warnKey = `spamwarn:${msg.guild.id}:${msg.author.id}`;
  const warns   = await redis.incr(warnKey);
  redis.expire(warnKey, 60 * 60 * 24).catch(() => {});

  const log = getLog(msg.guild);

  if (warns <= WARN_BEFORE_BAN) {
    // ลบข้อความ + warn พร้อมกัน
    const [msgs] = await Promise.allSettled([
      msg.channel.messages.fetch({ limit: 20 }),
    ]);
    if (msgs.status === 'fulfilled') {
      const toDelete = msgs.value.filter(m => m.author.id === msg.author.id && Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
      (toDelete.size > 1 ? msg.channel.bulkDelete(toDelete) : msg.delete()).catch(() => {});
    }
    const warnMsg = await msg.channel.send({ embeds: [
      embed('#FEE75C', '⚠️ คำเตือน',
        `<@${msg.author.id}> หยุดส่งสแปม! (เตือนครั้งที่ ${warns}/${WARN_BEFORE_BAN})\nอีก ${WARN_BEFORE_BAN - warns + 1} ครั้งจะถูกแบนอัตโนมัติ`)
    ]});
    setTimeout(() => warnMsg.delete().catch(() => {}), 8000);
    log?.send({ embeds: [embed('#FEE75C', '⚠️ Spam Warn',
      `**${msg.author.tag}** (\`${msg.author.id}\`) ถูกเตือนสแปมใน <#${msg.channel.id}> (ครั้งที่ ${warns})`)] });
  } else {
    try {
      // ban + ลบข้อความ + log พร้อมกัน
      await msg.member.ban({ deleteMessageSeconds: 3600, reason: `Auto-ban: spam (${warns} ครั้ง)` });
      const banEmbed = embed('#ED4245', '🔨 Auto Ban — Spam',
        `**${msg.author.tag}** (\`${msg.author.id}\`) ถูก ban เนื่องจากสแปมซ้ำ ${warns} ครั้ง ในห้อง <#${msg.channel.id}>`);
      // ทำทั้งสองอย่างพร้อมกัน
      await Promise.allSettled([
        log ? log.send({ embeds: [banEmbed] }) : msg.channel.send({ embeds: [banEmbed] }).catch(() => {}),
        redis.del(warnKey),
        msg.channel.messages.fetch({ limit: 20 }).then(msgs => {
          const toDelete = msgs.filter(m => m.author.id === msg.author.id && Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
          return toDelete.size > 1 ? msg.channel.bulkDelete(toDelete) : msg.delete().catch(() => {});
        }).catch(() => {}),
      ]);
    } catch (err) {
      console.error(`[Anti-Spam] Ban failed for ${msg.author.tag}:`, err.message);
      const failEmbed = embed('#ED4245', '❌ Ban Failed',
        `ไม่สามารถ ban **${msg.author.tag}** (\`${msg.author.id}\`) ได้\nสาเหตุ: \`${err.message}\`\n\nตรวจสอบ: role บอทต้องอยู่เหนือ role ของ user + มีสิทธิ์ Ban Members`);
      (log ? log.send({ embeds: [failEmbed] }) : msg.channel.send({ embeds: [failEmbed] })).catch(() => {});
    }
  }
}

// ── anti-invite link ───────────────────────────────────────
async function checkInvite(msg) {
  const matches = [...msg.content.matchAll(INVITE_REGEX)];
  if (!matches.length) return;

  const blocked = matches.filter(m => !ALLOWED_INVITES.includes(m[1].toLowerCase()));
  if (!blocked.length) return;

  // ลบข้อความทันที (fire-and-forget)
  msg.delete().catch(() => {});
  logAction(msg.author.id, msg.guild.id,
    `ส่ง invite link ที่ไม่ได้รับอนุญาต: ${blocked.map(m => m[0]).join(', ')}`);

  const warnKey = `invwarn:${msg.guild.id}:${msg.author.id}`;
  const warns   = await redis.incr(warnKey);
  redis.expire(warnKey, 60 * 60 * 24).catch(() => {});

  const log = getLog(msg.guild);

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
      const banEmbed = embed('#ED4245', '🔨 Auto Ban — Invite Link',
        `**${msg.author.tag}** (\`${msg.author.id}\`) ถูก ban เนื่องจากส่ง invite link ซ้ำ ${warns} ครั้ง`);
      await Promise.allSettled([
        (log ? log.send({ embeds: [banEmbed] }) : msg.channel.send({ embeds: [banEmbed] })).catch(() => {}),
        redis.del(warnKey),
      ]);
    } catch (err) {
      console.error(`[Anti-Invite] Ban failed for ${msg.author.tag}:`, err.message);
      const failEmbed = embed('#ED4245', '❌ Ban Failed',
        `ไม่สามารถ ban **${msg.author.tag}** (\`${msg.author.id}\`) ได้\nสาเหตุ: \`${err.message}\`\n\nตรวจสอบ: role บอทต้องอยู่เหนือ role ของ user + มีสิทธิ์ Ban Members`);
      (log ? log.send({ embeds: [failEmbed] }) : msg.channel.send({ embeds: [failEmbed] })).catch(() => {});
    }
  }
}

// ── anti-token grabber ─────────────────────────────────────
async function checkTokenGrabber(msg) {
  const content = msg.content;
  const reasons = [];

  // 1) ตรวจ Discord token จริงหลุดในข้อความ
  const tokenMatches = content.match(TOKEN_REGEX);
  if (tokenMatches) {
    reasons.push(`พบ Discord Token ในข้อความ (${tokenMatches.length} รายการ)`);
  }

  // 2) ตรวจ URL ในข้อความ
  const urlMatches = [...content.matchAll(/https?:\/\/([^\s/]+)(\/[^\s]*)?/gi)];
  for (const match of urlMatches) {
    const domain = match[1].toLowerCase().replace(/^www\./, '');
    const path   = match[2] || '';

    // ตรวจ domain blacklist
    if (GRABBER_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) {
      reasons.push(`พบ domain อันตราย: \`${domain}\``);
    }

    // ตรวจ path pattern ที่น่าสงสัย
    for (const pattern of GRABBER_PATH_PATTERNS) {
      if (pattern.test(path)) {
        reasons.push(`พบ URL pattern อันตราย: \`${match[0].slice(0, 60)}\``);
        break;
      }
    }

    // ตรวจ Discord webhook URL (ไม่ควรส่งใน chat)
    if (/discord(?:app)?\.com\/api\/webhooks\//i.test(match[0])) {
      reasons.push(`พบ Discord Webhook URL (อาจใช้ดึงข้อมูล)`);
    }
  }

  if (!reasons.length) return;

  // ลบข้อความทันที (fire-and-forget)
  msg.delete().catch(() => {});
  logAction(msg.author.id, msg.guild.id,
    `TOKEN GRABBER DETECTED: ${reasons.join(' | ')}`);
  console.log(`[Anti-Token] ${msg.author.tag} — ${reasons.join(', ')}`);

  const log = getLog(msg.guild);

  // เตือนใน log channel
  const alertEmbed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('🚨 Token Grabber Detected')
    .setDescription([
      `**ผู้ส่ง:** ${msg.author.tag} (\`${msg.author.id}\`) → <@${msg.author.id}>`,
      `**ห้อง:** <#${msg.channel.id}>`,
      `**เหตุผล:**\n${reasons.map(r => `> • ${r}`).join('\n')}`,
      '',
      `**ข้อความ (ถูกลบแล้ว):**\n\`\`\`${content.slice(0, 300).replace(/`/g, '\'')}\`\`\``,
    ].join('\n'))
    .setTimestamp();

  // แบนทันทีเลย เพราะ token grabber = เจตนาร้ายชัดเจน
  try {
    await msg.member.ban({
      deleteMessageSeconds: 3600,
      reason: `Auto-ban: Token Grabber — ${reasons[0]}`,
    });
    alertEmbed.addFields({ name: '🔨 ดำเนินการ', value: '**Ban ถาวรอัตโนมัติแล้ว**' });
  } catch (err) {
    alertEmbed.addFields({
      name: '❌ Ban ไม่สำเร็จ',
      value: `\`${err.message}\`\nตรวจสอบ role บอทและสิทธิ์ Ban Members`,
    });
  }

  (log
    ? log.send({ embeds: [alertEmbed] })
    : msg.channel.send({ embeds: [alertEmbed] })
  ).catch(() => {});
}

// ── events ────────────────────────────────────────────────
client.on('messageDelete', async (msg) => {
  if (msg.author?.bot) return;
  // snipe + log พร้อมกัน
  await Promise.allSettled([
    redis.set(`snipe:${msg.channel.id}`, JSON.stringify({
      content: msg.content || '[embed/attachment]',
      author: msg.author?.tag,
      avatar: msg.author?.displayAvatarURL(),
    }), { ex: CACHE_TTL }),
    (async () => {
      logAction(msg.author?.id, msg.guild?.id, `ลบข้อความใน #${msg.channel.name}: "${msg.content?.slice(0, 80)}"`);
      if (msg.mentions.users.size > 0 || msg.mentions.roles.size > 0) {
        logAction(msg.author?.id, msg.guild?.id, `GHOST PING ใน #${msg.channel.name}`);
        getLog(msg.guild)?.send({ embeds: [embed('#ED4245', '👻 Ghost Ping',
          `**${msg.author?.tag}** (\`${msg.author?.id}\`) ping แล้วลบใน <#${msg.channel.id}>\n\`${msg.content}\``)] });
      }
    })(),
    redis.sismember(`watchlist:${msg.guild?.id}`, msg.author?.id).then(inWatch => {
      if (inWatch) {
        getLog(msg.guild)?.send({ embeds: [embed('#FEE75C', '👁 Watchlist Alert — ลบข้อความ',
          `**${msg.author?.tag}** (\`${msg.author?.id}\`) ลบข้อความใน <#${msg.channel.id}>\n\`${msg.content?.slice(0, 200)}\``)] });
      }
    }),
  ]);
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
  redis.set(`editsnipe:${oldMsg.channel.id}`, JSON.stringify({
    before: oldMsg.content, after: newMsg.content,
    author: oldMsg.author?.tag, avatar: oldMsg.author?.displayAvatarURL(),
  }), { ex: CACHE_TTL }).catch(() => {});
  logAction(oldMsg.author?.id, oldMsg.guild?.id,
    `แก้ข้อความใน #${oldMsg.channel.name}: "${oldMsg.content?.slice(0, 60)}" → "${newMsg.content?.slice(0, 60)}"`);
});

client.on('guildMemberAdd', async (member) => {
  const accAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
  logAction(member.user.id, member.guild.id,
    `เข้าเซิร์ฟ (บัญชีอายุ ${accAgeDays} วัน)`);

  const key   = `joins:${member.guild.id}`;
  const count = await redis.incr(key);
  if (count === 1) redis.expire(key, RAID_WINDOW).catch(() => {});

  // ตรวจ raid + watchlist + new account พร้อมกัน
  const [, watchResult] = await Promise.allSettled([
    count >= RAID_THRESH
      ? getLog(member.guild)?.send({ embeds: [embed('#ED4245', '🚨 Raid Detected',
          `มีคนเข้าเซิร์ฟ **${count}** คนใน ${RAID_WINDOW} วิ\nใช้ \`${PREFIX}lockdown\` ถ้าจำเป็น`)] })
      : Promise.resolve(),
    redis.sismember(`watchlist:${member.guild.id}`, member.user.id),
  ]);

  if (watchResult.status === 'fulfilled' && watchResult.value) {
    getLog(member.guild)?.send({ embeds: [embed('#FEE75C', '👁 Watchlist Alert — เข้าเซิร์ฟ',
      `**${member.user.tag}** (\`${member.user.id}\`) ที่อยู่ใน watchlist เพิ่งเข้าเซิร์ฟ!`)] });
  }

  // ── ตรวจบัญชีใหม่ ──────────────────────────────────────
  if (accAgeDays < NEW_ACC_DAYS) {
    // บันทึกลง Redis key: newaccs:guildId → set ของ userId
    redis.sadd(`newaccs:${member.guild.id}`, member.user.id).catch(() => {});
    // เก็บข้อมูลรายละเอียดไว้ด้วย
    redis.set(
      `newaccinfo:${member.guild.id}:${member.user.id}`,
      JSON.stringify({
        id:       member.user.id,
        tag:      member.user.tag,
        avatar:   member.user.displayAvatarURL({ size: 64 }),
        ageDays:  accAgeDays,
        joinedAt: Date.now(),
      }),
      { ex: 60 * 60 * 24 * 30 } // เก็บ 30 วัน
    ).catch(() => {});

    logAction(member.user.id, member.guild.id,
      `⚠️ NEW ACCOUNT: บัญชีอายุเพียง ${accAgeDays} วัน — จับตาดู`);

    getLog(member.guild)?.send({ embeds: [
      new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('🆕 บัญชีใหม่เข้าเซิร์ฟ')
        .setThumbnail(member.user.displayAvatarURL({ size: 64 }))
        .setDescription([
          `**User:** ${member.user.tag} → <@${member.user.id}>`,
          `**ID:** \`${member.user.id}\``,
          `**อายุบัญชี:** ${accAgeDays} วัน (น้อยกว่า ${NEW_ACC_DAYS} วัน)`,
          `**สมัครเมื่อ:** ${new Date(member.user.createdTimestamp).toLocaleString('th-TH')}`,
          '',
          '⚠️ กำลังจับตาดู — ดูได้ที่หน้า **"บัญชีน่าสงสัย"** ใน Panel',
        ].join('\n'))
        .setTimestamp()
    ]});
  }
});

client.on('channelDelete', async (channel) => {
  const key   = `nukes:${channel.guild?.id}`;
  const count = await redis.incr(key);
  if (count === 1) redis.expire(key, 10).catch(() => {});
  if (count >= NUKE_THRESH) {
    const log = channel.guild?.channels.cache.get(LOG_CHANNEL);
    log?.send({ embeds: [embed('#ED4245', '💣 Nuke Attempt',
      `ลบห้องไปแล้ว **${count}** ห้องใน 10 วิ — ตรวจสอบ Audit Log ทันที!\nใช้ \`${PREFIX}lockdown\` ฉุกเฉิน`)] });
  }
});

// ── commands ──────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  // guard ก่อน: ถ้าเป็น mod ข้ามการตรวจทั้งหมด
  const isModUser = isMod(msg.member);

  if (!isModUser) {
    // ตรวจ token grabber ก่อนเลย (อันตรายที่สุด → ban ทันที)
    await checkTokenGrabber(msg);

    // ตรวจ spam + invite พร้อมกัน (parallel) ไม่รอสายใดสายนึงก่อน
    const inSpamChannel = !SPAM_CHANNELS.length || SPAM_CHANNELS.includes(msg.channel.id);
    const checks = [];
    if (inSpamChannel) checks.push(checkSpam(msg));
    checks.push(checkInvite(msg));
    await Promise.allSettled(checks);
  }

  // logAction fire-and-forget (ไม่ต้อง await)
  logAction(msg.author.id, msg.guild?.id, `ส่งข้อความใน #${msg.channel.name}: "${msg.content.slice(0, 80)}"`);

  // ── ตรวจ watchlist — ถ้า user อยู่ใน watchlist แจ้ง log ทันที ──
  if (msg.guild) {
    redis.sismember(`watchlist:${msg.guild.id}`, msg.author.id).then(inWatch => {
      if (!inWatch) return;
      const log = getLog(msg.guild);
      if (!log) return;
      log.send({ embeds: [
        new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('👁 Watchlist — ส่งข้อความ')
          .setThumbnail(msg.author.displayAvatarURL({ size: 64 }))
          .setDescription([
            `**User:** ${msg.author.tag} → <@${msg.author.id}>`,
            `**ID:** \`${msg.author.id}\``,
            `**ห้อง:** <#${msg.channel.id}>`,
            `**ข้อความ:** ${msg.content.slice(0, 200) || '*(ไม่มีข้อความ)*'}`,
            '',
            `🔇 Mute ได้ที่หน้า **Watchlist** ใน Panel`,
          ].join('\n'))
          .setTimestamp()
      ]});
    }).catch(() => {});
  }

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
    // ดึง Redis หลายค่าพร้อมกัน
    const [logsResult, spamWarnsResult, invWarnsResult] = await Promise.allSettled([
      redis.lrange(`userlog:${msg.guild.id}:${targetId}`, 0, 9),
      redis.get(`spamwarn:${msg.guild.id}:${targetId}`),
      redis.get(`invwarn:${msg.guild.id}:${targetId}`),
    ]);
    const logs      = logsResult.status === 'fulfilled' ? (logsResult.value || []) : [];
    const spamWarns = spamWarnsResult.status === 'fulfilled' ? (spamWarnsResult.value || 0) : 0;
    const invWarns  = invWarnsResult.status === 'fulfilled' ? (invWarnsResult.value || 0) : 0;
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
    await Promise.allSettled([
      redis.del(`spamwarn:${msg.guild.id}:${uid}`),
      redis.del(`invwarn:${msg.guild.id}:${uid}`),
    ]);
    return msg.reply(`✅ ล้าง warns ทั้งหมดของ \`${uid}\` แล้ว (spam + invite)`);
  }

  // !allowedinvites
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
        .addFields({ name: '🛡️ Auto-Protection', value: '`Anti-Spam` `Anti-Invite` `Anti-TokenGrabber` `Ghost-Ping` `Raid-Detect` `Nuke-Detect`' })
        .setFooter({ text: `Spam: ${SPAM_MSG_LIMIT} ข้อความ/${SPAM_WINDOW_SEC}วิ → warn×${WARN_BEFORE_BAN} → ban | Invite: warn×${WARN_BEFORE_BAN} → ban | Token Grabber → ban ทันที` })
    ]});
  }
});

// ── Panel API Server ───────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const PANEL_TOKEN = process.env.PANEL_TOKEN || 'changeme'; // ตั้งใน .env

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function authFail(res) { json(res, 401, { error: 'Unauthorized' }); }
function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${PANEL_TOKEN}`;
}
function body(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

const PANEL_HTML = path.join(__dirname, 'panel.html');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost`);

  // OPTIONS preflight
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── serve panel.html ──────────────────────────────────────
  if (u.pathname === '/' || u.pathname === '/panel') {
    if (fs.existsSync(PANEL_HTML)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(PANEL_HTML));
    } else {
      res.writeHead(404); res.end('panel.html not found');
    }
    return;
  }

  // ── health check ─────────────────────────────────────────
  if (u.pathname === '/health') { json(res, 200, { ok: true }); return; }

  // ── API routes (ต้อง auth ทุกอัน) ───────────────────────
  if (!u.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
  if (!checkAuth(req)) { authFail(res); return; }

  // GET /api/guilds — รายชื่อเซิร์ฟที่บอทอยู่
  if (u.pathname === '/api/guilds' && req.method === 'GET') {
    const guilds = client.guilds.cache.map(g => ({
      id: g.id, name: g.name,
      icon: g.iconURL({ size: 64 }) || null,
      memberCount: g.memberCount,
    }));
    return json(res, 200, guilds);
  }

  // GET /api/guild/:id — ข้อมูลเซิร์ฟ + channels + settings จาก Redis
  if (u.pathname.match(/^\/api\/guild\/(\d+)$/) && req.method === 'GET') {
    const gid   = u.pathname.split('/')[3];
    const guild = client.guilds.cache.get(gid);
    if (!guild) return json(res, 404, { error: 'Guild not found' });

    const [settingsRaw, watchlistRaw] = await Promise.allSettled([
      redis.get(`panelcfg:${gid}`),
      redis.smembers(`watchlist:${gid}`),
    ]);

    const settings = (settingsRaw.status === 'fulfilled' && settingsRaw.value)
      ? (typeof settingsRaw.value === 'string' ? JSON.parse(settingsRaw.value) : settingsRaw.value)
      : {};

    const channels = guild.channels.cache
      .filter(c => c.type === 0) // GUILD_TEXT
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return json(res, 200, {
      id: guild.id, name: guild.name,
      icon: guild.iconURL({ size: 128 }) || null,
      memberCount: guild.memberCount,
      channels,
      watchlist: watchlistRaw.status === 'fulfilled' ? (watchlistRaw.value || []) : [],
      settings: {
        // defaults จาก env ถ้ายังไม่เคยตั้ง
        logChannelId:   settings.logChannelId   ?? (LOG_CHANNEL || ''),
        spamChannelIds: settings.spamChannelIds ?? SPAM_CHANNELS,
        spamMsgLimit:   settings.spamMsgLimit   ?? SPAM_MSG_LIMIT,
        spamWindowSec:  settings.spamWindowSec  ?? SPAM_WINDOW_SEC,
        warnBeforeBan:  settings.warnBeforeBan  ?? WARN_BEFORE_BAN,
        raidThresh:     settings.raidThresh     ?? RAID_THRESH,
        raidWindow:     settings.raidWindow     ?? RAID_WINDOW,
        nukeThresh:     settings.nukeThresh     ?? NUKE_THRESH,
        allowedInvites: settings.allowedInvites ?? ALLOWED_INVITES,
        antiSpam:       settings.antiSpam       ?? true,
        antiInvite:     settings.antiInvite     ?? true,
        antiToken:      settings.antiToken      ?? true,
        antiGhostPing:  settings.antiGhostPing  ?? true,
        raidProtect:    settings.raidProtect    ?? true,
        nukeProtect:    settings.nukeProtect    ?? true,
      },
    });
  }

  // POST /api/guild/:id/settings — บันทึก settings
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/settings$/) && req.method === 'POST') {
    const gid  = u.pathname.split('/')[3];
    const data = await body(req);
    await redis.set(`panelcfg:${gid}`, JSON.stringify(data));
    console.log(`[Panel] Settings saved for guild ${gid}`);
    return json(res, 200, { ok: true });
  }

  // GET /api/guild/:id/logs/:userId — ดู user log
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/logs\/(\d+)$/) && req.method === 'GET') {
    const parts  = u.pathname.split('/');
    const gid    = parts[3];
    const uid    = parts[5];
    const logs   = await redis.lrange(`userlog:${gid}:${uid}`, 0, 49) || [];
    return json(res, 200, { userId: uid, logs });
  }

  // POST /api/guild/:id/watchlist — add/remove watchlist
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/watchlist$/) && req.method === 'POST') {
    const gid    = u.pathname.split('/')[3];
    const { action, userId } = await body(req);
    const key    = `watchlist:${gid}`;
    if (action === 'add')    await redis.sadd(key, userId);
    if (action === 'remove') await redis.srem(key, userId);
    return json(res, 200, { ok: true });
  }

  // POST /api/guild/:id/clearwarns — ล้าง warns
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/clearwarns$/) && req.method === 'POST') {
    const gid    = u.pathname.split('/')[3];
    const { userId } = await body(req);
    await Promise.allSettled([
      redis.del(`spamwarn:${gid}:${userId}`),
      redis.del(`invwarn:${gid}:${userId}`),
    ]);
    return json(res, 200, { ok: true });
  }

  // GET /api/guild/:id/actionlogs — ดู server-wide action log (50 รายการล่าสุด)
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/actionlogs$/) && req.method === 'GET') {
    const gid = u.pathname.split('/')[3];
    // ดึง key userlog:gid:* ทั้งหมด แล้วรวม log
    const keys = await redis.keys(`userlog:${gid}:*`).catch(() => []);
    if (!keys.length) return json(res, 200, { logs: [] });

    const results = await Promise.allSettled(keys.map(k => redis.lrange(k, 0, 9)));
    const logs = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const uid = keys[i].split(':')[2];
      (r.value || []).forEach(line => logs.push({ uid, line }));
    });
    // sort โดย timestamp ที่อยู่ใน line
    logs.sort((a, b) => b.line.localeCompare(a.line));
    return json(res, 200, { logs: logs.slice(0, 100) });
  }

  // GET /api/guild/:id/warns — ดู warn summary ของทุก user
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/warns$/) && req.method === 'GET') {
    const gid = u.pathname.split('/')[3];
    const [spamKeys, invKeys] = await Promise.allSettled([
      redis.keys(`spamwarn:${gid}:*`),
      redis.keys(`invwarn:${gid}:*`),
    ]);
    const allUids = new Set([
      ...(spamKeys.status === 'fulfilled' ? spamKeys.value.map(k => k.split(':')[2]) : []),
      ...(invKeys.status === 'fulfilled'  ? invKeys.value.map(k => k.split(':')[2])  : []),
    ]);
    if (!allUids.size) return json(res, 200, { warns: [] });

    const warns = await Promise.allSettled([...allUids].map(async uid => {
      const [s, i] = await Promise.allSettled([
        redis.get(`spamwarn:${gid}:${uid}`),
        redis.get(`invwarn:${gid}:${uid}`),
      ]);
      return {
        uid,
        spam:   s.status === 'fulfilled' ? (s.value || 0) : 0,
        invite: i.status === 'fulfilled' ? (i.value || 0) : 0,
      };
    }));
    const result = warns
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(w => w.spam > 0 || w.invite > 0)
      .sort((a, b) => (b.spam + b.invite) - (a.spam + a.invite));
    return json(res, 200, { warns: result });
  }

  // GET /api/guild/:id/newaccs — บัญชีใหม่ที่น่าสงสัย
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/newaccs$/) && req.method === 'GET') {
    const gid  = u.pathname.split('/')[3];
    const uids = await redis.smembers(`newaccs:${gid}`).catch(() => []);
    if (!uids.length) return json(res, 200, { accounts: [] });

    const infos = await Promise.allSettled(
      uids.map(uid => redis.get(`newaccinfo:${gid}:${uid}`))
    );
    const accounts = infos
      .map((r, i) => {
        if (r.status !== 'fulfilled' || !r.value) return null;
        const d = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        return d;
      })
      .filter(Boolean)
      .sort((a, b) => b.joinedAt - a.joinedAt);
    return json(res, 200, { accounts });
  }

  // POST /api/guild/:id/ban — ban user ด้วย ID ตรงๆ
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/ban$/) && req.method === 'POST') {
    const gid  = u.pathname.split('/')[3];
    const { userId, reason } = await body(req);
    const guild = client.guilds.cache.get(gid);
    if (!guild) return json(res, 404, { error: 'Guild not found' });
    try {
      await guild.members.ban(userId, { reason: reason || 'Banned via Panel', deleteMessageSeconds: 0 });
      // ลบออกจาก newaccs set
      redis.srem(`newaccs:${gid}`, userId).catch(() => {});
      console.log(`[Panel] Banned ${userId} from guild ${gid}`);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /api/guild/:id/dismiss-newacc — ปิด alert บัญชีนี้
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/dismiss-newacc$/) && req.method === 'POST') {
    const gid  = u.pathname.split('/')[3];
    const { userId } = await body(req);
    await Promise.allSettled([
      redis.srem(`newaccs:${gid}`, userId),
      redis.del(`newaccinfo:${gid}:${userId}`),
    ]);
    return json(res, 200, { ok: true });
  }

  // POST /api/guild/:id/mute — timeout user X นาที
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/mute$/) && req.method === 'POST') {
    const gid  = u.pathname.split('/')[3];
    const { userId, minutes, reason } = await body(req);
    const guild = client.guilds.cache.get(gid);
    if (!guild) return json(res, 404, { error: 'Guild not found' });
    try {
      const member = await guild.members.fetch(userId);
      await member.timeout(minutes * 60 * 1000, reason || `Muted via Panel (${minutes} นาที)`);
      console.log(`[Panel] Muted ${userId} for ${minutes}m in guild ${gid}`);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /api/guild/:id/unmute — ยกเลิก timeout
  if (u.pathname.match(/^\/api\/guild\/(\d+)\/unmute$/) && req.method === 'POST') {
    const gid  = u.pathname.split('/')[3];
    const { userId } = await body(req);
    const guild = client.guilds.cache.get(gid);
    if (!guild) return json(res, 404, { error: 'Guild not found' });
    try {
      const member = await guild.members.fetch(userId);
      await member.timeout(null);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  res.writeHead(404); res.end();
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Panel server on port ${process.env.PORT || 3000}`);
  client.login(process.env.DISCORD_TOKEN);
});

client.once('ready', () => console.log(`✅ ${client.user.tag} online`));
