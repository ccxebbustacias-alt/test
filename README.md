# Discord Security Bot

บอทป้องกัน snipe / ghost ping / raid / nuke บน Discord — deploy บน Render ใช้ Upstash Redis

## ฟีเจอร์

| ฟีเจอร์ | รายละเอียด |
|---|---|
| Delete Snipe | `!snipe` — ดูข้อความที่ถูกลบใน 30 วิ |
| Edit Snipe | `!editsnipe` — ดูข้อความก่อน/หลัง edit |
| Ghost Ping | แจ้ง log อัตโนมัติเมื่อ ping แล้วลบ |
| Anti-Raid | แจ้งเตือนเมื่อมีคนเข้าเซิร์ฟจำนวนมากในเวลาสั้น |
| Anti-Nuke | แจ้งเตือนเมื่อมีการลบห้องหลายห้องอย่างรวดเร็ว |
| Lockdown | `!lockdown` / `!unlock` — ล็อคห้องฉุกเฉิน |

---

## วิธี Deploy

### 1. สร้าง Discord Bot

1. ไปที่ [discord.com/developers/applications](https://discord.com/developers/applications)
2. กด **New Application** → ตั้งชื่อ
3. ไปหน้า **Bot** → กด **Reset Token** → copy token ไว้
4. เปิด **Privileged Gateway Intents** ทั้ง 3 ตัว:
   - Server Members Intent
   - Message Content Intent
   - Presence Intent (optional)
5. ไปหน้า **OAuth2 → URL Generator** เลือก scope: `bot`
   Permission ที่ต้องการ: `Send Messages`, `Read Message History`, `Manage Channels`, `View Audit Log`
6. เปิดลิงก์ที่ได้ → เชิญบอทเข้าเซิร์ฟ

### 2. สร้าง Upstash Redis

1. ไปที่ [console.upstash.com](https://console.upstash.com)
2. กด **Create Database** → เลือก region ใกล้ที่สุด
3. copy `UPSTASH_REDIS_REST_URL` และ `UPSTASH_REDIS_REST_TOKEN`

### 3. Deploy บน Render

1. fork/push โปรเจกต์นี้ขึ้น GitHub
2. ไปที่ [render.com](https://render.com) → **New → Background Worker**
3. เชื่อม GitHub repo → Render จะอ่าน `render.yaml` อัตโนมัติ
4. กรอก Environment Variables:

```
DISCORD_TOKEN        = (token จากข้อ 1)
LOG_CHANNEL_ID       = (ID ห้อง log — คลิกขวาที่ห้อง → Copy Channel ID)
UPSTASH_REDIS_REST_URL   = (จากข้อ 2)
UPSTASH_REDIS_REST_TOKEN = (จากข้อ 2)
PREFIX               = !
```

5. กด **Deploy** — เสร็จ!

---

## รันในเครื่องก่อน (optional)

```bash
git clone <repo>
cd discord-security-bot
npm install
cp .env.example .env   # แล้วแก้ค่าใน .env
npm run dev
```

---

## ปรับแต่ง

| ตัวแปร | ไฟล์ | ค่า default | ความหมาย |
|---|---|---|---|
| `CACHE_TTL` | src/index.js | 30 วิ | อายุ cache snipe |
| `SNIPE_CD` | src/index.js | 5000 ms | cooldown คำสั่ง snipe |
| `RAID_THRESH` | src/index.js | 5 คน | จำนวน join ที่ถือว่า raid |
| `RAID_WINDOW` | src/index.js | 10 วิ | ช่วงเวลา anti-raid |
| `NUKE_THRESH` | src/index.js | 3 ห้อง | จำนวนห้องที่ลบถือว่า nuke |
