'use strict';

/**
 * 树洞 · 服务端
 * 零依赖：只用 Node 内置模块。数据保存在 data/store.json。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const LIMITS = {
  post: 600,
  comment: 240,
  name: 12,
  postsPerMinute: Number(process.env.POSTS_PER_MINUTE) || 4,
  commentsPerMinute: Number(process.env.COMMENTS_PER_MINUTE) || 8,
  reportHideAt: 5,
  feedMax: 60,
};

// 图片：只收 PNG / JPG / GIF / WebP，按魔数校验，单张上限 6MB
const IMAGE_LIMITS = {
  maxBytes: Number(process.env.IMAGE_MAX_BYTES) || 4 * 1024 * 1024,
  perMinute: Number(process.env.IMAGES_PER_MINUTE) || 12,
};

// 私聊：一对一会话
const CHAT_LIMITS = {
  message: 800,
  chatsPerMinute: Number(process.env.CHATS_PER_MINUTE) || 6,
  messagesPerMinute: Number(process.env.CHAT_MESSAGES_PER_MINUTE) || 30,
};

// 账号：密码只保存 scrypt 派生结果；会话只保存 token 的哈希
const AUTH_LIMITS = {
  username: 20,
  displayName: 12,
  passwordMin: 8,
  passwordMax: 72,
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  registerPerMinute: Number(process.env.REGISTER_PER_MINUTE) || 5,
  loginPerMinute: Number(process.env.LOGIN_PER_MINUTE) || 10,
};

const SESSION_COOKIE = 'th_session';

const APP_VERSION = '3.1.0';
const TRUSTED_PROXY = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
const ENABLE_HSTS = /^(1|true|on|yes)$/i.test(String(process.env.ENABLE_HSTS || (PUBLIC_ORIGIN.startsWith('https://') ? '1' : '')));
const REQUIRE_LOGIN = !/^(0|false|off|no)$/i.test(String(process.env.REQUIRE_LOGIN ?? '1'));
const BACKUP_ENCRYPTION_KEY = String(process.env.BACKUP_ENCRYPTION_KEY || '');
const DEFAULT_TIME_ZONE = String(process.env.DEFAULT_TIME_ZONE || '').trim();
const ALERT_WEBHOOK_URL = String(process.env.ALERT_WEBHOOK_URL || '').trim();
const MAX_IMAGE_PIXELS = Number(process.env.MAX_IMAGE_PIXELS) || 40 * 1000 * 1000;
const LOGIN_LOCK_AFTER = Number(process.env.LOGIN_LOCK_AFTER) || 8;
const LOGIN_LOCK_BASE_MS = Number(process.env.LOGIN_LOCK_BASE_MS) || 15000;
const RECALL_WINDOW_MS = Number(process.env.RECALL_WINDOW_MS) || 2 * 60 * 1000;
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const ADMIN_MODERATOR_TOKEN = String(process.env.ADMIN_MODERATOR_TOKEN || '').trim();
const ADMIN_READONLY_TOKEN = String(process.env.ADMIN_READONLY_TOKEN || '').trim();
const IMAGE_REVIEW = /^(1|true|on|yes)$/i.test(String(process.env.IMAGE_REVIEW || ''));
const IMAGE_RETENTION_DAYS = nonNegativeEnvNumber('IMAGE_RETENTION_DAYS', 30);
const IMAGE_CLEANUP_INTERVAL_HOURS = nonNegativeEnvNumber('IMAGE_CLEANUP_INTERVAL_HOURS', 0);
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS) || 0;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;
const TERMS_VERSION = '2026-10-09';

function nonNegativeEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const REPORT_REASONS = [
  { id: 'harm', label: '伤害自己或他人' },
  { id: 'harass', label: '辱骂或骚扰' },
  { id: 'ad', label: '广告或导流' },
  { id: 'privacy', label: '泄露隐私' },
  { id: 'porn', label: '色情或低俗' },
  { id: 'other', label: '其他' },
];

const REPORT_LIMITS = { perMinute: Number(process.env.REPORTS_PER_MINUTE) || 10 };
const REACTION_LIMITS = { perMinute: Number(process.env.REACTIONS_PER_MINUTE) || 60 };
const CHAT_REQUEST_LIMITS = { perMinute: Number(process.env.CHAT_REQUESTS_PER_MINUTE) || 8 };

const PET_SPECIES = [
  { id: 'shuling', label: '树灵', emoji: '🌱', hint: '安静、慢热，会在你写心事时陪着呼吸。' },
  { id: 'xingmao', label: '星猫', emoji: '🐈', hint: '半夜最有精神，喜欢听你讲白天没说完的话。' },
  { id: 'yunhu', label: '云狐', emoji: '🦊', hint: '聪明又黏人，擅长把坏心情叼走。' },
  { id: 'haitu', label: '海兔', emoji: '🐇', hint: '软乎乎的，适合抱一会儿再继续生活。' },
  { id: 'xiaolong', label: '眠龙', emoji: '🐉', hint: '平时打盹，认真起来会替你守住秘密。' },
  { id: 'yuejing', label: '月鲸', emoji: '🐳', hint: '情绪很深，但从来不嫌你的心事太多。' },
];

const PET_ACTIONS = {
  feed: { label: '喂点星光', emoji: '🥣', cooldownMs: 2 * 60 * 60 * 1000 },
  pat: { label: '摸摸头', emoji: '🫳', cooldownMs: 20 * 60 * 1000 },
  play: { label: '陪它玩', emoji: '🎾', cooldownMs: 60 * 60 * 1000 },
};

const PET_GROWTH_STAGES = [
  { id: 'baby', label: '幼生期', emoji: '🌱', minLevel: 1, maxLevel: 5, description: '刚刚认识，正在学会信任你的脚步声。' },
  { id: 'growing', label: '成长期', emoji: '🌿', minLevel: 6, maxLevel: 14, description: '越来越有精神，也开始记得你的习惯。' },
  { id: 'companion', label: '陪伴期', emoji: '🫧', minLevel: 15, maxLevel: 29, description: '已经把等待你回来，当作每天最安静的一部分。' },
  { id: 'resonance', label: '心灵共鸣', emoji: '✨', minLevel: 30, maxLevel: 49, description: '不用多说，它也能听懂你没说出口的情绪。' },
  { id: 'bond', label: '永恒羁绊', emoji: '💞', minLevel: 50, maxLevel: 50, description: '无论日子怎样起伏，它都会在你身边留下一盏灯。' },
];

const PET_DECORATIONS = [
  { id: 'default', label: '自然原色', emoji: '🪴', minLevel: 1, hint: '保持最舒服的样子。' },
  { id: 'sprout', label: '嫩叶冠', emoji: '🌿', minLevel: 3, hint: '春天落在它的额角。' },
  { id: 'starlight', label: '星光围巾', emoji: '✨', minLevel: 8, hint: '夜里也会发出很轻的光。' },
  { id: 'moon', label: '月光桂冠', emoji: '🌙', minLevel: 15, hint: '适合安静地陪你熬夜。' },
  { id: 'bloom', label: '春日花环', emoji: '🌸', minLevel: 30, hint: '只送给长久陪伴的你们。' },
];

const MOODS = [
  { id: 'calm', label: '平静', emoji: '🌿' },
  { id: 'happy', label: '开心', emoji: '🌞' },
  { id: 'hopeful', label: '有希望', emoji: '🌤️' },
  { id: 'grateful', label: '感激', emoji: '🍀' },
  { id: 'excited', label: '期待', emoji: '✨' },
  { id: 'peaceful', label: '安心', emoji: '🫧' },
  { id: 'tired', label: '疲惫', emoji: '🌙' },
  { id: 'sad', label: '难过', emoji: '🌧️' },
  { id: 'lonely', label: '孤单', emoji: '🫂' },
  { id: 'missYou', label: '想念', emoji: '📮' },
  { id: 'needHug', label: '需要抱抱', emoji: '🫶' },
  { id: 'angry', label: '生气', emoji: '🔥' },
  { id: 'anxious', label: '焦虑', emoji: '🌀' },
  { id: 'overwhelmed', label: '撑不住', emoji: '🌊' },
  { id: 'numb', label: '麻木', emoji: '🫥' },
  { id: 'confused', label: '迷茫', emoji: '🌫️' },
];

const REACTIONS = [
  { id: 'hug', label: '抱抱', emoji: '🫂' },
  { id: 'relate', label: '我懂', emoji: '💧' },
  { id: 'cheer', label: '加油', emoji: '🌱' },
];

// 快捷表情沿用回应系统：同一个人可点亮 / 取消，不同用户的数量会累加。
const QUICK_EMOJIS = [
  { id: 'warm', label: '抱抱你', emoji: '🫶' },
  { id: 'touch', label: '摸摸头', emoji: '🥺' },
  { id: 'smile', label: '陪你笑', emoji: '😊' },
  { id: 'heartache', label: '心疼你', emoji: '🥹' },
  { id: 'cry', label: '陪你哭', emoji: '😭' },
  { id: 'laugh', label: '轻松一下', emoji: '😂' },
  { id: 'love', label: '被暖到', emoji: '🥰' },
  { id: 'sleepy', label: '早点睡', emoji: '😴' },
  { id: 'moon', label: '晚安', emoji: '🌙' },
  { id: 'sun', label: '会好的', emoji: '☀️' },
  { id: 'tea', label: '喝口热的', emoji: '🍵' },
  { id: 'clover', label: '好运给你', emoji: '🍀' },
  { id: 'thumb', label: '\u6536\u5230', emoji: '\ud83d\udc4d' },
  { id: 'warmhug', label: '\u518d\u62b1\u62b1', emoji: '\ud83e\udd17' },
  { id: 'care', label: '\u9ed8\u9ed8\u5173\u5fc3', emoji: '\ud83e\udd0d' },
  { id: 'rainbow', label: '\u96e8\u8fc7\u5929\u6674', emoji: '\ud83c\udf08' },
  { id: 'strength', label: '\u6491\u4f4f', emoji: '\ud83d\udcaa' },
  { id: 'thanks', label: '\u8c22\u8c22\u4f60', emoji: '\ud83d\ude4f' },
  { id: 'sparkle', label: '\u613f\u4f60\u987a\u5229', emoji: '\u2728' },
  { id: 'touched', label: '\u88ab\u89e6\u52a8', emoji: '\ud83d\udd25' },
];
const ALL_REACTIONS = [...REACTIONS, ...QUICK_EMOJIS];

// 一天不是一种心情：按人的真实作息拆成五个时段，分别统计。
const MOOD_SLOTS = [
  { id: 'dawn', label: '清晨', emoji: '🌅', from: 5, to: 9,
    topic: '清晨的微风', prompt: '醒来第一个念头，往往最真实。今天睁眼时，你心里是什么？' },
  { id: 'day', label: '上午', emoji: '☀️', from: 9, to: 12,
    topic: '上午的专注', prompt: '一天刚刚展开，说说此刻最想完成、或者最放不下的一件事。' },
  { id: 'noon', label: '午后', emoji: '🌤️', from: 12, to: 17,
    topic: '午后的倦意', prompt: '阳光慢下来的时候，疲惫和心事也容易浮上来。' },
  { id: 'dusk', label: '傍晚', emoji: '🌇', from: 17, to: 21,
    topic: '傍晚的归途', prompt: '下班、放学、回家的路上，今天有什么想留在风里？' },
  { id: 'night', label: '深夜', emoji: '🌙', from: 21, to: 5,
    topic: '深夜的树洞', prompt: '夜深了，把白天没说完的话慢慢放进来吧。' },
];

// 广告 / 导流：直接拦截
const AD_WORDS = [
  '加微信', '加vx', '加VX', '加微信', '私聊我', '刷单', '博彩', '赌博',
  '代开发票', '无门槛贷款', '带你赚钱', '稳赚不赔', '兼职日结', '招代理',
  '加qq', '加QQ', '扫码进群', '返利', '套现', '洗钱',
];

// 危机信号：不拦截，但私下给作者一张关怀卡
const CRISIS_WORDS = [
  '自杀', '自残', '不想活', '活不下去', '结束生命', '割腕', '跳楼',
  '轻生', '想死', '没意思了', '撑不下去',
];

const CARE = {
  title: '你不需要一个人扛',
  body: '如果此刻真的撑不住了，把这些号码当成一根绳子——拉一下，会有人回应的。',
  lines: [
    '全国心理援助热线：12356',
    '希望24热线：400-161-9995',
    '北京心理危机研究与干预中心：010-8295-1332',
  ],
  tip: '也可以先做 10 次深呼吸，喝口热水，把窗打开。愿意的话再写一点，这里有人听着。',
};

/* ---------------------------------- 存储 ---------------------------------- */

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

let store = {
  posts: [], moods: [], chats: [], users: [], sessions: [], pets: [],
  blocks: [], notifications: [], images: [], reports: [], adminLogs: [],
  favorites: [], appeals: [], riskEvents: [], restrictions: [],
  createdAt: new Date().toISOString(),
};

function normalizeStore(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const sessions = Array.isArray(s.sessions)
    ? s.sessions.filter((x) => x && typeof x.tokenHash === 'string' && Number(x.expiresAt) > Date.now())
    : [];
  const moods = Array.isArray(s.moods)
    ? s.moods.filter((m) => m && typeof m === 'object').map((m) => ({
      ...m,
      slot: validMoodSlot(m.slot) ? m.slot : slotOfDate(new Date(m.createdAt || m.updatedAt || Date.now())),
    }))
    : [];
  const chats = Array.isArray(s.chats)
    ? s.chats.map((c) => ({
      ...c,
      status: ['pending', 'accepted', 'declined', 'blocked'].includes(c.status) ? c.status : 'accepted',
      requestedBy: c.requestedBy === 'a' || c.requestedBy === 'b' ? c.requestedBy : 'a',
      messages: Array.isArray(c.messages) ? c.messages.map((m) => ({ ...m, recalledAt: m.recalledAt || null })) : [],
      reads: c.reads && typeof c.reads === 'object' ? c.reads : { a: 0, b: 0 },
    }))
    : [];
  return {
    posts: Array.isArray(s.posts) ? s.posts : [],
    moods,
    chats,
    users: Array.isArray(s.users) ? s.users : [],
    sessions,
    pets: Array.isArray(s.pets) ? s.pets : [],
    blocks: Array.isArray(s.blocks) ? s.blocks : [],
    notifications: Array.isArray(s.notifications) ? s.notifications.slice(-500) : [],
    images: Array.isArray(s.images) ? s.images : [],
    reports: Array.isArray(s.reports) ? s.reports : [],
    adminLogs: Array.isArray(s.adminLogs) ? s.adminLogs.slice(-1000) : [],
    favorites: Array.isArray(s.favorites) ? s.favorites : [],
    appeals: Array.isArray(s.appeals) ? s.appeals.slice(-2000) : [],
    riskEvents: Array.isArray(s.riskEvents) ? s.riskEvents.slice(-5000) : [],
    restrictions: Array.isArray(s.restrictions) ? s.restrictions.slice(-2000) : [],
    createdAt: s.createdAt || new Date().toISOString(),
  };
}

function loadStore() {
  try {
    store = normalizeStore(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[warn] store.json 读取失败，使用空数据：', err.message);
    store = normalizeStore(null);
  }
}

let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 350);
}

function flush() {
  try {
    ensureDirs();
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    console.error('[error] 保存失败：', err.message);
  }
}

/* --------------------------------- 工具函数 -------------------------------- */

const rid = (n = 10) => crypto.randomBytes(n).toString('hex');

// 按魔数判断真实图片格式，不信任前端传的 Content-Type
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function readUInt24LE(buf, offset) {
  if (!buf || offset < 0 || offset + 3 > buf.length) return null;
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function jpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < buf.length) {
    while (offset < buf.length && buf[offset] !== 0xff) offset += 1;
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    if (offset >= buf.length) break;
    const marker = buf[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) break;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) break;
    if (sofMarkers.has(marker)) {
      if (length < 7) return null;
      return { width: buf.readUInt16BE(offset + 5), height: buf.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function imageDimensions(buf, ext) {
  if (!buf || !ext) return null;
  try {
    if (ext === 'png') {
      if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === 'gif') {
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === 'jpg') return jpegDimensions(buf);
    if (ext === 'webp') {
      if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        if (buf.length < 30) return null;
        return { width: 1 + readUInt24LE(buf, 24), height: 1 + readUInt24LE(buf, 27) };
      }
      if (chunk === 'VP8 ') {
        if (buf.length < 30 || !(buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)) return null;
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        if (buf.length < 25 || buf[20] !== 0x2f) return null;
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return {
          width: 1 + (b0 | ((b1 & 0x3f) << 8)),
          height: 1 + (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))),
        };
      }
    }
  } catch { return null; }
  return null;
}

function inspectImage(buf, ext) {
  const dimensions = imageDimensions(buf, ext);
  if (!dimensions || !dimensions.width || !dimensions.height) {
    return { ok: false, reason: 'invalid' };
  }
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: 'too_large', ...dimensions };
  }
  return { ok: true, ...dimensions };
}

function validImageName(name) {
  return typeof name === 'string' && /^[a-f0-9]{16,32}\.(png|jpg|gif|webp)$/.test(name);
}

function imagePath(name) {
  return path.join(UPLOAD_DIR, name);
}

// 只有当图片确实由本站上传过，才允许挂到心事 / 回音 / 私聊上
function imageExists(name) {
  if (!validImageName(name)) return false;
  try { return fs.statSync(imagePath(name)).isFile(); } catch { return false; }
}

function validTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); return true; } catch { return false; }
}

function todayKey(timeZone) {
  return dayKeyOf(new Date(), timeZone);
}

function dayKeyOf(date, timeZone) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (!validTimeZone(timeZone)) return d.toLocaleDateString('sv-SE');
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toLocaleDateString('sv-SE'); }
}

function validDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validMoodSlot(value) {
  return MOOD_SLOTS.some((slot) => slot.id === value);
}

function requestTimeZone(req, url, body) {
  const user = currentUser(req);
  const candidates = [
    body && body.timeZone,
    url && url.searchParams && url.searchParams.get('timeZone'),
    req && req.headers && req.headers['x-time-zone'],
    user && user.timeZone,
    DEFAULT_TIME_ZONE,
  ];
  for (const value of candidates) {
    if (validTimeZone(value)) return value;
  }
  return undefined;
}

function slotOfDate(date, timeZone) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  let hour = d.getHours();
  if (validTimeZone(timeZone)) {
    try { hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(d)); }
    catch { hour = d.getHours(); }
  }
  for (const slot of MOOD_SLOTS) {
    if (slot.from < slot.to ? hour >= slot.from && hour < slot.to : hour >= slot.from || hour < slot.to) return slot.id;
  }
  return 'night';
}

function moodSlotOfRecord(mood, timeZone) {
  return mood && validMoodSlot(mood.slot) ? mood.slot : slotOfDate(new Date(mood?.createdAt || mood?.updatedAt || Date.now()), timeZone);
}

function clean(text, max) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim()
    .slice(0, max);
}

function cleanName(name) {
  const t = clean(name, LIMITS.name).replace(/\s+/g, ' ');
  return t || '匿名旅人';
}

function hasAny(text, words) {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

// 导流特征：联系方式、群号、手机号
const AD_PATTERNS = [
  /(?<!参)[加私留发扫进+➕].{0,3}(微信|vx|wx|weixin|qq|扣扣|群)/i,
  /(微信|vx|wx|weixin|qq|扣扣)\s*(?:号|[:：])?\s*(?:是|为)?\s*[a-z0-9_\-]{5,}/i,
  /1[3-9]\d{9}/,
];

function looksLikeAd(text) {
  return hasAny(text, AD_WORDS) || AD_PATTERNS.some((re) => re.test(text));
}

/* ------------------------- 反滥用 / 风险画像 ------------------------- */

// 先记录、再判断：除广告外，其他风险默认只进入后台观察队列，不直接阻断表达。
const RISK_SIGNALS = {
  ad: { label: '广告或导流', weight: 30, severity: 'high' },
  abuse: { label: '辱骂或骚扰', weight: 22, severity: 'medium' },
  threat: { label: '威胁或伤害', weight: 40, severity: 'high' },
  sexual: { label: '色情或低俗', weight: 30, severity: 'high' },
  privacy: { label: '隐私暴露风险', weight: 18, severity: 'medium' },
  report: { label: '被举报内容', weight: 14, severity: 'medium' },
  rate_limit: { label: '操作频率异常', weight: 12, severity: 'low' },
  repeat_report: { label: '重复举报', weight: 10, severity: 'low' },
};

const ABUSE_WORDS = [
  '傻逼', '傻b', '废物', '垃圾人', '脑残', '白痴', '滚出去', '去死',
  '死全家', '贱人', '恶心死了', '智障', '丑八怪', '神经病', '恶心人',
];
const THREAT_WORDS = [
  '弄死你', '杀了你', '打死你', '报复你', '人肉你', '开盒', '曝光你',
  '让你付出代价', '找到你', '弄死他', '伤害你',
];
const SEXUAL_WORDS = [
  '裸聊', '约炮', '黄图', '色情服务', '性服务', '骚货', '操你', '看片',
];
const PRIVACY_WORDS = [
  '身份证号', '家庭住址', '银行卡号', '手机号码', '学校班级', '具体住址',
];

function contentRiskSignals(text) {
  const value = String(text || '');
  if (!value.trim()) return [];
  const codes = [];
  if (looksLikeAd(value)) codes.push('ad');
  if (hasAny(value, ABUSE_WORDS)) codes.push('abuse');
  if (hasAny(value, THREAT_WORDS)) codes.push('threat');
  if (hasAny(value, SEXUAL_WORDS)) codes.push('sexual');
  if (hasAny(value, PRIVACY_WORDS)) codes.push('privacy');
  return [...new Set(codes)].map((code) => ({ code, ...RISK_SIGNALS[code] }));
}

function reportRiskCodes(reason) {
  return ({
    harm: ['threat'],
    harass: ['abuse'],
    ad: ['ad'],
    privacy: ['privacy'],
    porn: ['sexual'],
    other: ['report'],
  }[reason] || ['report']);
}

function riskReasons(codes) {
  return [...new Set((codes || []).map((x) => String(x || '').trim()).filter(Boolean))]
    .map((code) => {
      const meta = RISK_SIGNALS[code] || { label: '其他风险', weight: 10, severity: 'low' };
      return { code, label: meta.label, weight: meta.weight, severity: meta.severity };
    });
}

function riskLevel(score) {
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  if (n >= 70) return 'critical';
  if (n >= 40) return 'high';
  if (n >= 18) return 'medium';
  return 'low';
}

function riskSubjectKey(subjectType, subjectId) {
  return String(subjectType || 'client') + ':' + String(subjectId || '');
}

function recordRiskEvent(input) {
  const source = input && typeof input === 'object' ? input : {};
  const subjectId = clean(String(source.subjectId || ''), 96);
  if (!subjectId) return null;
  const subjectType = source.subjectType === 'ip' ? 'ip' : 'client';
  const reasons = riskReasons(source.reasons || source.reason || []);
  if (!reasons.length) return null;
  const score = Math.max(1, Math.min(100, Number(source.score) || reasons.reduce((sum, r) => sum + r.weight, 0)));
  const event = {
    id: rid(8),
    subjectType,
    subjectId,
    subjectKey: riskSubjectKey(subjectType, subjectId),
    surface: clean(source.surface || 'content', 32),
    targetType: clean(source.targetType || '', 32),
    targetId: clean(source.targetId || '', 96),
    text: clean(source.text || '', 180),
    reasons,
    score,
    level: riskLevel(score),
    status: 'open',
    blocked: Boolean(source.blocked),
    ip: source.ip ? clean(String(source.ip), 64) : null,
    actorClientId: source.actorClientId ? clean(String(source.actorClientId), 80) : null,
    createdAt: new Date().toISOString(),
  };
  store.riskEvents = store.riskEvents || [];
  store.riskEvents.push(event);
  if (store.riskEvents.length > 5000) store.riskEvents = store.riskEvents.slice(-5000);
  scheduleSave();
  return event;
}

function reportRiskEvent(input) {
  const source = input && typeof input === 'object' ? input : {};
  const textSignals = contentRiskSignals(source.text || source.postText || '').map((x) => x.code);
  const codes = [...reportRiskCodes(source.reason), ...textSignals];
  return recordRiskEvent({
    subjectId: source.authorClientId,
    subjectType: source.authorClientId ? 'client' : 'ip',
    surface: source.surface || 'report',
    targetType: source.targetType,
    targetId: source.targetId,
    text: source.text || source.postText || source.note || '',
    reasons: codes,
    ip: source.ip,
    actorClientId: source.reporterClientId,
  });
}

function riskProfile(subjectType, subjectId) {
  const key = riskSubjectKey(subjectType, subjectId);
  const events = (store.riskEvents || [])
    .filter((e) => riskSubjectKey(e.subjectType || 'client', e.subjectId) === key)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const cutoff = Date.now() - 30 * 86400000;
  const active = events.filter((e) => e.status !== 'resolved' && new Date(e.createdAt || 0).getTime() >= cutoff);
  const score = Math.min(100, active.reduce((sum, e) => sum + (Number(e.score) || 0), 0));
  const reasons = {};
  for (const event of active) for (const r of (event.reasons || [])) reasons[r.code] = (reasons[r.code] || 0) + 1;
  const last = events[events.length - 1];
  return {
    subjectType,
    subjectId,
    subjectKey: key,
    score,
    level: riskLevel(score),
    status: active.some((e) => e.status === 'watching') ? 'watching' : (active.length ? 'open' : 'clear'),
    openCount: active.filter((e) => e.status === 'open').length,
    watchingCount: active.filter((e) => e.status === 'watching').length,
    actionedCount: active.filter((e) => e.status === 'actioned').length,
    eventCount: events.length,
    lastAt: last ? last.createdAt : null,
    reasons,
  };
}

function activeRestriction(subjectType, subjectId) {
  const now = Date.now();
  return (store.restrictions || []).find((r) => r && r.subjectType === subjectType && r.subjectId === subjectId && !r.liftedAt && (!Number(r.until) || Number(r.until) > now)) || null;
}

function riskRestrictionFor(clientId, ip) {
  const clientRestriction = validClientId(clientId) ? activeRestriction('client', clientId) : null;
  if (clientRestriction) return clientRestriction;
  return ip ? activeRestriction('ip', ip) : null;
}

function riskRestrictionMessage(restriction) {
  if (!restriction) return '';
  return restriction.kind === 'block'
    ? '你的账号已被限制发布和互动，请联系管理员复核。'
    : '你当前处于冷静期，暂时不能发布、评论或发起私聊。';
}

function riskSubjectTypeFor(subjectId) {
  return validClientId(subjectId) ? 'client' : 'ip';
}

function recordRateLimitRisk(subjectId, ip, surface, text, targetId) {
  return recordRiskEvent({
    subjectId,
    subjectType: riskSubjectTypeFor(subjectId),
    surface: surface || 'rate_limit',
    targetType: surface || '',
    targetId: targetId || '',
    text: text || '',
    reasons: ['rate_limit'],
    ip,
  });
}

function recordContentRisk(subjectId, ip, surface, text, targetId) {
  const signals = contentRiskSignals(text);
  if (!signals.length) return null;
  return recordRiskEvent({
    subjectId,
    subjectType: riskSubjectTypeFor(subjectId),
    surface,
    targetType: surface,
    targetId: targetId || '',
    text,
    reasons: signals.map((signal) => signal.code),
    ip,
    actorClientId: subjectId,
  });
}

function validClientId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function reactionCount(post) {
  return ALL_REACTIONS.reduce((sum, r) => sum + (post.reactions?.[r.id]?.length || 0), 0);
}

function activeComments(post) {
  return (post.comments || []).filter((c) => !c.deletedAt);
}

function visibleCommentsFor(post, clientId) {
  return activeComments(post).filter((c) => !clientId || !pairBlocked(clientId, c.clientId));
}

function reactionWeight(post, reactionId) {
  if (reactionId === 'hug') return 4;
  if (reactionId === 'relate' || reactionId === 'cheer') return 3;
  return 1;
}

function warmthScore(post, clientId) {
  let raw = visibleCommentsFor(post, clientId).length * 5;
  for (const reaction of ALL_REACTIONS) {
    raw += (post.reactions?.[reaction.id]?.length || 0) * reactionWeight(post, reaction.id);
  }
  const ageHours = Math.max(0, (Date.now() - new Date(post.createdAt).getTime()) / 3600000);
  return raw / Math.pow(1 + ageHours / 72, 0.28);
}

function isUnanswered(post, clientId) {
  return reactionCount(post) === 0 && visibleCommentsFor(post, clientId).length === 0;
}

function publicPost(post, clientId) {
  const reactions = {};
  const mine = [];
  for (const r of ALL_REACTIONS) {
    const list = post.reactions?.[r.id] || [];
    reactions[r.id] = list.length;
    if (clientId && list.includes(clientId)) mine.push(r.id);
  }
  const visibleComments = visibleCommentsFor(post, clientId);
  const authorReplied = visibleComments.some((c) => c.clientId === post.clientId);
  const imagePending = post.image ? imagePendingFor(post.image, clientId) : false;
  return {
    id: post.id,
    name: post.name,
    avatar: post.avatar,
    mood: post.mood,
    text: post.text,
    image: post.image && !imagePending ? post.image : null,
    imagePending,
    createdAt: post.createdAt,
    reactions,
    myReactions: mine,
    total: reactionCount(post),
    commentCount: visibleComments.length,
    mine: Boolean(clientId && post.clientId === clientId),
    favorited: Boolean(clientId && (store.favorites || []).some((f) => f.clientId === clientId && f.postId === post.id)),
    favoriteCount: (store.favorites || []).filter((f) => f.postId === post.id).length,
    responseState: {
      answered: reactionCount(post) + visibleComments.length > 0,
      hasReaction: reactionCount(post) > 0,
      hasComment: visibleComments.length > 0,
      authorReplied,
      unanswered: isUnanswered(post, clientId),
    },
  };
}

function publicComment(c, clientId) {
  const deleted = Boolean(c.deletedAt);
  const imagePending = c.image ? imagePendingFor(c.image, clientId) : false;
  return {
    id: c.id,
    name: c.name,
    avatar: c.avatar,
    text: deleted ? '' : c.text,
    image: deleted ? null : (c.image && !imagePending ? c.image : null),
    imageThumb: deleted ? null : (c.imageThumb || null),
    deleted,
    deletedAt: c.deletedAt || null,
    canDelete: Boolean(clientId && c.clientId === clientId && !deleted),
    imagePending,
    parentId: c.parentId || null,
    replyToName: c.replyToName || null,
    createdAt: c.createdAt,
    mine: Boolean(clientId && c.clientId === clientId),
    isAuthor: false,
  };
}

/* --------------------------------- 私聊 ----------------------------------- */

// 会话里的两方用 a / b 表示，消息只记 from: 'a' | 'b'，不落 clientId 到消息里
function chatSide(chat, clientId) {
  if (!clientId) return null;
  if (chat.a && chat.a.clientId === clientId) return 'a';
  if (chat.b && chat.b.clientId === clientId) return 'b';
  return null;
}

function publicMessage(m, side) {
  const recalled = Boolean(m.recalledAt);
  const canRecall = !recalled && m.from === side && Date.now() - new Date(m.createdAt).getTime() <= RECALL_WINDOW_MS;
  return {
    id: m.id,
    text: recalled ? '' : (m.text || ''),
    image: recalled ? null : (m.image || null),
    imageThumb: recalled ? null : (m.imageThumb || null),
    recalled,
    recalledAt: m.recalledAt || null,
    canRecall,
    recallUntil: recalled ? null : new Date(new Date(m.createdAt).getTime() + RECALL_WINDOW_MS).toISOString(),
    createdAt: m.createdAt,
    mine: m.from === side,
  };
}

function chatUnread(chat, side) {
  if (!side) return 0;
  const other = side === 'a' ? 'b' : 'a';
  const since = Number(chat.reads && chat.reads[side]) || 0;
  return (chat.messages || []).filter(
    (m) => m.from === other && new Date(m.createdAt).getTime() > since
  ).length;
}

// 对外只暴露对方的昵称 / 头像，绝不暴露 clientId
function publicChat(chat, side) {
  if (!side) return null;
  const other = side === 'a' ? 'b' : 'a';
  const peer = chat[other] || { name: '匿名旅人', avatar: '🌳' };
  const status = chat.status || 'accepted';
  const isRequester = chat.requestedBy === side;
  const canSeeMessages = status === 'accepted' || isRequester;
  const msgs = canSeeMessages ? (chat.messages || []) : [];
  const last = msgs[msgs.length - 1] || null;
  return {
    id: chat.id,
    postId: chat.postId || null,
    origin: chat.origin || 'post',
    status,
    requestedByMe: Boolean(isRequester),
    canReply: status === 'accepted',
    blocked: isBlockedBy(chat.a && chat.a.clientId, chat.b && chat.b.clientId) || isBlockedBy(chat.b && chat.b.clientId, chat.a && chat.a.clientId),
    peer: { name: peer.name, avatar: peer.avatar },
    lastMessage: last ? publicMessage(last, side) : null,
    unread: status === 'accepted' ? chatUnread(chat, side) : (status === 'pending' && !isRequester ? 1 : 0),
    messageCount: msgs.length,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt || chat.createdAt,
  };
}

function findChat(id) {
  return (store.chats || []).find((c) => c.id === id) || null;
}

function visiblePosts(clientId) {
  return store.posts.filter((p) => !p.hidden
    && (p.reports?.length || 0) < LIMITS.reportHideAt
    && (!clientId || !pairBlocked(clientId, p.clientId)));
}

/* ------------------------- 拉黑 / 通知 / 图片审核 ------------------------- */

function pairBlocked(a, b) {
  if (!a || !b || a === b) return false;
  return (store.blocks || []).some((x) =>
    (x.ownerClientId === a && x.targetClientId === b) ||
    (x.ownerClientId === b && x.targetClientId === a));
}

function isBlockedBy(ownerClientId, targetClientId) {
  if (!ownerClientId || !targetClientId) return false;
  return (store.blocks || []).some((x) => x.ownerClientId === ownerClientId && x.targetClientId === targetClientId);
}

function addBlock(ownerClientId, targetClientId) {
  if (!validClientId(ownerClientId) || !validClientId(targetClientId) || ownerClientId === targetClientId) return false;
  store.blocks = store.blocks || [];
  if (isBlockedBy(ownerClientId, targetClientId)) return false;
  store.blocks.push({ id: rid(8), ownerClientId, targetClientId, createdAt: new Date().toISOString() });
  if (store.blocks.length > 20000) store.blocks = store.blocks.slice(-20000);
  scheduleSave();
  return true;
}

function removeBlock(ownerClientId, targetClientId) {
  const before = (store.blocks || []).length;
  store.blocks = (store.blocks || []).filter((x) => !(x.ownerClientId === ownerClientId && x.targetClientId === targetClientId));
  if (store.blocks.length !== before) { scheduleSave(); return true; }
  return false;
}

function addNotification(ownerClientId, payload) {
  if (!ownerClientId || !validClientId(ownerClientId)) return null;
  if (payload.actorClientId && pairBlocked(ownerClientId, payload.actorClientId)) return null;
  if (payload.actorClientId && payload.actorClientId === ownerClientId) return null;
  store.notifications = store.notifications || [];
  const key = payload.dedupeKey || '';
  if (key && store.notifications.some((n) => n.dedupeKey === key && !n.read)) return null;
  const item = {
    id: rid(8),
    ownerClientId,
    type: payload.type || 'system',
    title: clean(payload.title, 60) || '树洞有新动静',
    text: clean(payload.text, 120),
    postId: payload.postId || null,
    commentId: payload.commentId || null,
    chatId: payload.chatId || null,
    actorName: clean(payload.actorName, 20) || '匿名旅人',
    actorClientId: payload.actorClientId || null,
    dedupeKey: key,
    read: false,
    createdAt: new Date().toISOString(),
  };
  store.notifications.push(item);
  if (store.notifications.length > 500) store.notifications = store.notifications.slice(-500);
  scheduleSave();
  broadcastEvent('notification', { action: 'new', id: item.id, type: item.type }, [ownerClientId]);
  return item;
}

function publicNotification(n) {
  return {
    id: n.id, type: n.type, title: n.title, text: n.text,
    postId: n.postId || null, commentId: n.commentId || null, chatId: n.chatId || null,
    actorName: n.actorName, read: Boolean(n.read), createdAt: n.createdAt,
  };
}

function unreadNotificationCount(clientId) {
  if (!clientId) return 0;
  return (store.notifications || []).filter((n) => n.ownerClientId === clientId && !n.read).length;
}

function markNotificationsRead(clientId, ids) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  let changed = 0;
  for (const n of store.notifications || []) {
    if (n.ownerClientId !== clientId || n.read) continue;
    if (wanted && !wanted.has(n.id)) continue;
    n.read = true;
    n.readAt = new Date().toISOString();
    changed += 1;
  }
  if (changed) scheduleSave();
  return changed;
}

function imageRecord(name) {
  return (store.images || []).find((x) => x.name === name) || null;
}

function imageReviewStatus(name) {
  const rec = imageRecord(name);
  if (!rec) return 'approved';
  return rec.status || 'approved';
}

function imageUsableBy(name, clientId) {
  if (!imageExists(name)) return false;
  const rec = imageRecord(name);
  if (!rec) return true;
  if (rec.ownerClientId && rec.ownerClientId === clientId) return true;
  return imageReviewStatus(name) === 'approved';
}

function imagePendingFor(name, clientId) {
  const rec = imageRecord(name);
  if (!rec || rec.status !== 'pending') return false;
  return !(rec.ownerClientId && rec.ownerClientId === clientId);
}

function registerImage(name, clientId) {
  store.images = store.images || [];
  const status = IMAGE_REVIEW ? 'pending' : 'approved';
  store.images.push({
    id: rid(8), name, ownerClientId: clientId || null, status,
    reports: [], createdAt: new Date().toISOString(), reviewedAt: IMAGE_REVIEW ? null : new Date().toISOString(),
  });
  if (store.images.length > 20000) store.images = store.images.slice(-20000);
  scheduleSave();
  return status;
}

function imageReferenceIndex() {
  const index = new Map();
  const add = (name, at) => {
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(at);
  };
  const walk = (value, at) => {
    if (typeof value === 'string') {
      if (validImageName(value)) add(value, at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, at + '[' + i + ']'));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // Skip upload records and audit logs; only scan actual content references.
      if (at === 'store' && (key === 'images' || key === 'adminLogs')) continue;
      walk(child, at + '.' + key);
    }
  };
  walk(store, 'store');
  return index;
}

function imageCleanupRetentionDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return IMAGE_RETENTION_DAYS;
  return Math.min(3650, n);
}

function imageCleanupScan(retentionDays = IMAGE_RETENTION_DAYS, now = Date.now()) {
  const days = imageCleanupRetentionDays(retentionDays);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const references = imageReferenceIndex();
  const files = [];
  try {
    for (const item of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
      if (item.isFile() && validImageName(item.name)) files.push(item.name);
    }
  } catch {}
  const fileSet = new Set(files);
  const records = store.images || [];
  const candidates = [];
  const protectedImages = [];
  let referencedFiles = 0;
  let pendingFiles = 0;
  let youngFiles = 0;

  for (const name of files.sort()) {
    const rec = imageRecord(name);
    let stat = null;
    try { stat = fs.statSync(imagePath(name)); } catch {}
    const recordTime = rec && Date.parse(rec.createdAt || rec.reviewedAt || '');
    const createdMs = Number.isFinite(recordTime) ? recordTime : (stat ? stat.mtimeMs : now);
    const refs = references.get(name) || [];
    const pending = Boolean(rec && rec.status === 'pending');
    let reason = 'unreferenced';
    if (pending) { reason = 'pending_review'; pendingFiles += 1; }
    else if (refs.length) { reason = 'referenced'; referencedFiles += 1; }
    else if (createdMs > cutoff) { reason = 'retention'; youngFiles += 1; }
    const item = {
      name,
      bytes: stat ? stat.size : 0,
      createdAt: new Date(createdMs).toISOString(),
      ageDays: Math.max(0, Math.round((now - createdMs) / 86400000 * 10) / 10),
      status: rec ? (rec.status || 'approved') : 'untracked',
      referenceCount: refs.length,
      reason,
    };
    if (reason === 'unreferenced') candidates.push(item);
    else protectedImages.push(item);
  }

  const missingFiles = records
    .filter((rec) => rec && validImageName(rec.name) && !fileSet.has(rec.name))
    .map((rec) => ({ name: rec.name, status: rec.status || 'approved', createdAt: rec.createdAt || null }));
  const candidateBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
  return {
    generatedAt: new Date(now).toISOString(),
    retentionDays: days,
    cutoff: new Date(cutoff).toISOString(),
    summary: {
      totalFiles: files.length,
      referencedFiles,
      pendingFiles,
      youngFiles,
      candidateFiles: candidates.length,
      candidateBytes,
      missingFiles: missingFiles.length,
    },
    candidates: candidates.slice(0, 200),
    protected: protectedImages.slice(0, 100),
    missing: missingFiles.slice(0, 100),
    truncated: candidates.length > 200 || protectedImages.length > 100 || missingFiles.length > 100,
  };
}

function cleanupUnusedImages(retentionDays = IMAGE_RETENTION_DAYS) {
  const report = imageCleanupScan(retentionDays);
  const deleted = [];
  const failed = [];
  let freedBytes = 0;
  for (const item of report.candidates) {
    try {
      fs.rmSync(imagePath(item.name), { force: true });
      deleted.push(item.name);
      freedBytes += item.bytes;
    } catch (err) {
      failed.push({ name: item.name, error: err && err.message ? err.message : String(err) });
    }
  }
  if (deleted.length) {
    const removed = new Set(deleted);
    store.images = (store.images || []).filter((rec) => !removed.has(rec.name));
    scheduleSave();
  }
  return { ...report, deleted, failed, freedBytes };
}

function safeTokenEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function adminAllowed(req) {
  const header = String(req.headers['x-admin-token'] || '');
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = header || auth;
  if (ADMIN_TOKEN && safeTokenEqual(token, ADMIN_TOKEN)) return 'owner';
  if (ADMIN_MODERATOR_TOKEN && safeTokenEqual(token, ADMIN_MODERATOR_TOKEN)) return 'moderator';
  if (ADMIN_READONLY_TOKEN && safeTokenEqual(token, ADMIN_READONLY_TOKEN)) return 'readonly';
  return null;
}

function adminActor(req, role) {
  return { role, ip: req.__requestIp || null, requestId: req.__requestId || null };
}

function canAdminWrite(role, area) {
  if (role === 'owner') return true;
  if (role === 'moderator') return !['backup', 'logs'].includes(area);
  return false;
}

// 统一举报：举报人可以匿名，但管理员必须能看到稳定、可审计的目标快照。
function normalizeReportReason(value) {
  return REPORT_REASONS.some((r) => r.id === value) ? value : 'other';
}

function reportTargetId(targetType, targetId) {
  return String(targetType || '') + ':' + String(targetId || '');
}

function recordReport(input) {
  const targetType = ['post', 'comment', 'chat', 'chat_message'].includes(input.targetType) ? input.targetType : 'post';
  const targetId = clean(String(input.targetId || ''), 96);
  if (!targetId) throw new Error('举报目标缺失');
  const reporterClientId = clean(String(input.reporterClientId || 'anonymous'), 80) || 'anonymous';
  const reason = normalizeReportReason(input.reason);
  const note = clean(input.note, 120);
  const existing = (store.reports || []).find((r) =>
    r.status !== 'resolved' &&
    (r.targetType || 'post') === targetType &&
    String(r.targetId || r.postId || r.chatId || '') === targetId &&
    r.reporterClientId === reporterClientId
  );
  if (existing) return { report: existing, created: false };

  const snapshot = input.snapshot && typeof input.snapshot === 'object' ? {
    text: clean(input.snapshot.text, 160),
    peerName: clean(input.snapshot.peerName, 24),
    messageId: clean(input.snapshot.messageId, 32),
    hasImage: Boolean(input.snapshot.hasImage),
    createdAt: input.snapshot.createdAt || null,
  } : {};
  const report = {
    id: rid(8),
    targetType,
    targetId,
    postId: input.postId || null,
    commentId: input.commentId || null,
    chatId: input.chatId || null,
    messageId: input.messageId || null,
    postText: clean(input.postText || snapshot.text || '', 120),
    reporterClientId,
    reason,
    note,
    status: 'open',
    snapshot,
    createdAt: new Date().toISOString(),
    authorClientId: input.authorClientId || null,
  };
  store.reports = store.reports || [];
  store.reports.push(report);
  if (store.reports.length > 5000) store.reports = store.reports.slice(-5000);
  reportRiskEvent({
    authorClientId: input.authorClientId,
    reporterClientId,
    reason,
    text: input.snapshot && input.snapshot.text ? input.snapshot.text : (input.postText || input.note || ''),
    postText: input.postText || (input.snapshot && input.snapshot.text) || '',
    targetType,
    targetId,
    surface: input.surface || targetType,
    ip: input.ip,
  });
  return { report, created: true };
}

function fileSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function encryptBackupBuffer(buf, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { data: ciphertext, iv, tag: cipher.getAuthTag() };
}

function writeBackupEntry(targetDir, relativePath, buf, key) {
  const dest = path.join(targetDir, relativePath + (key ? '.enc' : ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!key) {
    fs.writeFileSync(dest, buf);
    return { path: relativePath, storedPath: path.relative(targetDir, dest), bytes: buf.length, sha256: fileSha256(buf), encrypted: false };
  }
  const encrypted = encryptBackupBuffer(buf, key);
  fs.writeFileSync(dest, encrypted.data);
  return {
    path: relativePath,
    storedPath: path.relative(targetDir, dest),
    bytes: buf.length,
    sha256: fileSha256(buf),
    encrypted: true,
    iv: encrypted.iv.toString('base64'),
    tag: encrypted.tag.toString('base64'),
  };
}

function backupRootDir() {
  return path.join(DATA_DIR, 'backups');
}

function resolveBackupDir(name) {
  if (typeof name !== 'string' || !/^backup-[A-Za-z0-9-]+$/.test(name)) return null;
  const root = path.resolve(backupRootDir());
  const target = path.resolve(root, name);
  return target.startsWith(root + path.sep) ? target : null;
}

function listBackups() {
  const root = backupRootDir();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith('backup-') && !item.name.includes('.tmp-'))
    .map((item) => {
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(root, item.name, 'manifest.json'), 'utf8')); } catch {}
      return {
        name: item.name,
        createdAt: manifest && manifest.createdAt ? manifest.createdAt : null,
        encrypted: Boolean(manifest && manifest.encrypted),
        files: manifest && Array.isArray(manifest.entries) ? manifest.entries.length : 0,
        complete: fs.existsSync(path.join(root, item.name, '.complete')),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function verifyBackup(name) {
  const dir = resolveBackupDir(name);
  if (!dir || !fs.existsSync(dir)) return { ok: false, name, error: '备份不存在。' };
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(path.join(dir, '.complete'))) return { ok: false, name, error: '备份未完成。' };
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { return { ok: false, name, error: '备份清单无法读取。' }; }
  if (!manifest || !Array.isArray(manifest.entries)) return { ok: false, name, error: '备份清单格式错误。' };
  let key = null;
  if (manifest.encrypted) {
    if (!BACKUP_ENCRYPTION_KEY) return { ok: false, name, error: '备份已加密，但未配置 BACKUP_ENCRYPTION_KEY。' };
    if (!manifest.salt) return { ok: false, name, error: '加密备份缺少盐值。' };
    try { key = crypto.scryptSync(BACKUP_ENCRYPTION_KEY, Buffer.from(manifest.salt, 'base64'), 32); }
    catch { return { ok: false, name, error: '备份密钥无法读取。' }; }
  }
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.storedPath !== 'string') return { ok: false, name, error: '备份条目格式错误。' };
    const storedPath = path.resolve(dir, entry.storedPath);
    if (!storedPath.startsWith(path.resolve(dir) + path.sep)) return { ok: false, name, error: '备份条目路径越界。' };
    if (!fs.existsSync(storedPath)) return { ok: false, name, error: '备份文件缺失：' + entry.path };
    try {
      let data = fs.readFileSync(storedPath);
      if (entry.encrypted) {
        if (!key) return { ok: false, name, error: '备份条目密钥缺失。' };
        if (!entry.iv || !entry.tag) return { ok: false, name, error: '备份条目加密信息缺失。' };
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
        data = Buffer.concat([decipher.update(data), decipher.final()]);
      }
      if (entry.bytes !== data.length) return { ok: false, name, error: '备份文件大小不一致：' + entry.path };
      if (entry.sha256 !== fileSha256(data)) return { ok: false, name, error: '备份文件校验失败：' + entry.path };
    } catch (err) {
      return { ok: false, name, error: '备份文件无法解码：' + entry.path };
    }
  }
  return { ok: true, name, encrypted: Boolean(manifest.encrypted), files: manifest.entries.length, verifiedAt: new Date().toISOString() };
}

function createBackup() {
  ensureDirs();
  flush();
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = 'backup-' + stamp;
  const target = path.join(dir, name);
  const staging = target + '.tmp-' + rid(4);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const usingKey = Boolean(BACKUP_ENCRYPTION_KEY);
  const salt = usingKey ? crypto.randomBytes(16) : null;
  const key = usingKey ? crypto.scryptSync(BACKUP_ENCRYPTION_KEY, salt, 32) : null;
  const manifest = {
    version: 2,
    encrypted: usingKey,
    cipher: usingKey ? 'aes-256-gcm' : null,
    salt: salt ? salt.toString('base64') : null,
    createdAt: new Date().toISOString(),
    entries: [],
  };

  try {
    if (fs.existsSync(STORE_FILE)) {
      const entry = writeBackupEntry(staging, 'store.json', fs.readFileSync(STORE_FILE), key);
      manifest.entries.push(entry);
    }
    if (fs.existsSync(UPLOAD_DIR)) {
      for (const item of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
        if (!item.isFile()) continue;
        const source = path.join(UPLOAD_DIR, item.name);
        const entry = writeBackupEntry(staging, path.posix.join('uploads', item.name), fs.readFileSync(source), key);
        manifest.entries.push(entry);
      }
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(staging, '.complete'), new Date().toISOString(), 'utf8');
    fs.renameSync(staging, target);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  const entries = fs.readdirSync(dir)
    .filter((n) => n.startsWith('backup-') && !n.includes('.tmp-'))
    .sort();
  while (entries.length > BACKUP_KEEP) fs.rmSync(path.join(dir, entries.shift()), { recursive: true, force: true });
  return {
    name,
    dir: target,
    at: manifest.createdAt,
    encrypted: usingKey,
    cipher: manifest.cipher,
    files: manifest.entries.length,
  };
}

function adminLog(action, detail, actor) {
  store.adminLogs = store.adminLogs || [];
  store.adminLogs.push({
    id: rid(6), action, detail: clean(detail, 200),
    actorRole: actor && actor.role ? actor.role : 'system',
    actorIp: actor && actor.ip ? actor.ip : null,
    requestId: actor && actor.requestId ? actor.requestId : null,
    at: new Date().toISOString(),
  });
  if (store.adminLogs.length > 1000) store.adminLogs = store.adminLogs.slice(-1000);
  scheduleSave();
}

/* --------------------------------- 限流 ----------------------------------- */

const buckets = new Map();

function rateLimit(ip, key, max) {
  const now = Date.now();
  const id = ip + '|' + key;
  let b = buckets.get(id);
  if (!b || now - b.start > 60_000) {
    b = { start: now, count: 0 };
    buckets.set(id, b);
  }
  b.count += 1;
  return b.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now - v.start > 120_000) buckets.delete(k);
}, 120_000).unref();

/* ------------------------------ 实时事件 SSE ------------------------------- */

const sseClients = new Set();
let sseSeq = 0;
let sseLog = [];

function sendSseEvent(client, event, payload, eventId) {
  if (!client || client.res.destroyed || client.res.writableEnded) return;
  try {
    if (eventId) client.res.write('id: ' + eventId + '\n');
    client.res.write('event: ' + event + '\n');
    client.res.write('data: ' + JSON.stringify(payload || {}) + '\n\n');
  } catch {
    closeSseClient(client);
  }
}

function broadcastEvent(event, payload, clientIds) {
  const allowed = clientIds ? new Set(clientIds) : null;
  const id = ++sseSeq;
  sseLog.push({ id, event, payload: payload || {}, clientIds: clientIds ? Array.from(allowed) : null, at: Date.now() });
  if (sseLog.length > 200) sseLog = sseLog.slice(-200);
  for (const client of sseClients) {
    if (!allowed || allowed.has(client.clientId)) sendSseEvent(client, event, payload, id);
  }
  for (const client of wsClients) {
    if (!allowed || allowed.has(client.clientId)) wsSendEvent(client, event, payload, id);
  }
}

function closeSseClient(client) {
  if (!client) return;
  if (client.heartbeat) clearInterval(client.heartbeat);
  sseClients.delete(client);
  try {
    if (!client.res.writableEnded) client.res.end();
  } catch { /* 已断开 */ }
}

function openSse(req, res, clientId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket) {
    res.socket.setKeepAlive(true);
    res.socket.setNoDelay(true);
  }
  // Force proxies such as Cloudflare Quick Tunnel to release the first SSE bytes.
  res.write(':' + ' '.repeat(4096) + '\n\n');

  const client = { res, clientId, heartbeat: null };
  sseClients.add(client);
  res.write('retry: 3000\n\n');
  sendSseEvent(client, 'ready', { connected: true, serverTime: Date.now() });
  const lastEventId = Number(req.headers['last-event-id'] || 0) || 0;
  if (lastEventId) {
    for (const item of sseLog) {
      if (item.id <= lastEventId) continue;
      if (item.clientIds && !item.clientIds.includes(clientId)) continue;
      sendSseEvent(client, item.event, item.payload, item.id);
    }
  }

  client.heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return closeSseClient(client);
    try { res.write(': heartbeat\n\n'); } catch { closeSseClient(client); }
  }, 20_000);
  client.heartbeat.unref?.();

  const cleanup = () => closeSseClient(client);
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

/* --------------------------- 实时事件 WebSocket ---------------------------- */
// 可选的双向实时通道：优先 WebSocket，不可用时前端自动退回 SSE。
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

function wsFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? '' : payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, body]);
}

function wsSendText(client, text) {
  if (!client || !client.socket || client.socket.destroyed || !client.socket.writable) return false;
  try { client.socket.write(wsFrame(0x1, text)); return true; }
  catch { closeWsClient(client); return false; }
}

function wsSendEvent(client, event, payload, eventId) {
  return wsSendText(client, JSON.stringify({ event, data: payload || {}, id: eventId || null }));
}

function closeWsClient(client) {
  if (!client) return;
  if (client.heartbeat) clearInterval(client.heartbeat);
  wsClients.delete(client);
  try { if (client.socket && !client.socket.destroyed) client.socket.end(); } catch { /* 已断开 */ }
}

function openWs(socket, clientId, lastEventId, head) {
  const client = { socket, clientId, heartbeat: null };
  wsClients.add(client);
  wsSendEvent(client, 'ready', { connected: true, transport: 'websocket', serverTime: Date.now() });
  if (lastEventId) {
    for (const item of sseLog) {
      if (item.id <= lastEventId) continue;
      if (item.clientIds && !item.clientIds.includes(clientId)) continue;
      wsSendEvent(client, item.event, item.payload, item.id);
    }
  }
  client.heartbeat = setInterval(() => {
    if (socket.destroyed || !socket.writable) return closeWsClient(client);
    try { socket.write(Buffer.from([0x89, 0x00])); } catch { closeWsClient(client); }
  }, 20_000);
  client.heartbeat.unref?.();

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > 2000000n) return closeWsClient(client);
        len = Number(big);
        offset = 10;
      }
      if (len > 2000000) return closeWsClient(client);
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;
      const data = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(offset + maskLen + len);
      if (opcode === 0x8) return closeWsClient(client);
      if (opcode === 0x9) { try { socket.write(wsFrame(0xA, data)); } catch { closeWsClient(client); } continue; }
      if (opcode === 0xA) continue;
      if (!fin) continue; // 不支持分片帧
      if (opcode !== 0x1) continue;
      let msg = null;
      try { msg = JSON.parse(data.toString('utf8')); } catch { msg = null; }
      if (msg && msg.type === 'ping') wsSendEvent(client, 'pong', { at: Date.now() });
    }
  });
  socket.on('close', () => closeWsClient(client));
  socket.on('error', () => closeWsClient(client));
}

function rejectUpgrade(socket, status, message) {
  const text = message || '';
  try {
    socket.write('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ' + Buffer.byteLength(text) + '\r\n\r\n' + text);
  } catch { /* 忽略 */ }
  socket.destroy();
}

function handleUpgrade(req, socket, head) {
  let url;
  try { url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost')); }
  catch { return rejectUpgrade(socket, '400 Bad Request', 'Bad Request'); }
  if (url.pathname !== '/api/events') return rejectUpgrade(socket, '404 Not Found', 'Not Found');
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) return rejectUpgrade(socket, '400 Bad Request', 'Bad Request');
  const clientId = viewerClientId(req, url.searchParams.get('clientId'));
  if (!validClientId(clientId)) return rejectUpgrade(socket, '400 Bad Request', 'clientId required');
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAcceptKey(key) + '\r\n\r\n'
    );
  } catch { socket.destroy(); return; }
  if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true);
  if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  const lastEventId = Number(url.searchParams.get('lastEventId') || 0) || 0;
  openWs(socket, clientId, lastEventId, head);
}
/* -------------------------------- HTTP 辅助 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendDownload(res, filename, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function readBinary(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('图片太大了'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function canCompress(contentType) {
  return /^(text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/i.test(contentType || '');
}

function serveStatic(req, res, pathname, url) {
  const rel = pathname === '/' ? 'index.html'
    : (pathname === '/admin' || pathname === '/admin/') ? 'admin.html'
    : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  const publicRoot = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (file !== PUBLIC_DIR && !file.startsWith(publicRoot)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const mtime = fs.statSync(file).mtime;
    const accepts = String(req.headers['accept-encoding'] || '');
    let encoding = null;
    let body = data;
    if (canCompress(contentType) && data.length >= 1024) {
      if (/\bbr\b/i.test(accepts)) {
        body = zlib.brotliCompressSync(data);
        encoding = 'br';
      } else if (/\bgzip\b/i.test(accepts)) {
        body = zlib.gzipSync(data, { level: 6 });
        encoding = 'gzip';
      }
    }
    const digest = crypto.createHash('sha256').update(data).digest('base64url').slice(0, 22);
    const etag = '"' + digest + (encoding ? '-' + encoding : '') + '"';
    const requestTags = String(req.headers['if-none-match'] || '');
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : (url && url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, must-revalidate'),
      'ETag': etag,
      'Last-Modified': mtime.toUTCString(),
      'Vary': 'Accept-Encoding',
      'Content-Length': body.length,
    };
    if (encoding) headers['Content-Encoding'] = encoding;
    if (requestTags.split(',').map((x) => x.trim()).includes(etag)) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    if ((req.method || 'GET') === 'HEAD') return res.end();
    res.end(body);
  });
}

/* -------------------------------- 账号会话 -------------------------------- */

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function authSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = sha256(token);
  const sessions = store.sessions || (store.sessions = []);
  const idx = sessions.findIndex((x) => x.tokenHash === tokenHash);
  if (idx < 0) return null;
  const session = sessions[idx];
  if (Number(session.expiresAt) <= Date.now()) {
    sessions.splice(idx, 1);
    scheduleSave();
    return null;
  }
  const user = (store.users || []).find((u) => u.id === session.userId);
  if (!user) {
    sessions.splice(idx, 1);
    scheduleSave();
    return null;
  }
  const seen = Date.parse(session.lastSeenAt || '') || 0;
  if (Date.now() - seen > 5 * 60 * 1000) {
    session.lastSeenAt = new Date().toISOString();
    scheduleSave();
  }
  return { user, session };
}

function currentUser(req) {
  const auth = authSession(req);
  return auth ? auth.user : null;
}

// 登录后服务端以 cookie 对应用户为准，前端传来的 clientId 只作为匿名访客兜底。
function viewerClientId(req, fallback) {
  const user = currentUser(req);
  if (user && validClientId(user.clientId)) return user.clientId;
  return validClientId(fallback) ? fallback : '';
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    clientId: user.clientId,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    timeZone: validTimeZone(user.timeZone) ? user.timeZone : null,
    notificationEnabled: Boolean(user.notificationEnabled),
    onboardingSeen: user.onboardingSeen !== false,
  };
}

function publicSession(session, currentId) {
  return {
    id: session.id,
    current: session.id === currentId,
    device: session.device || 'desktop',
    ip: session.ip || null,
    userAgent: session.userAgent || '未知设备',
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt || session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return 'scrypt$' + N + '$' + r + '$' + p + '$' + salt + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    const salt = parts[4];
    const expected = Buffer.from(parts[5], 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function makeRecoveryCode() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return 'TH-' + raw.match(/.{1,4}/g).join('-');
}

function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^TH/, '');
}

function validUsername(username) {
  return typeof username === 'string' && /^[\p{L}\p{N}_]{3,20}$/u.test(username);
}

function setSessionCookie(req, res, token, maxAgeSeconds = AUTH_LIMITS.sessionDays * 86400) {
  const forwardedSecure = TRUSTED_PROXY && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  const secure = (ENABLE_HSTS || PUBLIC_ORIGIN.startsWith('https://') || forwardedSecure) ? '; Secure' : '';
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + secure);
}

function clearSessionCookie(req, res) {
  setSessionCookie(req, res, '', 0);
}

function createSession(userId, req, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  store.sessions = (store.sessions || []).filter((x) => Number(x.expiresAt) > now);
  const ua = clean(String(req && req.headers['user-agent'] || ''), 180);
  store.sessions.push({
    id: rid(8),
    tokenHash: sha256(token),
    userId,
    ip: ip || 'unknown',
    userAgent: ua,
    device: /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop',
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: now + AUTH_LIMITS.sessionDays * 86400000,
  });
  const mine = store.sessions.filter((x) => x.userId === userId);
  if (mine.length > 12) {
    const remove = new Set(mine.slice(0, mine.length - 12).map((x) => x.id));
    store.sessions = store.sessions.filter((x) => !remove.has(x.id));
  }
  scheduleSave();
  return token;
}

/* -------------------------------- 宠物系统 -------------------------------- */

function findPetByUser(userId) {
  return (store.pets || []).find((p) => p.userId === userId) || null;
}

function speciesOf(id) {
  return PET_SPECIES.find((x) => x.id === id) || PET_SPECIES[0];
}

function clampPercent(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function petExpNeeded(level) {
  return 40 + Math.max(1, Number(level) || 1) * 14;
}

function applyPetDecay(pet) {
  const now = Date.now();
  const last = Date.parse(pet.lastDecayAt || pet.createdAt || '') || now;
  const hours = Math.max(0, (now - last) / 3600000);
  if (hours < 0.25) return false;
  const oldFullness = Number(pet.fullness);
  const oldMood = Number(pet.mood);
  pet.fullness = clampPercent((Number.isFinite(oldFullness) ? oldFullness : 72) - hours * 1.15);
  pet.mood = clampPercent((Number.isFinite(oldMood) ? oldMood : 78) - hours * 0.8);
  pet.lastDecayAt = new Date(now).toISOString();
  return pet.fullness !== oldFullness || pet.mood !== oldMood;
}

function petCooldowns(pet) {
  const now = Date.now();
  const lastActions = pet.lastActions || {};
  const out = {};
  for (const [id, action] of Object.entries(PET_ACTIONS)) {
    const last = Date.parse(lastActions[id] || '') || 0;
    out[id] = Math.max(0, action.cooldownMs - (now - last));
  }
  return out;
}

function petMoodLabel(pet) {
  if (pet.mood >= 85) return '开心得发光';
  if (pet.mood >= 65) return '安静又满足';
  if (pet.mood >= 40) return '在等你回来';
  if (pet.mood >= 20) return '有点没精神';
  return '很想被你陪一会儿';
}

const PET_STREAK_REWARDS = [
  { days: 3, exp: 12, mood: 6, label: '嫩叶徽记' },
  { days: 7, exp: 28, mood: 10, label: '星光徽记' },
  { days: 14, exp: 60, mood: 16, label: '月桂徽记' },
  { days: 30, exp: 120, mood: 24, label: '花环徽记' },
  { days: 60, exp: 240, mood: 30, label: '永恒徽记' },
];

function petGrowthStage(level) {
  const value = Math.max(1, Math.min(50, Number(level) || 1));
  return PET_GROWTH_STAGES.find((stage) => value >= stage.minLevel && value <= stage.maxLevel) || PET_GROWTH_STAGES[PET_GROWTH_STAGES.length - 1];
}

function petDecoration(id) {
  return PET_DECORATIONS.find((item) => item.id === id) || PET_DECORATIONS[0];
}

function unlockedPetDecorations(pet) {
  const level = Math.max(1, Number(pet.level) || 1);
  const selected = petDecoration(pet.decorationId).id;
  return PET_DECORATIONS.map((item) => ({
    ...item,
    unlocked: level >= item.minLevel,
    selected: item.id === selected,
  }));
}

function petGentleLine(pet) {
  const mood = Number(pet.mood) || 0;
  if (mood >= 85) return '今天的光很软，我想再多陪你一会儿。';
  if (mood >= 65) return '你回来以后，连空气都安静下来了。';
  if (mood >= 40) return '我在这里，你慢慢来也没关系。';
  if (mood >= 20) return '今天不用逞强，靠着我坐一会儿吧。';
  return '哪怕什么都不做，我也愿意陪你把这阵风等过去。';
}

function ensurePetDaily(pet, day) {
  if (!pet.daily || pet.daily.day !== day) {
    pet.daily = { day, actions: { feed: false, pat: false, play: false }, completedBonus: false };
  }
  pet.daily.actions = pet.daily.actions || {};
  for (const id of Object.keys(PET_ACTIONS)) pet.daily.actions[id] = Boolean(pet.daily.actions[id]);
  return pet.daily;
}

function petDailyState(pet) {
  const day = todayKey();
  const daily = ensurePetDaily(pet, day);
  const actions = Object.entries(PET_ACTIONS).map(([id, action]) => ({
    id,
    label: action.label,
    emoji: action.emoji,
    completed: Boolean(daily.actions[id]),
    rewardExp: { feed: 5, pat: 3, play: 9 }[id] || 2,
  }));
  const completedCount = actions.filter((item) => item.completed).length;
  return {
    day,
    actions,
    completedCount,
    total: actions.length,
    completed: completedCount === actions.length,
    bonusExp: 12,
  };
}

function petWeekendEvent(date = new Date()) {
  const active = date.getDay() === 0 || date.getDay() === 6;
  return {
    id: 'weekend-picnic',
    active,
    title: '周末星光野餐',
    emoji: active ? '🧺' : '📅',
    description: active ? '今天互动会获得额外默契，还会触发周末专属台词。' : '周六、周日开启，一起收集周末的星光。',
    bonusExp: active ? 8 : 0,
  };
}

function nextPetStreakReward(streak) {
  const value = Number(streak) || 0;
  const next = PET_STREAK_REWARDS.find((item) => item.days > value) || PET_STREAK_REWARDS[PET_STREAK_REWARDS.length - 1];
  return { ...next, remainingDays: Math.max(0, next.days - value), allClaimed: value >= next.days };
}

function publicPet(pet) {
  if (applyPetDecay(pet)) scheduleSave();
  const species = speciesOf(pet.species);
  const level = Math.max(1, Math.min(50, Number(pet.level) || 1));
  const stage = petGrowthStage(level);
  const stageIndex = PET_GROWTH_STAGES.findIndex((item) => item.id === stage.id);
  const nextStage = PET_GROWTH_STAGES[stageIndex + 1] || null;
  const stageSpan = Math.max(1, stage.maxLevel - stage.minLevel);
  const progress = level >= 50 ? 100 : Math.round(((level - stage.minLevel) / stageSpan) * 100);
  const selectedDecoration = petDecoration(pet.decorationId);
  const wearDecoration = level >= selectedDecoration.minLevel ? selectedDecoration.id : 'default';
  const daily = petDailyState(pet);
  const weekendEvent = petWeekendEvent();
  return {
    id: pet.id,
    name: pet.name,
    species: { id: species.id, label: species.label, emoji: species.emoji, hint: species.hint },
    level,
    exp: Math.max(0, Number(pet.exp) || 0),
    expNeeded: petExpNeeded(level),
    fullness: clampPercent(Number(pet.fullness) || 0),
    mood: clampPercent(Number(pet.mood) || 0),
    moodLabel: petMoodLabel(pet),
    gentleLine: petGentleLine(pet),
    streak: pet.streak || 0,
    totalInteractions: pet.totalInteractions || 0,
    lastActiveDay: pet.lastActiveDay || null,
    cooldowns: petCooldowns(pet),
    growth: {
      id: stage.id,
      label: stage.label,
      emoji: stage.emoji,
      description: stage.description,
      progress,
      nextLabel: nextStage ? nextStage.label : null,
      nextLevel: nextStage ? nextStage.minLevel : null,
    },
    daily,
    weekendEvent,
    decorationId: wearDecoration,
    decorations: unlockedPetDecorations(pet),
    nextStreakReward: nextPetStreakReward(pet.streak),
    createdAt: pet.createdAt,
    updatedAt: pet.updatedAt || pet.createdAt,
  };
}

function dayBefore(day) {
  const d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE');
}

function gainPetExp(pet, amount) {
  let levelUp = false;
  pet.exp = Math.max(0, Number(pet.exp) || 0) + amount;
  while (pet.level < 50 && pet.exp >= petExpNeeded(pet.level)) {
    pet.exp -= petExpNeeded(pet.level);
    pet.level += 1;
    levelUp = true;
  }
  if (pet.level >= 50) pet.exp = Math.min(pet.exp, petExpNeeded(50));
  return levelUp;
}

function applyPetAction(pet, actionId) {
  const action = PET_ACTIONS[actionId];
  const now = Date.now();
  const day = todayKey();
  let firstVisitBonus = 0;
  if (pet.lastActiveDay !== day) {
    pet.streak = pet.lastActiveDay === dayBefore(day) ? (Number(pet.streak) || 0) + 1 : 1;
    pet.lastActiveDay = day;
    firstVisitBonus = 5;
  }

  const daily = ensurePetDaily(pet, day);
  const taskAlreadyDone = Boolean(daily.actions[actionId]);
  if (actionId === 'feed') {
    pet.fullness = clampPercent((Number(pet.fullness) || 0) + 26);
    pet.mood = clampPercent((Number(pet.mood) || 0) + 5);
  } else if (actionId === 'pat') {
    pet.mood = clampPercent((Number(pet.mood) || 0) + 12);
  } else if (actionId === 'play') {
    pet.mood = clampPercent((Number(pet.mood) || 0) + 18);
    pet.fullness = clampPercent((Number(pet.fullness) || 0) - 8);
  }
  daily.actions[actionId] = true;

  const weekendEvent = petWeekendEvent();
  let expGain = ({ feed: 5, pat: 3, play: 9 }[actionId] || 2) + firstVisitBonus + weekendEvent.bonusExp;
  let dailyCompletedNow = false;
  let streakReward = null;
  if (!daily.completedBonus && Object.values(daily.actions).every(Boolean)) {
    daily.completedBonus = true;
    dailyCompletedNow = true;
    expGain += 12;
    pet.mood = clampPercent((Number(pet.mood) || 0) + 8);
    pet.fullness = clampPercent((Number(pet.fullness) || 0) + 4);
    const reward = PET_STREAK_REWARDS.find((item) => item.days === Number(pet.streak));
    pet.streakRewards = pet.streakRewards || {};
    if (reward && !pet.streakRewards[String(reward.days)]) {
      pet.streakRewards[String(reward.days)] = day;
      expGain += reward.exp;
      pet.mood = clampPercent((Number(pet.mood) || 0) + reward.mood);
      streakReward = reward;
    }
  }

  const levelUp = gainPetExp(pet, expGain);
  pet.lastActions = pet.lastActions || {};
  pet.lastActions[actionId] = new Date(now).toISOString();
  pet.totalInteractions = (Number(pet.totalInteractions) || 0) + 1;
  pet.updatedAt = new Date(now).toISOString();

  let message = action.emoji + ' ' + action.label + '完成';
  if (actionId === 'feed') message = '它吃得很认真，还把碗舔干净了。';
  if (actionId === 'pat') message = '它眯起眼睛，往你手心里蹭了蹭。';
  if (actionId === 'play') message = '你们在柔和的光里玩了一会儿，它看起来松快多了。';
  if (firstVisitBonus) message += ' 今天第一次见面，默契 +' + firstVisitBonus + '。';
  if (dailyCompletedNow) message += ' 今日三件小事都完成了，额外默契 +12。';
  if (streakReward) message += ' 连续照顾 ' + streakReward.days + ' 天，获得「' + streakReward.label + '」。';
  if (weekendEvent.active) message += ' 周末事件生效，额外默契 +' + weekendEvent.bonusExp + '。';
  if (levelUp) message += ' 升到 ' + pet.level + ' 级了！';
  return { message, levelUp, firstVisitBonus, dailyBonus: firstVisitBonus, taskCompleted: !taskAlreadyDone, dailyCompleted: daily.completedBonus, dailyCompletedNow, streakReward, weekendEvent };
}

/* --------------------------------- 路由 ----------------------------------- */
let requestSeq = 0;

function clientIp(req) {
  if (TRUSTED_PROXY) {
    if ((TRUSTED_PROXY === 'cloudflare' || TRUSTED_PROXY === 'all') && req.headers['cf-connecting-ip']) {
      return String(req.headers['cf-connecting-ip']).trim() || 'local';
    }
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'local';
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host || '').toLowerCase();
    if (host && parsed.host.toLowerCase() === host) return true;
    if (PUBLIC_ORIGIN && origin.replace(/\/$/, '') === PUBLIC_ORIGIN) return true;
    const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
    return extra.includes(origin);
  } catch { return false; }
}

const logCounter = { total: 0, errors: 0, lastError: null };
function logEvent(level, event, payload) {
  const row = Object.assign({ ts: new Date().toISOString(), level, event }, payload || {});
  const line = JSON.stringify(row);
  if (level === 'error') { logCounter.errors += 1; logCounter.lastError = row; console.error(line); }
  else if (level === 'warn') console.warn(line);
  else if (/^(1|true|on|yes)$/i.test(String(process.env.STRUCTURED_LOGS || '1'))) console.log(line);
}

function notifyAlert(kind, detail) {
  if (!ALERT_WEBHOOK_URL || typeof fetch !== 'function') return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  fetch(ALERT_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'treehole', kind, detail, at: new Date().toISOString() }),
    signal: controller.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

const loginFailures = new Map();
function loginLockState(usernameKey, ip) {
  const key = (usernameKey || '') + '|' + (ip || '');
  const now = Date.now();
  const state = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  if (state.lockedUntil && state.lockedUntil <= now) { state.count = 0; state.lockedUntil = 0; }
  return { key, state, now };
}
function recordLoginFailure(usernameKey, ip) {
  const { key, state, now } = loginLockState(usernameKey, ip);
  state.count += 1;
  if (state.count >= LOGIN_LOCK_AFTER) {
    const steps = Math.min(6, state.count - LOGIN_LOCK_AFTER + 1);
    state.lockedUntil = now + LOGIN_LOCK_BASE_MS * Math.pow(2, steps - 1);
  }
  loginFailures.set(key, state);
  return Math.max(0, state.lockedUntil - now);
}
function clearLoginFailures(usernameKey, ip) { loginFailures.delete((usernameKey || '') + '|' + (ip || '')); }

function isPublicApiRequest(pathname, method) {
  if (pathname === '/api/health' && method === 'GET') return true;
  if (pathname === '/api/config' && method === 'GET') return true;
  if (pathname === '/api/auth/me' && method === 'GET') return true;
  if (pathname === '/api/auth/register' && method === 'POST') return true;
  if (pathname === '/api/auth/login' && method === 'POST') return true;
  if (pathname === '/api/auth/logout' && method === 'POST') return true;
  if (pathname === '/api/auth/recover' && method === 'POST') return true;
  if (pathname.startsWith('/api/images/') && method === 'GET') return true;
  return false;
}
const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const ip = clientIp(req);
  const requestId = rid(6);
  const startedAt = Date.now();
  req.__requestIp = ip;
  req.__requestId = requestId;
  res.__requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (ENABLE_HSTS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.on('finish', () => {
    logCounter.total += 1;
    if (pathname.startsWith('/api/')) logEvent(res.statusCode >= 500 ? 'error' : 'info', 'http_request', { requestId, method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - startedAt, ip });
  });

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname, url);

  try {
    const method = req.method || 'GET';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !requestOriginAllowed(req)) {
      return sendJson(res, 403, { error: '请求来源校验失败，请刷新页面后重试。', requestId });
    }
    if (REQUIRE_LOGIN && method !== 'OPTIONS' && !pathname.startsWith('/api/admin/') && !isPublicApiRequest(pathname, method) && !currentUser(req)) {
      return sendJson(res, 401, { error: '请先登录后再使用树洞。', code: 'AUTH_REQUIRED', requestId });
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET,HEAD,POST,PATCH,DELETE,OPTIONS', 'Cache-Control': 'no-store' });
      return res.end();
    }

    // 健康检查：部署、监控、Cloudflare Tunnel 都靠它判断进程是否活着
    if (pathname === '/api/health' && method === 'GET') {
      let writable = false;
      let backupReady = true;
      try {
        ensureDirs();
        fs.accessSync(DATA_DIR, fs.constants.W_OK);
        writable = true;
        const backupDir = path.join(DATA_DIR, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        fs.accessSync(backupDir, fs.constants.W_OK);
      } catch { writable = false; }
      const healthy = writable && backupReady;
      return sendJson(res, healthy ? 200 : 503, {
        ok: healthy,
        degraded: !healthy,
        version: APP_VERSION,
        uptime: Math.round(process.uptime()),
        requestId,
        imageReview: IMAGE_REVIEW,
        backupIntervalHours: BACKUP_INTERVAL_HOURS,
        backupKeep: BACKUP_KEEP,
        backupEncrypted: Boolean(BACKUP_ENCRYPTION_KEY),
        backupFormat: BACKUP_ENCRYPTION_KEY ? 'aes-256-gcm' : 'plain',
        time: Date.now(),
        checks: { dataWritable: writable, backupDirReady: backupReady },
        runtime: { totalRequests: logCounter.total, errors: logCounter.errors, lastError: logCounter.lastError },
        counts: {
          posts: (store.posts || []).length,
          users: (store.users || []).length,
          chats: (store.chats || []).length,
          moods: (store.moods || []).length,
          reports: (store.reports || []).filter((r) => r.status !== 'resolved').length,
        },
      });
    }

    // 配置
    if (pathname === '/api/config' && method === 'GET') {
      return sendJson(res, 200, {
        requireLogin: REQUIRE_LOGIN, moods: MOODS, reactions: REACTIONS, quickEmojis: QUICK_EMOJIS, moodSlots: MOOD_SLOTS,
        petSpecies: PET_SPECIES, petActions: PET_ACTIONS, limits: LIMITS, authLimits: AUTH_LIMITS,
        reportReasons: REPORT_REASONS, care: CARE, version: APP_VERSION,
        imageReview: IMAGE_REVIEW, termsVersion: TERMS_VERSION, serverTime: Date.now(),
        features: { pwa: true, notifications: true, favorites: true, chatReports: true, sessionDevices: true, requireLogin: REQUIRE_LOGIN, onboarding: true, petDailyTasks: true, petDecorations: true },
        chatSecurity: { encrypted: false, notice: '悄悄话由服务器保存并受访问控制保护，不是端到端加密。请不要发送密码、证件等敏感信息。' },
      });
    }

    // 实时事件（SSE）：只向该身份推送与其会话相关的变更

    // 登录、注册与账号资料
    if (pathname === '/api/auth/me' && method === 'GET') {
      const auth = authSession(req);
      const user = auth ? auth.user : null;
      const pet = user ? findPetByUser(user.id) : null;
      const unread = user ? unreadNotificationCount(user.clientId) : 0;
      return sendJson(res, 200, { user: user ? publicUser(user) : null, pet: pet ? publicPet(pet) : null, unreadNotifications: unread, sessionId: auth ? auth.session.id : null });
    }

    if (pathname === '/api/auth/sessions' && method === 'GET') {
      const auth = authSession(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录。' });
      const sessions = (store.sessions || []).filter((x) => x.userId === auth.user.id && Number(x.expiresAt) > Date.now())
        .sort((a, b) => new Date(b.lastSeenAt || b.createdAt) - new Date(a.lastSeenAt || a.createdAt))
        .map((x) => publicSession(x, auth.session.id));
      return sendJson(res, 200, { sessions });
    }

    const sessionRevokeMatch = pathname.match(/^\/api\/auth\/sessions\/([A-Za-z0-9]+)$/);
    if (sessionRevokeMatch && method === 'DELETE') {
      const auth = authSession(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录。' });
      const target = (store.sessions || []).find((x) => x.id === sessionRevokeMatch[1] && x.userId === auth.user.id);
      if (!target) return sendJson(res, 404, { error: '设备会话不存在。' });
      store.sessions = (store.sessions || []).filter((x) => x.id !== target.id);
      scheduleSave();
      if (target.id === auth.session.id) clearSessionCookie(req, res);
      logEvent('info', 'session_revoked', { requestId, userId: auth.user.id, sessionId: target.id });
      return sendJson(res, 200, { ok: true, current: target.id === auth.session.id });
    }

    if (pathname === '/api/auth/sessions/revoke-others' && method === 'POST') {
      const auth = authSession(req);
      if (!auth) return sendJson(res, 401, { error: '请先登录。' });
      const before = (store.sessions || []).length;
      store.sessions = (store.sessions || []).filter((x) => x.userId !== auth.user.id || x.id === auth.session.id);
      scheduleSave();
      logEvent('info', 'sessions_revoked_others', { requestId, userId: auth.user.id, removed: before - store.sessions.length });
      return sendJson(res, 200, { ok: true, removed: before - store.sessions.length });
    }

    // 注册
    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!rateLimit(ip, 'register', AUTH_LIMITS.registerPerMinute)) {
        return sendJson(res, 429, { error: '注册太频繁了，请稍后再试。' });
      }
      const body = await readBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!validUsername(username)) {
        return sendJson(res, 400, { error: '用户名需为 3-20 位中文、字母、数字或下划线。' });
      }
      const password = typeof body.password === 'string' ? body.password : '';
      const passwordLength = Array.from(password).length;
      if (passwordLength < AUTH_LIMITS.passwordMin || passwordLength > AUTH_LIMITS.passwordMax) {
        return sendJson(res, 400, { error: '密码需为 8-72 位。' });
      }
      if (body.agree !== true) {
        return sendJson(res, 400, { error: '请先阅读并同意用户协议与隐私政策。' });
      }
      const recoveryCode = makeRecoveryCode();
      const usernameKey = username.toLocaleLowerCase();
      const users = store.users || (store.users = []);
      if (users.some((u) => u.usernameKey === usernameKey || String(u.username || "").toLocaleLowerCase() === usernameKey)) {
        return sendJson(res, 409, { error: '这个用户名已经被占用了。' });
      }
      const clientId = validClientId(body.clientId) ? body.clientId : 'u-' + rid(16);
      const now = new Date().toISOString();
      const user = {
        id: rid(8),
        username,
        usernameKey,
        displayName: clean(body.displayName || username, AUTH_LIMITS.displayName) || username,
        avatar: clean(body.avatar, 4) || '??',
        passwordHash: makePasswordHash(password),
        recoveryHash: makePasswordHash(normalizeRecoveryCode(recoveryCode)),
        clientId,
        timeZone: validTimeZone(body.timeZone) ? body.timeZone : null,
        notificationEnabled: body.notificationEnabled !== false,
        termsVersion: TERMS_VERSION,
        agreedAt: now,
        createdAt: now,
        lastLoginAt: now,
        onboardingSeen: false,
      };
      users.push(user);
      if (users.length > 10000) store.users = users.slice(-10000);
      const token = createSession(user.id, req, ip);
      setSessionCookie(req, res, token);
      scheduleSave();
      return sendJson(res, 201, { user: publicUser(user), pet: null, recoveryCode, termsVersion: TERMS_VERSION });
    }

    // 登录
    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!rateLimit(ip, 'login', AUTH_LIMITS.loginPerMinute)) {
        return sendJson(res, 429, { error: '登录太频繁了，请稍后再试。' });
      }
      const body = await readBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const usernameKey = username.toLocaleLowerCase();
      const lock = loginLockState(usernameKey, ip);
      if (lock.state.lockedUntil > lock.now) {
        const retryAfterMs = lock.state.lockedUntil - lock.now;
        return sendJson(res, 429, { error: '登录失败次数过多，请在 ' + Math.ceil(retryAfterMs / 1000) + ' 秒后再试。', retryAfterMs });
      }
      const user = (store.users || []).find((u) => u.usernameKey === usernameKey || String(u.username || "").toLocaleLowerCase() === usernameKey);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        const retryAfterMs = recordLoginFailure(usernameKey, ip);
        return sendJson(res, retryAfterMs > 0 ? 429 : 401, { error: retryAfterMs > 0 ? '登录失败次数过多，请稍后再试。' : '用户名或密码不正确。', retryAfterMs });
      }
      clearLoginFailures(usernameKey, ip);
      if (!validClientId(user.clientId)) user.clientId = 'u-' + rid(16);
      if (validTimeZone(body.timeZone)) user.timeZone = body.timeZone;
      user.lastLoginAt = new Date().toISOString();
      const token = createSession(user.id, req, ip);
      setSessionCookie(req, res, token);
      scheduleSave();
      const pet = findPetByUser(user.id);
      return sendJson(res, 200, { user: publicUser(user), pet: pet ? publicPet(pet) : null });
    }

    // 退出登录
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const auth = authSession(req);
      if (auth) {
        store.sessions = (store.sessions || []).filter((x) => x.id !== auth.session.id);
        scheduleSave();
      }
      clearSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
    }

    // 修改账号资料
    if (pathname === '/api/auth/profile' && (method === 'POST' || method === 'PATCH')) {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const body = await readBody(req);
      if (body.displayName !== undefined) {
        const displayName = clean(body.displayName, AUTH_LIMITS.displayName).replace(/\s+/g, ' ');
        if (!displayName) return sendJson(res, 400, { error: '昵称不能为空。' });
        user.displayName = displayName;
      }
      if (body.avatar !== undefined) {
        const avatar = clean(body.avatar, 4);
        user.avatar = avatar || '??';
      }
      if (body.timeZone !== undefined && validTimeZone(body.timeZone)) user.timeZone = body.timeZone;
      if (body.notificationEnabled !== undefined) user.notificationEnabled = Boolean(body.notificationEnabled);
      if (body.onboardingSeen === true) user.onboardingSeen = true;
      user.updatedAt = new Date().toISOString();
      scheduleSave();
      return sendJson(res, 200, { user: publicUser(user) });
    }

    // 修改密码（需要旧密码）
    if (pathname === '/api/auth/change-password' && method === 'POST') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const body = await readBody(req);
      if (!verifyPassword(String(body.currentPassword || ''), user.passwordHash)) {
        return sendJson(res, 400, { error: '当前密码不正确。' });
      }
      const next = String(body.newPassword || '');
      const len = Array.from(next).length;
      if (len < AUTH_LIMITS.passwordMin || len > AUTH_LIMITS.passwordMax) {
        return sendJson(res, 400, { error: '新密码需为 8-72 位。' });
      }
      user.passwordHash = makePasswordHash(next);
      user.updatedAt = new Date().toISOString();
      const auth = authSession(req);
      if (auth) store.sessions = (store.sessions || []).filter((x) => x.userId !== user.id || x.id === auth.session.id);
      scheduleSave();
      return sendJson(res, 200, { ok: true });
    }

    // 用注册时保存的恢复码重置密码（不依赖邮箱服务）
    if (pathname === '/api/auth/recover' && method === 'POST') {
      if (!rateLimit(ip, 'recover', 8)) return sendJson(res, 429, { error: '尝试太频繁了，请稍后再试。' });
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const usernameKey = username.toLocaleLowerCase();
      const user = (store.users || []).find((u) => u.usernameKey === usernameKey);
      if (!user || !user.recoveryHash || !verifyPassword(normalizeRecoveryCode(body.recoveryCode), user.recoveryHash)) {
        return sendJson(res, 400, { error: '用户名或恢复码不正确。' });
      }
      const next = String(body.newPassword || '');
      const len = Array.from(next).length;
      if (len < AUTH_LIMITS.passwordMin || len > AUTH_LIMITS.passwordMax) {
        return sendJson(res, 400, { error: '新密码需为 8-72 位。' });
      }
      const freshCode = makeRecoveryCode();
      user.passwordHash = makePasswordHash(next);
      user.recoveryHash = makePasswordHash(normalizeRecoveryCode(freshCode));
      user.updatedAt = new Date().toISOString();
      store.sessions = (store.sessions || []).filter((x) => x.userId !== user.id);
      scheduleSave();
      return sendJson(res, 200, { ok: true, recoveryCode: freshCode });
    }

    // 登录状态下重新生成恢复码
    if (pathname === '/api/auth/recovery/regenerate' && method === 'POST') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const body = await readBody(req);
      if (!verifyPassword(String(body.password || ''), user.passwordHash)) {
        return sendJson(res, 400, { error: '密码不正确。' });
      }
      const freshCode = makeRecoveryCode();
      user.recoveryHash = makePasswordHash(normalizeRecoveryCode(freshCode));
      user.updatedAt = new Date().toISOString();
      scheduleSave();
      return sendJson(res, 200, { recoveryCode: freshCode });
    }

    // 导出我的全部数据
    if (pathname === '/api/account/export' && method === 'GET') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const cid = user.clientId;
      const posts = (store.posts || []).filter((p) => p.clientId === cid);
      const comments = [];
      for (const p of store.posts || []) {
        for (const c of p.comments || []) if (c.clientId === cid) comments.push({ postId: p.id, ...c });
      }
      const chats = (store.chats || []).filter((c) => chatSide(c, cid)).map((c) => ({
        id: c.id, status: c.status || 'accepted', messages: (c.messages || []).map((m) => publicMessage(m, chatSide(c, cid))),
      }));
      const payload = {
        exportedAt: new Date().toISOString(),
        app: '树洞', version: APP_VERSION,
        account: publicUser(user),
        posts, comments, chats,
        moods: (store.moods || []).filter((m) => m.clientId === cid),
        pet: findPetByUser(user.id) || null,
        notifications: (store.notifications || []).filter((n) => n.ownerClientId === cid).map(publicNotification),
        blocks: (store.blocks || []).filter((b) => b.ownerClientId === cid),
        favorites: (store.favorites || []).filter((f) => f.clientId === cid),
      };
      return sendDownload(res, 'treehole-export-' + todayKey() + '.json', payload);
    }

    // 注销账号：默认匿名化保留公共内容，可选彻底删除
    if (pathname === '/api/account/delete' && method === 'POST') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const body = await readBody(req);
      if (!verifyPassword(String(body.password || ''), user.passwordHash)) {
        return sendJson(res, 400, { error: '密码不正确。' });
      }
      if (body.confirm !== 'DELETE') return sendJson(res, 400, { error: '请输入 DELETE 确认注销。' });
      const cid = user.clientId;
      const hard = body.mode === 'hard';
      const deletedClientId = 'deleted-' + rid(10);
      for (const p of store.posts || []) {
        if (p.clientId !== cid) continue;
        if (hard) { p.hidden = true; p.text = ''; p.image = null; }
        else { p.clientId = deletedClientId; p.name = '已注销用户'; p.avatar = '🕊️'; }
      }
      for (const p of store.posts || []) {
        for (const c of p.comments || []) {
          if (c.clientId !== cid) continue;
          if (hard) { c.text = ''; c.image = null; }
          else { c.clientId = deletedClientId; c.name = '已注销用户'; c.avatar = '🕊️'; }
        }
      }
      store.chats = (store.chats || []).filter((c) => !chatSide(c, cid));
      store.moods = (store.moods || []).filter((m) => m.clientId !== cid);
      store.notifications = (store.notifications || []).filter((n) => n.ownerClientId !== cid);
      store.blocks = (store.blocks || []).filter((b) => b.ownerClientId !== cid && b.targetClientId !== cid);
      store.favorites = (store.favorites || []).filter((f) => f.clientId !== cid);
      store.pets = (store.pets || []).filter((p) => p.userId !== user.id);
      store.sessions = (store.sessions || []).filter((s) => s.userId !== user.id);
      store.users = (store.users || []).filter((u) => u.id !== user.id);
      clearSessionCookie(req, res);
      scheduleSave();
      return sendJson(res, 200, { ok: true, mode: hard ? 'hard' : 'anonymize' });
    }

    // 查询宠物
    if (pathname === '/api/pet' && method === 'GET') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const pet = findPetByUser(user.id);
      return sendJson(res, 200, { pet: pet ? publicPet(pet) : null });
    }

    // 领养宠物
    if (pathname === '/api/pet/adopt' && method === 'POST') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      if (findPetByUser(user.id)) return sendJson(res, 409, { error: '你已经领养过宠物了。' });
      const body = await readBody(req);
      const species = PET_SPECIES.find((x) => x.id === body.species);
      if (!species) return sendJson(res, 400, { error: '没有这个宠物品种。' });
      const name = clean(body.name, 12).replace(/\s+/g, ' ');
      if (!name) return sendJson(res, 400, { error: '请给宠物起个名字。' });
      const now = new Date().toISOString();
      const pet = {
        id: rid(8),
        userId: user.id,
        species: species.id,
        name,
        level: 1,
        exp: 0,
        fullness: 72,
        mood: 78,
        streak: 0,
        totalInteractions: 0,
        lastActiveDay: null,
        lastActions: {},
        decorationId: 'default',
        daily: { day: todayKey(), actions: { feed: false, pat: false, play: false }, completedBonus: false },
        streakRewards: {},
        createdAt: now,
        lastDecayAt: now,
        updatedAt: now,
      };
      store.pets = store.pets || [];
      store.pets.push(pet);
      if (store.pets.length > 10000) store.pets = store.pets.slice(-10000);
      scheduleSave();
      return sendJson(res, 201, { pet: publicPet(pet), message: species.emoji + ' 已经来到你身边。' });
    }

    // 修改宠物名字
    // 修改宠物名字或更换已解锁装饰
    if (pathname === '/api/pet' && method === 'PATCH') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const pet = findPetByUser(user.id);
      if (!pet) return sendJson(res, 404, { error: '你还没有领养宠物。' });
      const body = await readBody(req);
      let changed = false;
      if (body.name !== undefined) {
        const name = clean(body.name, 12).replace(/\s+/g, ' ');
        if (!name) return sendJson(res, 400, { error: '宠物名字不能为空。' });
        pet.name = name;
        changed = true;
      }
      if (body.decorationId !== undefined) {
        const decoration = PET_DECORATIONS.find((item) => item.id === body.decorationId);
        if (!decoration) return sendJson(res, 400, { error: '没有这个装饰。' });
        if (Math.max(1, Number(pet.level) || 1) < decoration.minLevel) {
          return sendJson(res, 403, { error: '宠物成长到 ' + decoration.minLevel + ' 级后才能使用「' + decoration.label + '」。', minLevel: decoration.minLevel });
        }
        pet.decorationId = decoration.id;
        changed = true;
      }
      if (!changed) return sendJson(res, 400, { error: '没有需要修改的内容。' });
      pet.updatedAt = new Date().toISOString();
      scheduleSave();
      return sendJson(res, 200, { pet: publicPet(pet) });
    }

    if (pathname === '/api/pet/interact' && method === 'POST') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: '请先登录。' });
      const pet = findPetByUser(user.id);
      if (!pet) return sendJson(res, 404, { error: '你还没有领养宠物。' });
      const body = await readBody(req);
      const actionId = typeof body.action === 'string' ? body.action : '';
      const action = PET_ACTIONS[actionId];
      if (!action) return sendJson(res, 400, { error: '不认识的互动动作。' });
      applyPetDecay(pet);
      const remaining = petCooldowns(pet)[actionId] || 0;
      if (remaining > 0) return sendJson(res, 429, { error: '现在还差一点冷却时间。', remainingMs: remaining, pet: publicPet(pet) });
      const result = applyPetAction(pet, actionId);
      scheduleSave();
      return sendJson(res, 200, { pet: publicPet(pet), result });
    }
    if (pathname === '/api/events' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      return openSse(req, res, clientId);
    }

    // 通知中心
    if (pathname === '/api/notifications' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
      const items = (store.notifications || [])
        .filter((n) => n.ownerClientId === clientId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit)
        .map(publicNotification);
      return sendJson(res, 200, { notifications: items, unread: unreadNotificationCount(clientId) });
    }

    if (pathname === '/api/notifications/read' && method === 'POST') {
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const changed = markNotificationsRead(clientId, body.all ? null : body.ids);
      return sendJson(res, 200, { ok: true, changed, unread: unreadNotificationCount(clientId) });
    }

    if (pathname === '/api/notifications' && method === 'DELETE') {
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const before = (store.notifications || []).length;
      store.notifications = (store.notifications || []).filter((n) => n.ownerClientId !== clientId);
      if (store.notifications.length !== before) scheduleSave();
      return sendJson(res, 200, { ok: true });
    }

    // 拉黑 / 解除拉黑
    if (pathname === '/api/blocks' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const blocks = (store.blocks || []).filter((b) => b.ownerClientId === clientId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, { blocks });
    }

    if (pathname === '/api/blocks' && method === 'POST') {
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      let target = validClientId(body.targetClientId) ? body.targetClientId : '';
      const post = body.postId ? (store.posts || []).find((p) => p.id === body.postId) : null;
      if (!target && post) target = post.clientId;
      if (!target && body.commentId && post) {
        const c = (post.comments || []).find((x) => x.id === body.commentId);
        if (c) target = c.clientId;
      }
      let chat = null;
      if (!target && body.chatId) {
        chat = findChat(String(body.chatId));
        const side = chat ? chatSide(chat, clientId) : null;
        if (chat && side) target = (side === 'a' ? chat.b : chat.a).clientId;
      }
      if (!validClientId(target)) return sendJson(res, 400, { error: '找不到要拉黑的对象。' });
      if (target === clientId) return sendJson(res, 400, { error: '不能拉黑自己。' });
      const created = addBlock(clientId, target);
      if (chat) { chat.status = 'blocked'; chat.updatedAt = new Date().toISOString(); }
      for (const c of store.chats || []) {
        if (chatSide(c, clientId) && chatSide(c, target)) c.status = 'blocked';
      }
      scheduleSave();
      broadcastEvent('block', { action: 'created', targetClientId: target }, [clientId, target]);
      return sendJson(res, 201, { ok: true, created, blocks: (store.blocks || []).filter((b) => b.ownerClientId === clientId).length });
    }

    if (pathname === '/api/blocks' && method === 'DELETE') {
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const target = validClientId(body.targetClientId) ? body.targetClientId : '';
      if (!target) return sendJson(res, 400, { error: '缺少要解除的对象。' });
      const removed = removeBlock(clientId, target);
      for (const c of store.chats || []) {
        const side = chatSide(c, clientId);
        if (!side) continue;
        const other = (side === 'a' ? c.b : c.a).clientId;
        if (other === target && c.status === 'blocked') c.status = 'accepted';
      }
      scheduleSave();
      return sendJson(res, 200, { ok: true, removed });
    }

    // 树洞墙
    if (pathname === '/api/feed' && method === 'GET') {
      const sortParam = url.searchParams.get('sort') || 'new';
      const sort = ['warm', 'unanswered'].includes(sortParam) ? sortParam : 'new';
      const mood = url.searchParams.get('mood') || '';
      const slot = validMoodSlot(url.searchParams.get('slot')) ? url.searchParams.get('slot') : '';
      const q = clean(url.searchParams.get('q') || '', 60).toLocaleLowerCase();
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      const limit = Math.min(Number(url.searchParams.get('limit')) || 30, LIMITS.feedMax);
      const timeZone = requestTimeZone(req, url);

      let list = visiblePosts(clientId);
      if (mood) list = list.filter((p) => p.mood === mood);
      if (slot) list = list.filter((p) => slotOfDate(new Date(p.createdAt), timeZone) === slot);
      if (sort === 'unanswered') list = list.filter((p) => isUnanswered(p, clientId));
      if (q) {
        list = list.filter((p) => {
          const hay = [p.text, p.name, ...activeComments(p).map((c) => c.text)].join(' ').toLocaleLowerCase();
          return hay.includes(q);
        });
      }
      list = list.slice().sort((a, b) => {
        if (sort === 'warm') {
          const diff = warmthScore(b, clientId) - warmthScore(a, clientId);
          if (diff !== 0) return diff;
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      return sendJson(res, 200, {
        posts: list.slice(0, limit).map((p) => publicPost(p, clientId)),
        total: list.length,
        q, slot, sort,
      });
    }

    // 听一个陌生人的心事
    if (pathname === '/api/random' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      const pool = visiblePosts(clientId);
      if (!pool.length) return sendJson(res, 200, { post: null });
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return sendJson(res, 200, { post: publicPost(pick, clientId) });
    }

    // 图片上传：收二进制，按魔数判断真实格式
    if (pathname === '/api/images' && method === 'POST') {
      if (!rateLimit(ip, 'image', IMAGE_LIMITS.perMinute)) {
        return sendJson(res, 429, { error: '图片传得太快了，慢一点。' });
      }
      const buf = await readBinary(req, IMAGE_LIMITS.maxBytes);
      if (!buf.length) return sendJson(res, 400, { error: '没有收到图片。' });
      const ext = sniffImage(buf);
      if (!ext) return sendJson(res, 400, { error: '只支持 PNG / JPG / GIF / WebP 图片。' });
      const imageInfo = inspectImage(buf, ext);
      if (!imageInfo.ok && imageInfo.reason === 'too_large') {
        return sendJson(res, 413, { error: '图片像素太大，请压缩后再上传。' });
      }
      if (!imageInfo.ok) return sendJson(res, 400, { error: '图片文件损坏或尺寸无法识别。' });
      ensureDirs();
      const name = rid(12) + '.' + ext;
      fs.writeFileSync(imagePath(name), buf);
      const clientId = viewerClientId(req, url.searchParams.get('clientId') || req.headers['x-client-id']);
      const reviewStatus = registerImage(name, clientId);
      return sendJson(res, 201, { image: name, url: '/api/images/' + name, bytes: buf.length, reviewStatus });
    }

    // 图片读取
    const imgMatch = pathname.match(/^\/api\/images\/([A-Za-z0-9._-]+)$/);
    if (imgMatch && method === 'GET') {
      const name = imgMatch[1];
      if (!validImageName(name)) return sendJson(res, 404, { error: '图片不存在。' });
      fs.readFile(imagePath(name), (err, data) => {
        if (err) return sendJson(res, 404, { error: '图片不存在。' });
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': data.length,
        });
        res.end(data);
      });
      return;
    }

    // 私聊：会话列表
    if (pathname === '/api/chats' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const chats = (store.chats || [])
        .filter((c) => chatSide(c, clientId))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
        .map((c) => publicChat(c, chatSide(c, clientId)));
      const unread = chats.reduce((n, c) => n + (c.unread || 0), 0);
      return sendJson(res, 200, { chats, unread });
    }

    // 私聊：先发起请求，对方接受后才算真正开始聊天
    if (pathname === '/api/chats' && method === 'POST') {
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      if (!clientId) return sendJson(res, 400, { error: '身份信息缺失。' });
      const restriction = riskRestrictionFor(clientId, ip);
      if (restriction) return sendJson(res, 403, { error: riskRestrictionMessage(restriction), restriction: { kind: restriction.kind, until: restriction.until || null } });
      if (!rateLimit(ip, 'chat', CHAT_LIMITS.chatsPerMinute)) {
        recordRateLimitRisk(ip, ip, 'chat', '', body.postId || '');
        return sendJson(res, 429, { error: '私聊发起得太频繁了，缓一缓。' });
      }
      if (!rateLimit(clientId, 'chatreq', CHAT_REQUEST_LIMITS.perMinute)) {
        recordRateLimitRisk(clientId, ip, 'chat_request', '', body.postId || '');
        return sendJson(res, 429, { error: '私聊请求发得太频繁了。' });
      }
      const chatText = clean(body.text, CHAT_LIMITS.message);
      if (chatText && looksLikeAd(chatText)) {
        recordRiskEvent({
          subjectId: clientId, subjectType: 'client', surface: 'chat', targetType: 'chat',
          targetId: typeof body.postId === 'string' ? body.postId : '', text: chatText,
          reasons: ['ad'], blocked: true, ip, actorClientId: clientId,
        });
        return sendJson(res, 400, { error: '这里不收广告和导流信息，请换一句真心话。' });
      }
      const postId = typeof body.postId === 'string' ? body.postId : '';
      const commentId = typeof body.commentId === 'string' ? body.commentId : '';
      const post = (store.posts || []).find((p) => p.id === postId);
      if (!post) return sendJson(res, 404, { error: '这条心事已经不在了。' });
      let peerId = post.clientId;
      let origin = 'post';
      let peerName = post.name;
      let peerAvatar = post.avatar;
      if (commentId) {
        const c = (post.comments || []).find((x) => x.id === commentId);
        if (!c) return sendJson(res, 404, { error: '这条回音已经不在了。' });
        peerId = c.clientId;
        origin = 'comment';
        peerName = c.name;
        peerAvatar = c.avatar;
      }
      if (!peerId || peerId === clientId) return sendJson(res, 400, { error: '不能和自己私聊。' });
      if (pairBlocked(clientId, peerId)) return sendJson(res, 403, { error: '你们之间有一方选择了不再联系。' });
      let chat = (store.chats || []).find((c) =>
        c.postId === post.id && (
          (c.a.clientId === clientId && c.b.clientId === peerId) ||
          (c.a.clientId === peerId && c.b.clientId === clientId)
        ));
      let created = false;
      if (!chat) {
        const now = new Date().toISOString();
        chat = {
          id: rid(8),
          postId: post.id,
          origin,
          a: { clientId, name: cleanName(body.name), avatar: clean(body.avatar, 4) || '🌳' },
          b: { clientId: peerId, name: peerName, avatar: peerAvatar },
          status: 'pending',
          requestedBy: 'a',
          reads: { a: Date.now(), b: 0 },
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        store.chats = store.chats || [];
        store.chats.push(chat);
        if (store.chats.length > 2000) store.chats = store.chats.slice(-2000);
        created = true;
      }
      const side = chatSide(chat, clientId);
      if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
      if (chat.status === 'declined' && chat.requestedBy !== side) {
        chat.status = 'pending';
        chat.requestedBy = side;
        created = true;
      }
      if (chat.status === 'blocked') return sendJson(res, 403, { error: '这个会话已经结束。' });
      if (created) {
        addNotification(peerId, {
          type: 'chat_request',
          title: '有人想和你说悄悄话',
          text: cleanName(body.name) + ' 想从一条心事开始和你聊聊。',
          chatId: chat.id,
          actorName: cleanName(body.name),
          actorClientId: clientId,
          dedupeKey: 'chatreq:' + chat.id,
        });
      }
      const text = chatText;
      let sentId = null;
      if (text && (chat.status === 'accepted' || chat.requestedBy === side)) {
        const msg = { id: rid(6), from: side, text, image: null, createdAt: new Date().toISOString() };
        sentId = msg.id;
        chat.messages.push(msg);
        chat.reads = chat.reads || { a: 0, b: 0 };
        chat.reads[side] = Date.now();
        chat.updatedAt = msg.createdAt;
        recordContentRisk(clientId, ip, 'chat', text, msg.id);
        scheduleSave();
      }
      broadcastEvent('chat', { action: created ? 'request' : (sentId ? 'message' : 'updated'), chatId: chat.id, messageId: sentId }, [chat.a.clientId, chat.b.clientId]);
      return sendJson(res, 200, { chat: publicChat(chat, side), requestPending: chat.status === 'pending' });
    }

    // 私聊：单个会话（读 / 发消息 / 标记已读）

    const chatReportMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9]+)\/report$/);
    if (chatReportMatch && method === 'POST') {
      const chat = findChat(chatReportMatch[1]);
      if (!chat) return sendJson(res, 404, { error: '会话不存在。' });
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      const side = chatSide(chat, clientId);
      if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
      if (!rateLimit(clientId, 'report', REPORT_LIMITS.perMinute)) return sendJson(res, 429, { error: '举报得太频繁了。' });
      const other = side === 'a' ? chat.b : chat.a;
      const last = (chat.messages || []).slice(-1)[0] || null;
      const { report, created } = recordReport({
        targetType: 'chat', targetId: chat.id, chatId: chat.id,
        reporterClientId: clientId, reason: body.reason, note: body.note,
        authorClientId: other && other.clientId,
        snapshot: {
          peerName: other && other.name,
          text: last ? last.text : '',
          hasImage: Boolean(last && last.image),
          createdAt: last && last.createdAt,
        },
      });
      scheduleSave();
      return sendJson(res, 200, { ok: true, created, reportId: report.id });
    }

    const chatMessageMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9]+)\/messages\/([A-Za-z0-9]+)(?:\/(report|recall))?$/);
    if (chatMessageMatch) {
      const chat = findChat(chatMessageMatch[1]);
      if (!chat) return sendJson(res, 404, { error: '会话不存在。' });
      const message = (chat.messages || []).find((m) => m.id === chatMessageMatch[2]);
      if (!message) return sendJson(res, 404, { error: '这条消息已经不在了。' });
      const action = chatMessageMatch[3] || '';
      const body = await readBody(req).catch(() => ({}));
      const clientId = viewerClientId(req, body.clientId || url.searchParams.get('clientId') || req.headers['x-client-id']);
      const side = chatSide(chat, clientId);
      if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });

      if ((action === 'report' || (!action && pathname.endsWith('/report'))) && method === 'POST') {
        if (!rateLimit(clientId, 'report', REPORT_LIMITS.perMinute)) return sendJson(res, 429, { error: '举报得太频繁了。' });
        const other = side === 'a' ? chat.b : chat.a;
        const { report, created } = recordReport({
          targetType: 'chat_message', targetId: chat.id + ':' + message.id,
          chatId: chat.id, messageId: message.id, reporterClientId: clientId,
          reason: body.reason, note: body.note, authorClientId: other && other.clientId,
          snapshot: {
            peerName: other && other.name,
            text: message.text || '',
            messageId: message.id,
            hasImage: Boolean(message.image),
            createdAt: message.createdAt,
          },
        });
        scheduleSave();
        return sendJson(res, 200, { ok: true, created, reportId: report.id });
      }

      if (method === 'DELETE' || (action === 'recall' && method === 'POST')) {
        if (message.from !== side) return sendJson(res, 403, { error: '只能撤回自己发送的消息。' });
        if (message.recalledAt) return sendJson(res, 200, { ok: true, message: publicMessage(message, side) });
        if (Date.now() - new Date(message.createdAt).getTime() > RECALL_WINDOW_MS) {
          return sendJson(res, 403, { error: '撤回时间已过，消息会留在会话里。' });
        }
        message.recalledAt = new Date().toISOString();
        message.text = '';
        message.image = null;
        message.imageThumb = null;
        chat.updatedAt = message.recalledAt;
        scheduleSave();
        broadcastEvent('chat', { action: 'recall', chatId: chat.id, messageId: message.id }, [chat.a.clientId, chat.b.clientId]);
        return sendJson(res, 200, { ok: true, message: publicMessage(message, side), chat: publicChat(chat, side) });
      }
      return sendJson(res, 405, { error: '不支持的消息操作。' });
    }

    const chatMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9]+)(?:\/(messages|read|accept|decline))?$/);
    if (chatMatch) {
      const chat = findChat(chatMatch[1]);
      if (!chat) return sendJson(res, 404, { error: '会话不存在。' });
      const sub = chatMatch[2];

      if (sub === undefined && method === 'GET') {
        const clientId = viewerClientId(req, url.searchParams.get('clientId'));
        const side = chatSide(chat, clientId);
        if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
        const status = chat.status || 'accepted';
        const isRequester = chat.requestedBy === side;
        const canSee = status === 'accepted' || isRequester;
        if (canSee) {
          chat.reads = chat.reads || { a: 0, b: 0 };
          chat.reads[side] = Date.now();
          scheduleSave();
        }
        return sendJson(res, 200, {
          chat: publicChat(chat, side),
          messages: canSee ? (chat.messages || []).map((m) => publicMessage(m, side)) : [],
          requestPending: status === 'pending' && !isRequester,
        });
      }

      if (sub === 'messages' && method === 'POST') {
        const body = await readBody(req);
        const clientId = viewerClientId(req, body.clientId);
        const side = chatSide(chat, clientId);
        if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
        const restriction = riskRestrictionFor(clientId, ip);
        if (restriction) return sendJson(res, 403, { error: riskRestrictionMessage(restriction), restriction: { kind: restriction.kind, until: restriction.until || null } });
        if (chat.status === 'blocked') return sendJson(res, 403, { error: '这个会话已经结束。' });
        if (chat.status === 'pending' && chat.requestedBy !== side) {
          return sendJson(res, 403, { error: '先接受对方的私聊请求，再回复吧。' });
        }
        if (!rateLimit(ip, 'chatmsg', CHAT_LIMITS.messagesPerMinute)) {
          recordRateLimitRisk(ip, ip, 'chat_message', '', chat.id);
          return sendJson(res, 429, { error: '发得太快了，缓一缓。' });
        }
        const text = clean(body.text, CHAT_LIMITS.message);
        if (text && looksLikeAd(text)) {
          recordRiskEvent({
            subjectId: clientId, subjectType: 'client', surface: 'chat_message', targetType: 'chat',
            targetId: chat.id, text, reasons: ['ad'], blocked: true, ip, actorClientId: clientId,
          });
          return sendJson(res, 400, { error: '这里不收广告和导流信息，请换一句真心话。' });
        }
        const image = imageUsableBy(body.image, clientId) ? body.image : null;
        if (!text && !image) return sendJson(res, 400, { error: '说点什么，或者发一张图片。' });
        const msg = { id: rid(6), from: side, text, image, createdAt: new Date().toISOString() };
        chat.messages = chat.messages || [];
        chat.messages.push(msg);
        if (chat.messages.length > 1000) chat.messages = chat.messages.slice(-1000);
        chat.reads = chat.reads || { a: 0, b: 0 };
        chat.reads[side] = Date.now();
        chat.updatedAt = msg.createdAt;
        recordContentRisk(clientId, ip, 'chat_message', text, msg.id);
        scheduleSave();
        broadcastEvent('chat', { action: 'message', chatId: chat.id, messageId: msg.id }, [chat.a.clientId, chat.b.clientId]);
        return sendJson(res, 201, { message: publicMessage(msg, side), chat: publicChat(chat, side) });
      }

      if (sub === 'read' && method === 'POST') {
        const body = await readBody(req);
        const clientId = viewerClientId(req, body.clientId);
        const side = chatSide(chat, clientId);
        if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
        chat.reads = chat.reads || { a: 0, b: 0 };
        chat.reads[side] = Date.now();
        scheduleSave();
        return sendJson(res, 200, { ok: true, unread: chatUnread(chat, side) });
      }

      if (sub === 'accept' && method === 'POST') {
        const body = await readBody(req);
        const clientId = viewerClientId(req, body.clientId);
        const side = chatSide(chat, clientId);
        if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
        if (chat.requestedBy === side) return sendJson(res, 400, { error: '这是你自己发出的请求。' });
        chat.status = 'accepted';
        chat.updatedAt = new Date().toISOString();
        chat.reads = chat.reads || { a: 0, b: 0 };
        chat.reads[side] = Date.now();
        addNotification(chat[chat.requestedBy].clientId, {
          type: 'chat_accept', title: '私聊请求通过了',
          text: '对方愿意继续听你说，去悄悄话里聊聊吧。',
          chatId: chat.id, actorName: '对方', actorClientId: clientId,
          dedupeKey: 'chataccept:' + chat.id,
        });
        scheduleSave();
        broadcastEvent('chat', { action: 'accepted', chatId: chat.id }, [chat.a.clientId, chat.b.clientId]);
        return sendJson(res, 200, { chat: publicChat(chat, side) });
      }

      if (sub === 'decline' && method === 'POST') {
        const body = await readBody(req);
        const clientId = viewerClientId(req, body.clientId);
        const side = chatSide(chat, clientId);
        if (!side) return sendJson(res, 403, { error: '这不是你的悄悄话。' });
        if (chat.requestedBy === side) return sendJson(res, 400, { error: '这是你自己发出的请求。' });
        chat.status = 'declined';
        chat.updatedAt = new Date().toISOString();
        scheduleSave();
        broadcastEvent('chat', { action: 'declined', chatId: chat.id }, [chat.a.clientId, chat.b.clientId]);
        return sendJson(res, 200, { chat: publicChat(chat, side) });
      }

      return sendJson(res, 405, { error: '不支持的请求方式。' });
    }

    // 发布
    if (pathname === '/api/posts' && method === 'POST') {
      const body = await readBody(req);
      const text = clean(body.text, LIMITS.post);
      const posterId = viewerClientId(req, body.clientId) || 'anon-' + rid(6);
      const restriction = riskRestrictionFor(posterId, ip);
      if (restriction) return sendJson(res, 403, { error: riskRestrictionMessage(restriction), restriction: { kind: restriction.kind, until: restriction.until || null } });
      if (text.length < 2) return sendJson(res, 400, { error: '再多写一点点吧，至少 2 个字。' });
      if (looksLikeAd(text)) {
        recordRiskEvent({
          subjectId: posterId, subjectType: riskSubjectTypeFor(posterId), surface: 'post',
          targetType: 'post', text, reasons: ['ad'], blocked: true, ip, actorClientId: posterId,
        });
        return sendJson(res, 400, { error: '这里不收广告和导流信息，请换一段心里话。' });
      }
      if (!rateLimit(ip, 'post', LIMITS.postsPerMinute)) {
        recordRateLimitRisk(ip, ip, 'post', text);
        return sendJson(res, 429, { error: '慢一点，树洞也需要喘气。稍后再写。' });
      }
      const moodId = MOODS.some((m) => m.id === body.mood) ? body.mood : 'calm';
      const post = {
        id: rid(8),
        clientId: posterId,
        name: cleanName(body.name),
        avatar: clean(body.avatar, 4) || '🌳',
        mood: moodId,
        text,
        image: imageUsableBy(body.image, posterId) ? body.image : null,
        imagePending: Boolean(body.image && imagePendingFor(body.image, posterId)),
        createdAt: new Date().toISOString(),
        reactions: Object.fromEntries(ALL_REACTIONS.map((r) => [r.id, []])),
        comments: [],
        reports: [],
        hidden: false,
      };
      store.posts.push(post);
      if (store.posts.length > 5000) store.posts = store.posts.slice(-5000);
      recordContentRisk(posterId, ip, 'post', text, post.id);
      scheduleSave();
      broadcastEvent('feed', { action: 'post', postId: post.id, createdAt: post.createdAt });
      return sendJson(res, 201, {
        post: publicPost(post, post.clientId),
        care: hasAny(text, CRISIS_WORDS) ? CARE : null,
      });
    }

    if (pathname === '/api/favorites' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const favorites = (store.favorites || []).filter((f) => f.clientId === clientId);
      const byId = new Map((store.posts || []).map((p) => [p.id, p]));
      const posts = favorites
        .map((f) => ({ favorite: f, post: byId.get(f.postId) }))
        .filter(({ post }) => post && !post.hidden && (post.reports?.length || 0) < LIMITS.reportHideAt && !pairBlocked(clientId, post.clientId))
        .sort((a, b) => String(b.favorite.createdAt || '').localeCompare(String(a.favorite.createdAt || '')))
        .map(({ favorite, post }) => ({ ...publicPost(post, clientId), savedAt: favorite.createdAt || null }));
      return sendJson(res, 200, { posts, total: posts.length });
    }

    const favoriteMatch = pathname.match(/^\/api\/posts\/([A-Za-z0-9]+)\/favorite$/);
    if (favoriteMatch && (method === 'POST' || method === 'DELETE')) {
      const body = await readBody(req).catch(() => ({}));
      const clientId = viewerClientId(req, body.clientId || url.searchParams.get('clientId') || req.headers['x-client-id']);
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '请先登录或保留匿名身份。' });
      const post = (store.posts || []).find((p) => p.id === favoriteMatch[1]);
      if (!post || post.hidden || (post.reports?.length || 0) >= LIMITS.reportHideAt) return sendJson(res, 404, { error: '这条心事已经不在了。' });
      if (pairBlocked(clientId, post.clientId)) return sendJson(res, 403, { error: '你们之间暂时不能收藏这条心事。' });
      store.favorites = store.favorites || [];
      const existing = store.favorites.find((f) => f.clientId === clientId && f.postId === post.id);
      if (method === 'DELETE') {
        store.favorites = store.favorites.filter((f) => !(f.clientId === clientId && f.postId === post.id));
        if (existing) scheduleSave();
        return sendJson(res, 200, { ok: true, favorited: false, post: publicPost(post, clientId) });
      }
      if (!existing) {
        store.favorites.push({ clientId, postId: post.id, createdAt: new Date().toISOString() });
        if (store.favorites.length > 20000) store.favorites = store.favorites.slice(-20000);
        scheduleSave();
      }
      return sendJson(res, 200, { ok: true, favorited: true, post: publicPost(post, clientId) });
    }

    const postMatch = pathname.match(/^\/api\/posts\/([A-Za-z0-9]+)(?:\/(comments|reactions|report))?$/);

    const commentActionMatch = pathname.match(/^\/api\/posts\/([A-Za-z0-9]+)\/comments\/([A-Za-z0-9]+)(?:\/(report))?$/);
    if (commentActionMatch && (method === 'DELETE' || (method === 'POST' && commentActionMatch[3] === 'report'))) {
      const post = (store.posts || []).find((p) => p.id === commentActionMatch[1]);
      if (!post) return sendJson(res, 404, { error: '这条心事已经不在了。' });
      const comment = (post.comments || []).find((c) => c.id === commentActionMatch[2]);
      if (!comment || comment.deletedAt) return sendJson(res, 404, { error: '这条回音已经不在了。' });
      const body = await readBody(req).catch(() => ({}));
      const clientId = viewerClientId(req, body.clientId || url.searchParams.get('clientId') || req.headers['x-client-id']) || ip;

      if (method === 'DELETE') {
        if (!clientId || comment.clientId !== clientId) return sendJson(res, 403, { error: '只能撤回自己写下的回音。' });
        comment.deletedAt = new Date().toISOString();
        comment.text = '';
        comment.image = null;
        comment.imageThumb = null;
        scheduleSave();
        broadcastEvent('feed', { action: 'comment-delete', postId: post.id, commentId: comment.id });
        return sendJson(res, 200, { ok: true, comment: publicComment(comment, clientId) });
      }

      if (!rateLimit(clientId, 'report', REPORT_LIMITS.perMinute)) return sendJson(res, 429, { error: '举报得太频繁了。' });
      if (comment.clientId === clientId) return sendJson(res, 400, { error: '不能举报自己的回音。' });
      const { report, created } = recordReport({
        targetType: 'comment', targetId: comment.id, postId: post.id, commentId: comment.id,
        reporterClientId: clientId, reason: normalizeReportReason(body.reason), note: body.note,
        authorClientId: comment.clientId,
        postText: clean(post.text, 120),
        snapshot: { text: comment.text || '', hasImage: Boolean(comment.image), createdAt: comment.createdAt },
      });
      comment.reporters = comment.reporters || [];
      if (!comment.reporters.includes(clientId)) comment.reporters.push(clientId);
      scheduleSave();
      return sendJson(res, 200, { ok: true, created, reportId: report.id, reports: comment.reporters.length });
    }

    if (postMatch) {
      const post = store.posts.find((p) => p.id === postMatch[1]);
      if (!post) return sendJson(res, 404, { error: '这条心事已经不在了。' });
      const sub = postMatch[2];

      // 评论列表
      if (sub === 'comments' && method === 'GET') {
        const clientId = viewerClientId(req, url.searchParams.get('clientId'));
        const comments = (post.comments || [])
          .filter((c) => !clientId || !pairBlocked(clientId, c.clientId))
          .map((c) => {
            const item = publicComment(c, clientId);
            item.isAuthor = c.clientId === post.clientId;
            return item;
          });
        return sendJson(res, 200, { comments, authorClientId: undefined });
      }

      // 删除自己的心事
      if (!sub && method === 'DELETE') {
        const clientId = viewerClientId(req, url.searchParams.get('clientId'));
        if (!clientId || post.clientId !== clientId) {
          return sendJson(res, 403, { error: '只能删除自己写下的心事。' });
        }
        post.hidden = true;
        post.text = '';
        scheduleSave();
        broadcastEvent('feed', { action: 'delete', postId: post.id });
        return sendJson(res, 200, { ok: true });
      }

      // 回应：抱抱 / 我懂 / 加油 + 快捷表情
      if (sub === 'reactions' && method === 'POST') {
        const body = await readBody(req);
        const type = body.type;
        const clientId = viewerClientId(req, body.clientId);
        if (!ALL_REACTIONS.some((r) => r.id === type)) return sendJson(res, 400, { error: '未知的回应。' });
        if (!clientId) return sendJson(res, 400, { error: '身份信息缺失。' });
        if (pairBlocked(clientId, post.clientId)) return sendJson(res, 403, { error: '这条心事暂时不能回应。' });
        if (!rateLimit(clientId, 'reaction', REACTION_LIMITS.perMinute)) return sendJson(res, 429, { error: '回应得太快了，缓一缓。' });
        post.reactions = post.reactions || Object.fromEntries(ALL_REACTIONS.map((r) => [r.id, []]));
        const list = post.reactions[type] || (post.reactions[type] = []);
        const i = list.indexOf(clientId);
        let added = false;
        if (i >= 0) list.splice(i, 1);
        else { list.push(clientId); added = true; }
        const reactionMeta = ALL_REACTIONS.find((r) => r.id === type);
        if (added) {
          addNotification(post.clientId, {
            type: 'reaction', title: '有人点亮了你的心事',
            text: '有人给了你「' + reactionMeta.emoji + ' ' + reactionMeta.label + '」',
            postId: post.id, actorName: '匿名旅人', actorClientId: clientId,
            dedupeKey: 'reaction:' + post.id + ':' + type + ':' + clientId,
          });
        }
        scheduleSave();
        broadcastEvent('feed', { action: 'reaction', postId: post.id });
        return sendJson(res, 200, { post: publicPost(post, clientId) });
      }

      // 回音（评论）
      if (sub === 'comments' && method === 'POST') {
        const body = await readBody(req);
        const text = clean(body.text, LIMITS.comment);
        const commenterId = viewerClientId(req, body.clientId) || 'anon-' + rid(6);
        const restriction = riskRestrictionFor(commenterId, ip);
        if (restriction) return sendJson(res, 403, { error: riskRestrictionMessage(restriction), restriction: { kind: restriction.kind, until: restriction.until || null } });
        if (!rateLimit(ip, 'comment', LIMITS.commentsPerMinute)) {
          recordRateLimitRisk(ip, ip, 'comment', text, post.id);
          return sendJson(res, 429, { error: '回音太快了，缓一缓再写。' });
        }
        if (pairBlocked(commenterId, post.clientId)) return sendJson(res, 403, { error: '这条心事暂时不能回应。' });
        const commentImage = imageUsableBy(body.image, commenterId) ? body.image : null;
        if (text.length < 1 && !commentImage) return sendJson(res, 400, { error: '写点什么再发出去吧。' });
        if (text.length && looksLikeAd(text)) {
          recordRiskEvent({
            subjectId: commenterId, subjectType: riskSubjectTypeFor(commenterId), surface: 'comment',
            targetType: 'comment', targetId: post.id, text, reasons: ['ad'], blocked: true, ip, actorClientId: commenterId,
          });
          return sendJson(res, 400, { error: '这里不收广告，请换一句真心话。' });
        }
        let parent = null;
        if (body.parentId) {
          parent = (post.comments || []).find((c) => c.id === body.parentId) || null;
          if (!parent) return sendJson(res, 404, { error: '要回复的那条回音已经不在了。' });
          if (pairBlocked(commenterId, parent.clientId)) return sendJson(res, 403, { error: '不能回复这条回音。' });
        }
        const comment = {
          id: rid(6),
          clientId: commenterId,
          name: cleanName(body.name),
          avatar: clean(body.avatar, 4) || '🌱',
          text,
          image: commentImage,
          parentId: parent ? parent.id : null,
          replyToName: parent ? parent.name : null,
          createdAt: new Date().toISOString(),
        };
        post.comments = post.comments || [];
        post.comments.push(comment);
        if (post.comments.length > 200) post.comments = post.comments.slice(-200);
        recordContentRisk(commenterId, ip, 'comment', text, comment.id);
        addNotification(post.clientId, {
          type: parent ? 'comment_reply' : 'comment',
          title: parent ? '有人回复了回音' : '有人回应了你的心事',
          text: comment.name + '：' + (text || '［图片］'),
          postId: post.id, commentId: comment.id, actorName: comment.name, actorClientId: commenterId,
          dedupeKey: 'comment:' + comment.id + ':' + post.clientId,
        });
        if (parent) {
          addNotification(parent.clientId, {
            type: 'reply', title: '有人回复了你',
            text: comment.name + ' 回复了你：' + (text || '［图片］'),
            postId: post.id, commentId: comment.id, actorName: comment.name, actorClientId: commenterId,
            dedupeKey: 'reply:' + comment.id + ':' + parent.clientId,
          });
        }
        scheduleSave();
        broadcastEvent('feed', { action: 'comment', postId: post.id, commentId: comment.id });
        return sendJson(res, 201, { comment: publicComment(comment, comment.clientId), commentCount: post.comments.length });
      }

      // 举报：带分类存档，后台可以逐条处理
      if (sub === 'report' && method === 'POST') {
        const body = await readBody(req);
        const clientId = viewerClientId(req, body.clientId) || ip;
        if (!rateLimit(clientId, 'report', REPORT_LIMITS.perMinute)) return sendJson(res, 429, { error: '举报得太频繁了。' });
        const reasonId = REPORT_REASONS.some((r) => r.id === body.reason) ? body.reason : 'other';
        const note = clean(body.note, 120);
        post.reports = post.reports || [];
        recordReport({
          targetType: 'post', targetId: post.id, postId: post.id,
          reporterClientId: clientId, reason: reasonId, note,
          postText: clean(post.text, 120), authorClientId: post.clientId,
        });
        if (!post.reports.includes(clientId)) post.reports.push(clientId);
        if (post.reports.length >= LIMITS.reportHideAt) post.hidden = true;
        scheduleSave();
        if (post.hidden) broadcastEvent('feed', { action: 'hide', postId: post.id });
        return sendJson(res, 200, { ok: true, hidden: Boolean(post.hidden), reason: reasonId });
      }

      return sendJson(res, 405, { error: '不支持的请求方式。' });
    }

    // 时段主题：帮助用户在合适的时段写下合适的心事
    if (pathname === '/api/topics' && method === 'GET') {
      const timeZone = requestTimeZone(req, url);
      const nowSlot = slotOfDate(new Date(), timeZone);
      const topics = MOOD_SLOTS.map((slot) => ({
        id: slot.id, label: slot.label, emoji: slot.emoji, from: slot.from, to: slot.to,
        topic: slot.topic, prompt: slot.prompt, current: slot.id === nowSlot,
        count: (store.posts || []).filter((p) => !p.hidden && slotOfDate(new Date(p.createdAt), timeZone) === slot.id).length,
      }));
      return sendJson(res, 200, { topics, current: nowSlot });
    }

    // 我的这周：把打卡、心事、收到的回应和陪伴整理成周报
    if (pathname === '/api/report/week' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      if (!validClientId(clientId)) return sendJson(res, 400, { error: '身份信息缺失。' });
      const timeZone = requestTimeZone(req, url);
      const now = new Date();
      const dates = [];
      for (let i = 6; i >= 0; i -= 1) dates.push(new Date(now.getTime() - i * 86400000));
      const daySet = new Set(dates.map((d) => dayKeyOf(d, timeZone)));
      const myMoods = (store.moods || []).filter((m) => m.clientId === clientId && daySet.has(m.day));
      const myPosts = (store.posts || []).filter((p) => p.clientId === clientId && daySet.has(dayKeyOf(new Date(p.createdAt), timeZone)));
      const myPostIds = new Set(myPosts.map((p) => p.id));
      let reactionsReceived = 0;
      let commentsReceived = 0;
      for (const p of store.posts || []) {
        if (!myPostIds.has(p.id)) continue;
        reactionsReceived += reactionCount(p);
        commentsReceived += (p.comments || []).filter((c) => c.clientId !== clientId).length;
      }
      const moodCounts = countMoods(myMoods);
      const leading = leadingMood(moodCounts);
      const slotCounts = MOOD_SLOTS.map((slot) => ({ id: slot.id, label: slot.label, emoji: slot.emoji, count: myMoods.filter((m) => moodSlotOfRecord(m, timeZone) === slot.id).length }));
      const pet = (store.pets || []).find((p) => p.clientId === clientId) || null;
      let summary = '这一周你还没有留下足迹，今晚可以从一个心情开始。';
      if (myMoods.length || myPosts.length) {
        summary = '这一周你写下了 ' + myPosts.length + ' 条心事，记录了 ' + myMoods.length + ' 次心情' +
          (leading ? '，最常出现的是「' + leading.emoji + ' ' + leading.label + '」' : '') +
          '。收到 ' + reactionsReceived + ' 个回应、' + commentsReceived + ' 条回音。';
      }
      return sendJson(res, 200, {
        range: { from: dayKeyOf(dates[0], timeZone), to: todayKey(timeZone) },
        summary, posts: myPosts.length, moods: myMoods.length, moodCounts, leadingMood: leading,
        slotCounts, reactionsReceived, commentsReceived,
        petInteractionDays: pet ? (pet.streak || 0) : 0,
        tips: [
          myPosts.length === 0 ? '试着在这个时段写下一句话，不必完整。' : '你已经留下了自己的声音。',
          reactionsReceived === 0 ? '去听听别人的心事，回一句「我懂」也会被记住。' : '有人听见了你。',
        ],
      });
    }

    // 心情打卡：同一天可以记录多个时段，同一时段可修改。
    if (pathname === '/api/mood' && method === 'POST') {
      const body = await readBody(req);
      const clientId = viewerClientId(req, body.clientId);
      if (!clientId) return sendJson(res, 400, { error: '身份信息缺失。' });
      const mood = MOODS.some((m) => m.id === body.mood) ? body.mood : null;
      if (!mood) return sendJson(res, 400, { error: '请选一个心情。' });
      const timeZone = requestTimeZone(req, url, body);
      const day = validDayKey(body.day) ? body.day : todayKey(timeZone);
      const slot = validMoodSlot(body.slot) ? body.slot : slotOfDate(new Date(), timeZone);
      const exist = store.moods.find((m) => m.clientId === clientId && m.day === day && moodSlotOfRecord(m, timeZone) === slot);
      if (exist) {
        exist.mood = mood;
        exist.slot = slot;
        exist.updatedAt = new Date().toISOString();
      } else {
        store.moods.push({ clientId, day, slot, mood, createdAt: new Date().toISOString() });
      }
      if (store.moods.length > 20000) store.moods = store.moods.slice(-20000);
      scheduleSave();
      return sendJson(res, 200, { ok: true, day, slot, mood, ...moodStats(day, clientId, slot, timeZone) });
    }

    if (pathname === '/api/mood/today' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      const timeZone = requestTimeZone(req, url);
      const day = validDayKey(url.searchParams.get('day')) ? url.searchParams.get('day') : todayKey(timeZone);
      const slot = validMoodSlot(url.searchParams.get('slot')) ? url.searchParams.get('slot') : slotOfDate(new Date(), timeZone);
      return sendJson(res, 200, { day, ...moodStats(day, clientId, slot, timeZone) });
    }

    if (pathname === '/api/mood/history' && method === 'GET') {
      const clientId = viewerClientId(req, url.searchParams.get('clientId'));
      const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days')) || 14));
      return sendJson(res, 200, moodHistory(clientId, days, requestTimeZone(req, url)));
    }

    // ---------------- 管理后台 ----------------
    if (pathname.startsWith('/api/admin/')) {
      const adminRole = adminAllowed(req);
      if (!adminRole) return sendJson(res, 401, { error: '管理令牌不正确。' });
      const adminMethod = method;
      const adminActorInfo = adminActor(req, adminRole);
      if (adminMethod !== 'GET' && adminRole === 'readonly') return sendJson(res, 403, { error: '只读管理员不能修改数据。' });

      if (pathname === '/api/admin/overview' && adminMethod === 'GET') {
        const openReports = (store.reports || []).filter((r) => r.status !== 'resolved');
        return sendJson(res, 200, {
          version: APP_VERSION, admin: true, role: adminRole,
          counts: {
            users: (store.users || []).length, posts: (store.posts || []).length,
            hidden: (store.posts || []).filter((p) => p.hidden).length,
            chats: (store.chats || []).length, moods: (store.moods || []).length,
            images: (store.images || []).length,
            imagesPending: (store.images || []).filter((i) => i.status === 'pending').length,
            reportsOpen: openReports.length,
            riskOpen: (store.riskEvents || []).filter((e) => e.status === 'open').length,
            riskHigh: (store.riskEvents || []).filter((e) => e.status !== 'resolved' && ['high', 'critical'].includes(e.level)).length,
            riskRestricted: (store.restrictions || []).filter((r) => !r.liftedAt && (!Number(r.until) || Number(r.until) > Date.now())).length,
          },
          latestReports: openReports.slice(-20).reverse(),
          latestLogs: (store.adminLogs || []).slice(-20).reverse(),
          permissions: { canWrite: canAdminWrite(adminRole, 'moderation'), canBackup: canAdminWrite(adminRole, 'backup'), canCleanup: adminRole === 'owner' },
        });
      }

      if (pathname === '/api/admin/reports' && adminMethod === 'GET') {
        const status = url.searchParams.get('status') || 'open';
        const targetType = url.searchParams.get('targetType') || '';
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 40));
        const all = (store.reports || [])
          .filter((r) => status === 'all' || r.status === status)
          .filter((r) => !targetType || (r.targetType || 'post') === targetType)
          .slice().reverse();
        const reports = all.slice((page - 1) * pageSize, page * pageSize);
        return sendJson(res, 200, { reports, total: all.length, page, pageSize, hasMore: page * pageSize < all.length });
      }

      if (pathname === '/api/admin/risk' && adminMethod === 'GET') {
        const status = url.searchParams.get('status') || 'active';
        const levelFilter = url.searchParams.get('level') || '';
        const subjectTypeFilter = url.searchParams.get('subjectType') || '';
        const q = clean(url.searchParams.get('q') || '', 80).toLowerCase();
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 40));
        const subjects = new Map();
        for (const event of (store.riskEvents || [])) {
          const type = event.subjectType === 'ip' ? 'ip' : 'client';
          const id = clean(String(event.subjectId || ''), 120);
          if (!id) continue;
          subjects.set(riskSubjectKey(type, id), { subjectType: type, subjectId: id });
        }
        for (const restriction of (store.restrictions || [])) {
          if (restriction.liftedAt || (Number(restriction.until) && Number(restriction.until) <= Date.now())) continue;
          const type = restriction.subjectType === 'ip' ? 'ip' : 'client';
          const id = clean(String(restriction.subjectId || ''), 120);
          if (!id) continue;
          subjects.set(riskSubjectKey(type, id), { subjectType: type, subjectId: id });
        }
        const profiles = Array.from(subjects.values()).map((subject) => {
          const profile = riskProfile(subject.subjectType, subject.subjectId);
          const restriction = activeRestriction(subject.subjectType, subject.subjectId);
          const events = (store.riskEvents || [])
            .filter((event) => riskSubjectKey(event.subjectType || 'client', event.subjectId) === profile.subjectKey)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          const last = events[0] || null;
          return {
            ...profile,
            restriction: restriction ? { kind: restriction.kind, until: restriction.until || null, createdAt: restriction.createdAt || null } : null,
            lastSurface: last ? last.surface : '',
            lastText: last ? last.text : '',
          };
        });
        const summary = {
          subjects: profiles.length,
          active: profiles.filter((profile) => profile.status !== 'clear').length,
          high: profiles.filter((profile) => ['high', 'critical'].includes(profile.level)).length,
          restricted: profiles.filter((profile) => profile.restriction).length,
        };
        const filtered = profiles.filter((profile) => {
          if (status === 'active' && profile.status === 'clear') return false;
          if (status !== 'all' && status !== 'active' && profile.status !== status) return false;
          if (levelFilter && profile.level !== levelFilter) return false;
          if (subjectTypeFilter && profile.subjectType !== subjectTypeFilter) return false;
          if (q) {
            const haystack = [profile.subjectId, profile.lastSurface, profile.lastText, Object.keys(profile.reasons || {}).join(' ')].join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
          }
          return true;
        }).sort((a, b) => (b.score - a.score) || (new Date(b.lastAt || 0) - new Date(a.lastAt || 0)));
        const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
        return sendJson(res, 200, { subjects: rows, total: filtered.length, page, pageSize, hasMore: page * pageSize < filtered.length, summary });
      }

      const adminRiskActionMatch = pathname.match(/^\/api\/admin\/risk\/(client|ip)\/([^/]+)\/action$/);
      if (adminRiskActionMatch && adminMethod === 'POST') {
        const subjectType = adminRiskActionMatch[1];
        const subjectId = decodeURIComponent(adminRiskActionMatch[2]);
        const body = await readBody(req);
        const action = String(body.action || '');
        if (!['watch', 'clear', 'mute', 'block', 'lift'].includes(action)) return sendJson(res, 400, { error: '不支持的风险处置动作。' });
        if (action === 'block' && adminRole !== 'owner') return sendJson(res, 403, { error: '只有站长可以执行拉黑。' });
        let changed = 0;
        const now = Date.now();
        if (action === 'watch' || action === 'clear') {
          for (const event of (store.riskEvents || [])) {
            if (riskSubjectKey(event.subjectType || 'client', event.subjectId) !== riskSubjectKey(subjectType, subjectId) || event.status === 'resolved') continue;
            event.status = action === 'watch' ? 'watching' : 'resolved';
            event.reviewedAt = new Date().toISOString();
            event.reviewedByRole = adminRole;
            changed += 1;
          }
        }
        if (action === 'mute' || action === 'block') {
          const until = action === 'mute' ? now + 24 * 60 * 60 * 1000 : 0;
          store.restrictions = store.restrictions || [];
          let restriction = store.restrictions.find((item) => item && item.subjectType === subjectType && item.subjectId === subjectId && !item.liftedAt && (!Number(item.until) || Number(item.until) > now));
          if (restriction) {
            restriction.kind = action;
            restriction.until = until;
            restriction.updatedAt = new Date().toISOString();
            restriction.updatedByRole = adminRole;
          } else {
            restriction = { id: rid(8), subjectType, subjectId, kind: action, until, createdAt: new Date().toISOString(), createdByRole: adminRole };
            store.restrictions.push(restriction);
          }
          if (store.restrictions.length > 2000) store.restrictions = store.restrictions.slice(-2000);
          changed += 1;
        }
        if (action === 'lift') {
          for (const restriction of (store.restrictions || [])) {
            if (restriction.subjectType !== subjectType || restriction.subjectId !== subjectId || restriction.liftedAt) continue;
            if (adminRole !== 'owner' && restriction.kind === 'block') return sendJson(res, 403, { error: '只有站长可以解除拉黑。' });
            restriction.liftedAt = new Date().toISOString();
            restriction.liftedByRole = adminRole;
            changed += 1;
          }
        }
        scheduleSave();
        adminLog('risk.' + action, subjectType + ':' + subjectId + ' changed=' + changed, adminActorInfo);
        return sendJson(res, 200, { ok: true, action, changed, profile: riskProfile(subjectType, subjectId), restriction: activeRestriction(subjectType, subjectId) });
      }

      const adminRiskDetailMatch = pathname.match(/^\/api\/admin\/risk\/(client|ip)\/([^/]+)$/);
      if (adminRiskDetailMatch && adminMethod === 'GET') {
        const subjectType = adminRiskDetailMatch[1];
        const subjectId = decodeURIComponent(adminRiskDetailMatch[2]);
        const events = (store.riskEvents || [])
          .filter((event) => riskSubjectKey(event.subjectType || 'client', event.subjectId) === riskSubjectKey(subjectType, subjectId))
          .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return sendJson(res, 200, { profile: riskProfile(subjectType, subjectId), events, restriction: activeRestriction(subjectType, subjectId) });
      }

      const adminReportMatch = pathname.match(/^\/api\/admin\/reports\/([A-Za-z0-9]+)$/);
      if (adminReportMatch && adminMethod === 'POST') {
        const body = await readBody(req);
        const report = (store.reports || []).find((r) => r.id === adminReportMatch[1]);
        if (!report) return sendJson(res, 404, { error: '举报不存在。' });
        report.status = 'resolved';
        report.resolvedAt = new Date().toISOString();
        report.resolution = clean(body.resolution, 120) || body.action || '已处理';
        report.resolvedByRole = adminRole;
        let event = null;
        let eventPayload = null;
        let eventClientIds = null;
        const actionAt = new Date().toISOString();
        if (body.action === 'hide') {
          const post = (store.posts || []).find((p) => p.id === report.postId);
          if (post) {
            post.hidden = true;
            post.hiddenAt = actionAt;
            event = 'feed';
            eventPayload = { action: 'hide', postId: post.id, source: 'admin-report' };
          }
        }
        if (body.action === 'delete_comment' && report.postId && report.commentId) {
          const post = (store.posts || []).find((p) => p.id === report.postId);
          const comment = post && (post.comments || []).find((c) => c.id === report.commentId);
          if (comment && !comment.deletedAt) {
            comment.deletedAt = actionAt;
            comment.text = '';
            comment.image = null;
            comment.imageThumb = null;
            event = 'feed';
            eventPayload = { action: 'comment-delete', postId: post.id, commentId: comment.id, source: 'admin-report' };
          }
        }
        if (body.action === 'block_chat' && report.chatId) {
          const chat = findChat(report.chatId);
          if (chat) {
            const aClientId = chat.a && chat.a.clientId;
            const bClientId = chat.b && chat.b.clientId;
            chat.status = 'blocked';
            chat.updatedAt = actionAt;
            if (validClientId(aClientId) && validClientId(bClientId)) {
              addBlock(aClientId, bClientId);
              addBlock(bClientId, aClientId);
            }
            event = 'block';
            eventPayload = { action: 'created', source: 'admin-report', chatId: chat.id };
            eventClientIds = [aClientId, bClientId].filter(validClientId);
          }
        }
        if (body.action === 'recall_message' && report.chatId && report.messageId) {
          const chat = findChat(report.chatId);
          const message = chat && (chat.messages || []).find((m) => m.id === report.messageId);
          if (message && !message.recalledAt) {
            message.recalledAt = actionAt;
            message.text = '';
            message.image = null;
            message.imageThumb = null;
            chat.updatedAt = actionAt;
            event = 'chat';
            eventPayload = { action: 'recall', chatId: chat.id, messageId: message.id, source: 'admin-report' };
            eventClientIds = [chat.a && chat.a.clientId, chat.b && chat.b.clientId].filter(validClientId);
          }
        }
        adminLog('report.resolve', report.id + ' ' + report.resolution, adminActorInfo);
        scheduleSave();
        if (event) broadcastEvent(event, eventPayload, eventClientIds);
        return sendJson(res, 200, { ok: true, report });
      }

      const adminPostMatch = pathname.match(/^\/api\/admin\/posts\/([A-Za-z0-9]+)$/);
      if (adminPostMatch && adminMethod === 'POST') {
        const body = await readBody(req);
        const post = (store.posts || []).find((p) => p.id === adminPostMatch[1]);
        if (!post) return sendJson(res, 404, { error: '心事不存在。' });
        if (body.action === 'hide') { post.hidden = true; post.hiddenAt = new Date().toISOString(); }
        if (body.action === 'restore') { post.hidden = false; post.reports = []; }
        adminLog('post.' + body.action, post.id, adminActorInfo);
        scheduleSave();
        broadcastEvent('feed', { action: body.action === 'hide' ? 'hide' : 'restore', postId: post.id });
        return sendJson(res, 200, { ok: true, post: { id: post.id, hidden: Boolean(post.hidden) } });
      }

      if (pathname === '/api/admin/image-cleanup' && adminMethod === 'GET') {
        return sendJson(res, 200, imageCleanupScan(IMAGE_RETENTION_DAYS));
      }

      if (pathname === '/api/admin/image-cleanup' && adminMethod === 'POST') {
        if (adminRole !== 'owner') return sendJson(res, 403, { error: '\u53ea\u6709\u7ad9\u957f\u53ef\u4ee5\u6267\u884c\u56fe\u7247\u6e05\u7406\u3002' });
        const result = cleanupUnusedImages(IMAGE_RETENTION_DAYS);
        adminLog('image.cleanup', 'deleted=' + result.deleted.length + ' bytes=' + result.freedBytes + ' retentionDays=' + IMAGE_RETENTION_DAYS, adminActorInfo);
        broadcastEvent('feed', { action: 'image-cleanup', deleted: result.deleted.length });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === '/api/admin/images' && adminMethod === 'GET') {
        const status = url.searchParams.get('status') || 'pending';
        const images = (store.images || []).filter((i) => status === 'all' || i.status === status).slice().reverse();
        return sendJson(res, 200, { images });
      }

      const adminImageMatch = pathname.match(/^\/api\/admin\/images\/([a-f0-9]{16,32}\.(?:png|jpg|gif|webp))\/(approve|block)$/);
      if (adminImageMatch && adminMethod === 'POST') {
        const rec = imageRecord(adminImageMatch[1]);
        if (!rec) return sendJson(res, 404, { error: '图片记录不存在。' });
        rec.status = adminImageMatch[2] === 'approve' ? 'approved' : 'blocked';
        rec.reviewedAt = new Date().toISOString();
        adminLog('image.' + rec.status, rec.name, adminActorInfo);
        scheduleSave();
        broadcastEvent('feed', { action: 'image', image: rec.name, status: rec.status });
        return sendJson(res, 200, { ok: true, image: rec });
      }

      if (pathname === '/api/admin/backups' && adminMethod === 'GET') {
        return sendJson(res, 200, { backups: listBackups() });
      }

      const adminBackupVerifyMatch = pathname.match(/^\/api\/admin\/backups\/([A-Za-z0-9-]+)\/verify$/);
      if (adminBackupVerifyMatch && adminMethod === 'POST') {
        if (!canAdminWrite(adminRole, 'backup')) return sendJson(res, 403, { error: '只有站长可以验证备份。' });
        const verification = verifyBackup(adminBackupVerifyMatch[1]);
        if (!verification.ok) return sendJson(res, 422, { error: verification.error, verification });
        adminLog('backup.verify', verification.name, adminActorInfo);
        return sendJson(res, 200, { ok: true, verification });
      }

      if (pathname === '/api/admin/backup' && adminMethod === 'POST') {
        if (!canAdminWrite(adminRole, 'backup')) return sendJson(res, 403, { error: '只有站长可以创建备份。' });
        const backup = createBackup();
        adminLog('backup', backup.name, adminActorInfo);
        return sendJson(res, 200, { ok: true, backup });
      }

      if (pathname === '/api/admin/logs' && adminMethod === 'GET') {
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize')) || 100));
        const all = (store.adminLogs || []).slice().reverse();
        return sendJson(res, 200, { logs: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize, hasMore: page * pageSize < all.length });
      }

      return sendJson(res, 404, { error: '管理接口不存在。' });
    }

    return sendJson(res, 404, { error: '接口不存在。' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || '请求失败。' });
  }
};

function emptyMoodCounts() {
  const counts = {};
  for (const mood of MOODS) counts[mood.id] = 0;
  return counts;
}

function countMoods(entries) {
  const counts = emptyMoodCounts();
  for (const entry of entries) {
    if (counts[entry.mood] !== undefined) counts[entry.mood] += 1;
  }
  return counts;
}

function leadingMood(counts) {
  let leading = null;
  for (const mood of MOODS) {
    const count = Number(counts[mood.id]) || 0;
    if (!leading || count > leading.count) {
      leading = { id: mood.id, label: mood.label, emoji: mood.emoji, count };
    }
  }
  return leading && leading.count > 0 ? leading : null;
}

function moodStats(day, clientId, requestedSlot, timeZone) {
  const activeSlot = validMoodSlot(requestedSlot) ? requestedSlot : slotOfDate(new Date(), timeZone);
  const dayMoods = store.moods.filter((m) => m && m.day === day);
  const slots = MOOD_SLOTS.map((slot) => {
    const entries = dayMoods.filter((m) => moodSlotOfRecord(m, timeZone) === slot.id);
    const counts = countMoods(entries);
    const mine = clientId ? entries.find((m) => m.clientId === clientId) : null;
    return {
      id: slot.id,
      label: slot.label,
      emoji: slot.emoji,
      counts,
      total: entries.length,
      leading: leadingMood(counts),
      myMood: mine ? mine.mood : null,
      mineAt: mine ? (mine.updatedAt || mine.createdAt || null) : null,
    };
  });
  const active = slots.find((slot) => slot.id === activeSlot) || slots[0];
  const myEntries = clientId ? dayMoods.filter((m) => m.clientId === clientId) : [];
  return {
    day,
    slot: activeSlot,
    counts: active.counts,
    total: active.total,
    myMood: active.myMood,
    dayTotal: dayMoods.length,
    slots,
    my: {
      total: myEntries.length,
      lastAt: myEntries.length ? (myEntries[myEntries.length - 1].updatedAt || myEntries[myEntries.length - 1].createdAt || null) : null,
      slots: myEntries
        .map((m) => ({ slot: moodSlotOfRecord(m, timeZone), mood: m.mood }))
        .sort((a, b) => MOOD_SLOTS.findIndex((s) => s.id === a.slot) - MOOD_SLOTS.findIndex((s) => s.id === b.slot)),
    },
  };
}

function moodHistory(clientId, days = 14, timeZone) {
  const count = Math.min(31, Math.max(1, Number(days) || 14));
  const now = new Date();
  const dates = [];
  for (let i = count - 1; i >= 0; i -= 1) dates.push(new Date(now.getTime() - i * 86400000));
  const allMine = clientId ? store.moods.filter((m) => m && m.clientId === clientId) : [];
  const weekdayFormatter = (() => {
    try { return new Intl.DateTimeFormat('zh-CN', { timeZone: validTimeZone(timeZone) ? timeZone : undefined, weekday: 'short' }); }
    catch { return null; }
  })();
  const daysOut = dates.map((date) => {
    const day = dayKeyOf(date, timeZone);
    const entries = allMine.filter((m) => m.day === day);
    const slots = MOOD_SLOTS.map((slot) => {
      const entry = entries.find((m) => moodSlotOfRecord(m, timeZone) === slot.id);
      return {
        id: slot.id,
        label: slot.label,
        emoji: slot.emoji,
        mood: entry ? entry.mood : null,
        createdAt: entry ? (entry.updatedAt || entry.createdAt || null) : null,
      };
    });
    return {
      day,
      label: (date.getMonth() + 1) + '/' + date.getDate(),
      weekday: weekdayFormatter ? weekdayFormatter.format(date) : '',
      total: entries.length,
      slots,
    };
  });
  let streak = 0;
  for (let i = daysOut.length - 1; i >= 0; i -= 1) {
    if (!daysOut[i].total) break;
    streak += 1;
  }
  return {
    days: daysOut,
    streak,
    totalDays: new Set(allMine.map((m) => m.day)).size,
    totalEntries: allMine.length,
  };
}

/* --------------------------------- 启动 ----------------------------------- */

ensureDirs();
loadStore();

function replaceStore(next) {
  store = normalizeStore(next);
}

function snapshotStore() {
  return store;
}

function clearPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

module.exports = {
  requestHandler,
  replaceStore,
  snapshotStore,
  flush,
  clearPendingSave,
  ensureDirs,
  STORE_FILE,
  UPLOAD_DIR,
};
