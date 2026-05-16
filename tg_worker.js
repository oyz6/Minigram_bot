let BOT_TOKEN;
let GROUP_ID;
let MAX_MESSAGES_PER_MINUTE;
let VERIFY_URL;
let VERIFY_SECRET;

let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
let isInitialized = false;
const processedMessages = new Set();
const processedCallbacks = new Set();

const topicCreationLocks = new Map();

const settingsCache = new Map([
  ['verification_enabled', null]
]);

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
  clear() {
    this.cache.clear();
  }
}

const userInfoCache = new LRUCache(1000);
const topicIdCache = new LRUCache(1000);
const userStateCache = new LRUCache(1000);
const messageRateCache = new LRUCache(1000);

function randomHex(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function HMac_sum(message, key) {
  const enc = new TextEncoder();
  const keyData = enc.encode(key);
  const msgData = enc.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const bytes = new Uint8Array(signature);
  return btoa(String.fromCharCode(...bytes));
}

export default {
  async fetch(request, env) {
    BOT_TOKEN = env.BOT_TOKEN_ENV || null;
    GROUP_ID = env.GROUP_ID_ENV || null;
    MAX_MESSAGES_PER_MINUTE = env.MAX_MESSAGES_PER_MINUTE_ENV ? parseInt(env.MAX_MESSAGES_PER_MINUTE_ENV) : 40;
    VERIFY_URL = env.VERIFY_URL || '';
    VERIFY_SECRET = env.VERIFY_SECRET || '';

    if (!env.D1) {
      return new Response('Server configuration error: D1 database is not bound', { status: 500 });
    }

    if (!isInitialized) {
      await initialize(env.D1, request);
      isInitialized = true;
    }

    async function handleRequest(request) {
      if (!BOT_TOKEN || !GROUP_ID) {
        return new Response('Server configuration error: Missing required environment variables', { status: 500 });
      }

      const url = new URL(request.url);
      if (url.pathname === '/webhook') {
        try {
          const update = await request.json();
          await handleUpdate(update);
          return new Response('OK');
        } catch (error) {
          return new Response('Bad Request', { status: 400 });
        }
      } else if (url.pathname === '/registerWebhook') {
        return await registerWebhook(request);
      } else if (url.pathname === '/unRegisterWebhook') {
        return await unRegisterWebhook();
      } else if (url.pathname === '/checkTables') {
        await checkAndRepairTables(env.D1);
        return new Response('Database tables checked and repaired', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }

    async function initialize(d1, request) {
      await Promise.all([
        checkAndRepairTables(d1),
        autoRegisterWebhook(request),
        checkBotPermissions(),
        cleanExpiredVerificationCodes(d1)
      ]);
    }

    async function autoRegisterWebhook(request) {
      const webhookUrl = `${new URL(request.url).origin}/webhook`;
      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl }),
      });
    }

    async function checkBotPermissions() {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to access group: ${data.description}`);

      const memberResponse = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, user_id: (await getBotId()) })
      });
      const memberData = await memberResponse.json();
      if (!memberData.ok) throw new Error(`Failed to get bot member status: ${memberData.description}`);
    }

    async function getBotId() {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to get bot ID: ${data.description}`);
      return data.result.id;
    }

    async function checkAndRepairTables(d1) {
      const expectedTables = {
        user_states: {
          columns: {
            chat_id: 'TEXT PRIMARY KEY',
            is_blocked: 'BOOLEAN DEFAULT FALSE',
            is_verified: 'BOOLEAN DEFAULT FALSE',
            verified_expiry: 'INTEGER',
            code_expiry: 'INTEGER',
            is_first_verification: 'BOOLEAN DEFAULT TRUE',
            is_verifying: 'BOOLEAN DEFAULT FALSE'
          }
        },
        message_rates: {
          columns: {
            chat_id: 'TEXT PRIMARY KEY',
            message_count: 'INTEGER DEFAULT 0',
            window_start: 'INTEGER',
            start_count: 'INTEGER DEFAULT 0',
            start_window_start: 'INTEGER'
          }
        },
        chat_topic_mappings: {
          columns: {
            chat_id: 'TEXT PRIMARY KEY',
            topic_id: 'TEXT NOT NULL'
          }
        },
        settings: {
          columns: {
            key: 'TEXT PRIMARY KEY',
            value: 'TEXT'
          }
        }
      };

      for (const [tableName, structure] of Object.entries(expectedTables)) {
        const tableInfo = await d1.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
        ).bind(tableName).first();

        if (!tableInfo) {
          await createTable(d1, tableName, structure);
          continue;
        }

        const columnsResult = await d1.prepare(`PRAGMA table_info(${tableName})`).all();
        const currentColumns = new Map(columnsResult.results.map(col => [col.name, true]));

        for (const [colName, colDef] of Object.entries(structure.columns)) {
          if (!currentColumns.has(colName)) {
            const columnParts = colDef.split(' ');
            await d1.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${columnParts.slice(1).join(' ')}`);
          }
        }
      }

      await d1.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
        .bind('verification_enabled', 'true').run();

      settingsCache.set('verification_enabled', (await getSetting('verification_enabled', d1)) === 'true');
    }

    async function createTable(d1, tableName, structure) {
      const columnsDef = Object.entries(structure.columns)
        .map(([name, def]) => `${name} ${def}`)
        .join(', ');
      await d1.exec(`CREATE TABLE ${tableName} (${columnsDef})`);
    }

    async function cleanExpiredVerificationCodes(d1) {
      const now = Date.now();
      if (now - lastCleanupTime < CLEANUP_INTERVAL) return;

      const nowSeconds = Math.floor(now / 1000);
      const expired = await d1.prepare(
        'SELECT chat_id FROM user_states WHERE code_expiry IS NOT NULL AND code_expiry < ?'
      ).bind(nowSeconds).all();

      if (expired.results.length > 0) {
        await d1.batch(
          expired.results.map(({ chat_id }) =>
            d1.prepare('UPDATE user_states SET code_expiry = NULL, is_verifying = FALSE WHERE chat_id = ?').bind(chat_id)
          )
        );
      }
      lastCleanupTime = now;
    }

    async function handleUpdate(update) {
      if (update.message) {
        const messageId = update.message.message_id.toString();
        const chatId = update.message.chat.id.toString();
        const messageKey = `${chatId}:${messageId}`;

        if (processedMessages.has(messageKey)) return;
        processedMessages.add(messageKey);
        if (processedMessages.size > 10000) processedMessages.clear();

        await onMessage(update.message);
      } else if (update.callback_query) {
        await onCallbackQuery(update.callback_query);
      }
    }

    async function onMessage(message) {
      const chatId = message.chat.id.toString();
      const text = message.text || '';
      const messageId = message.message_id;

      // Web App 回传验证数据
      if (message.web_app_data && message.web_app_data.data) {
        const webAppText = message.web_app_data.data;
        if (webAppText.startsWith('/checkin ')) {
          await handleCheckinVerification(chatId, webAppText);
          return;
        }
      }

      // 群组消息
      if (chatId === GROUP_ID) {
        const topicId = message.message_thread_id;
        if (topicId) {
          const privateChatId = await getPrivateChatId(topicId);
          if (privateChatId && (text === '/admin' || text.startsWith('/admin@'))) {
            await sendAdminPanel(chatId, topicId, privateChatId, messageId);
            return;
          }
          if (privateChatId && text.startsWith('/reset_user')) {
            await handleResetUser(chatId, topicId, text);
            return;
          }
          if (privateChatId) {
            await forwardMessageToPrivateChat(privateChatId, message);
          }
        }
        return;
      }

      // 私聊用户
      let userState = userStateCache.get(chatId);
      if (userState === undefined) {
        userState = await env.D1.prepare('SELECT is_blocked, is_first_verification, is_verified, verified_expiry, is_verifying FROM user_states WHERE chat_id = ?')
          .bind(chatId).first();
        if (!userState) {
          userState = { is_blocked: false, is_first_verification: true, is_verified: false, verified_expiry: null, is_verifying: false };
          await env.D1.prepare('INSERT INTO user_states (chat_id, is_blocked, is_first_verification, is_verified, is_verifying) VALUES (?, ?, ?, ?, ?)')
            .bind(chatId, false, true, false, false).run();
        }
        userStateCache.set(chatId, userState);
      }

      if (userState.is_blocked) {
        await sendMessageToUser(chatId, "您已被拉黑，无法发送消息。");
        return;
      }

      const verificationEnabled = (await getSetting('verification_enabled', env.D1)) === 'true';

      if (verificationEnabled) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const isVerified = userState.is_verified && userState.verified_expiry && nowSeconds < userState.verified_expiry;

        if (!isVerified) {
          if (text.startsWith('/checkin ')) {
            await handleCheckinVerification(chatId, text);
            return;
          }
          await handleVerification(chatId);
          return;
        }

        // 已验证用户检查频率
        if (!userState.is_first_verification) {
          const isRateLimited = await checkMessageRate(chatId);
          if (isRateLimited) {
            await env.D1.prepare('UPDATE user_states SET is_verified = FALSE, is_verifying = FALSE WHERE chat_id = ?')
              .bind(chatId).run();
            userState.is_verified = false;
            userState.is_verifying = false;
            userStateCache.set(chatId, userState);
            await sendMessageToUser(chatId, '消息发送过于频繁，请重新完成验证。');
            await handleVerification(chatId);
            return;
          }
        }
      }

      if (text === '/start') {
        if (await checkStartCommandRate(chatId)) {
          await sendMessageToUser(chatId, "您发送 /start 过于频繁，请稍后再试。");
          return;
        }
        await sendMessageToUser(chatId, '欢迎使用私聊机器人，现在可以发送消息了！');
        const userInfo = await getUserInfo(chatId);
        await ensureUserTopic(chatId, userInfo);
        return;
      }

      if (text.startsWith('/checkin ')) {
        await sendMessageToUser(chatId, '您已通过验证，无需再次验证。');
        return;
      }

      const userInfo = await getUserInfo(chatId);
      if (!userInfo) {
        await sendMessageToUser(chatId, "无法获取用户信息，请稍后再试。");
        return;
      }

      let topicId = await ensureUserTopic(chatId, userInfo);
      if (!topicId) {
        await sendMessageToUser(chatId, "无法创建话题，请稍后再试。");
        return;
      }

      const isTopicValid = await validateTopic(topicId);
      if (!isTopicValid) {
        await env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).run();
        topicIdCache.set(chatId, undefined);
        topicId = await ensureUserTopic(chatId, userInfo);
        if (!topicId) {
          await sendMessageToUser(chatId, "无法重新创建话题，请稍后再试。");
          return;
        }
      }

      const nickname = userInfo.nickname || userInfo.username || `User_${chatId}`;

      if (text) {
        await sendMessageToTopic(topicId, `${nickname}:\n${text}`);
      } else {
        await copyMessageToTopic(topicId, message);
      }
    }

    async function handleCheckinVerification(chatId, text) {
      const result = text.substring('/checkin '.length).trim();

      if (result.length < 12 || result.length > 256) {
        await sendMessageToUser(chatId, '验证码格式错误。');
        return;
      }

      const parts = result.split('_');
      if (parts.length !== 3 || parts[0].length !== 12) {
        await sendMessageToUser(chatId, '验证码格式错误。');
        return;
      }

      const Unixtime = Math.floor(Date.now() / 1000 / 300);
      const timestamp = Unixtime + '';
      const prevTimestamp = (Unixtime - 1) + '';

      if (parts[1] !== timestamp && parts[1] !== prevTimestamp) {
        await sendMessageToUser(chatId, '验证码已过期，请重新验证。');
        await handleVerification(chatId);
        return;
      }

      const tokenTimestamp = parts[1];
      const orig_token = parts[0] + chatId + '_' + tokenTimestamp;
      const expectedHmac = await HMac_sum(orig_token, VERIFY_SECRET);

      if (expectedHmac === parts[2]) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const verifiedExpiry = nowSeconds + 3600 * 24;

        await env.D1.prepare('UPDATE user_states SET is_verified = ?, verified_expiry = ?, is_first_verification = ?, is_verifying = ? WHERE chat_id = ?')
          .bind(true, verifiedExpiry, false, false, chatId).run();

        let userState = userStateCache.get(chatId) || {};
        userState.is_verified = true;
        userState.verified_expiry = verifiedExpiry;
        userState.is_first_verification = false;
        userState.is_verifying = false;
        userStateCache.set(chatId, userState);

        const nowMs = Date.now();
        await env.D1.prepare('UPDATE message_rates SET message_count = 0, window_start = ? WHERE chat_id = ?')
          .bind(nowMs, chatId).run();
        messageRateCache.set(chatId, { message_count: 0, window_start: nowMs, start_count: 0, start_window_start: nowMs });

        await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '✅ 验证成功！现在可以发送消息了。',
            reply_markup: { remove_keyboard: true }
          })
        });

        const userInfo = await getUserInfo(chatId);
        await ensureUserTopic(chatId, userInfo);
      } else {
        await sendMessageToUser(chatId, '验证失败，签名不匹配。请重新验证。');
        await handleVerification(chatId);
      }
    }

    async function handleVerification(chatId) {
      if (!VERIFY_URL || !VERIFY_SECRET) {
        await sendMessageToUser(chatId, '验证服务未配置，请联系管理员。');
        return;
      }

      try {
        const Unixtime = Math.floor(Date.now() / 1000 / 300);
        const timestamp = Unixtime + '';
        const token = randomHex(12) + chatId + '_' + timestamp;
        const verifyLink = `${VERIFY_URL}?token=${encodeURIComponent(token)}`;

        const nowSeconds = Math.floor(Date.now() / 1000);
        const codeExpiry = nowSeconds + 300;

        await env.D1.prepare('UPDATE user_states SET is_verifying = ?, code_expiry = ? WHERE chat_id = ?')
          .bind(true, codeExpiry, chatId).run();

        let userState = userStateCache.get(chatId) || {};
        userState.is_verifying = true;
        userStateCache.set(chatId, userState);

        await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '🔐 请点击下方按钮完成人机验证（5分钟内有效）\n\n如按钮无法使用，请在浏览器中打开：\n' + verifyLink,
            reply_markup: {
              keyboard: [[{ text: '✅ 点击验证', web_app: { url: verifyLink } }]],
              resize_keyboard: true,
              one_time_keyboard: true
            }
          })
        });
      } catch (error) {
        await env.D1.prepare('UPDATE user_states SET is_verifying = FALSE WHERE chat_id = ?').bind(chatId).run();
        let userState = userStateCache.get(chatId) || {};
        userState.is_verifying = false;
        userStateCache.set(chatId, userState);
        await sendMessageToUser(chatId, '发送验证失败，请发送任意消息重试。');
      }
    }

    async function validateTopic(topicId) {
      try {
        const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: GROUP_ID, message_thread_id: topicId, text: "检测中", disable_notification: true })
        });
        const data = await response.json();
        if (data.ok) {
          await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: GROUP_ID, message_id: data.result.message_id })
          });
          return true;
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    async function ensureUserTopic(chatId, userInfo) {
      let lock = topicCreationLocks.get(chatId);
      if (!lock) { lock = Promise.resolve(); topicCreationLocks.set(chatId, lock); }

      try {
        await lock;
        let topicId = await getExistingTopicId(chatId);
        if (topicId) return topicId;

        const newLock = (async () => {
          const nickname = userInfo.nickname || userInfo.username || `User_${chatId}`;
          const userName = userInfo.username || `User_${chatId}`;
          topicId = await createForumTopic(nickname, userName, chatId);
          await saveTopicId(chatId, topicId);
          return topicId;
        })();

        topicCreationLocks.set(chatId, newLock);
        return await newLock;
      } finally {
        if (topicCreationLocks.get(chatId) === lock) topicCreationLocks.delete(chatId);
      }
    }

    async function handleResetUser(chatId, topicId, text) {
      const isAdmin = await checkIfAdmin(chatId);
      if (!isAdmin) { await sendMessageToTopic(topicId, '只有管理员可以使用此功能。'); return; }

      const parts = text.split(' ');
      if (parts.length !== 2) { await sendMessageToTopic(topicId, '用法：/reset_user <chat_id>'); return; }

      const targetChatId = parts[1];
      await env.D1.batch([
        env.D1.prepare('DELETE FROM user_states WHERE chat_id = ?').bind(targetChatId),
        env.D1.prepare('DELETE FROM message_rates WHERE chat_id = ?').bind(targetChatId),
        env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(targetChatId)
      ]);
      userStateCache.set(targetChatId, undefined);
      messageRateCache.set(targetChatId, undefined);
      topicIdCache.set(targetChatId, undefined);
      await sendMessageToTopic(topicId, `用户 ${targetChatId} 的状态已重置。`);
    }

    async function sendAdminPanel(chatId, topicId, privateChatId, messageId) {
      const verificationEnabled = (await getSetting('verification_enabled', env.D1)) === 'true';

      const buttons = [
        [
          { text: '拉黑用户', callback_data: `block_${privateChatId}` },
          { text: '解除拉黑', callback_data: `unblock_${privateChatId}` }
        ],
        [
          { text: verificationEnabled ? '关闭验证码' : '开启验证码', callback_data: `toggle_verification_${privateChatId}` },
          { text: '查询黑名单', callback_data: `check_blocklist_${privateChatId}` }
        ],
        [
          { text: '删除用户', callback_data: `delete_user_${privateChatId}` }
        ]
      ];

      await Promise.all([
        fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId, message_thread_id: topicId,
            text: '管理员面板：请选择操作',
            reply_markup: { inline_keyboard: buttons }
          })
        }),
        fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        })
      ]);
    }

    function getNotificationContent() {
      return `管理员命令：在话题中发送 /admin 打开管理面板`;
    }

    async function checkStartCommandRate(chatId) {
      const now = Date.now();
      const window = 5 * 60 * 1000;

      let data = messageRateCache.get(chatId);
      if (data === undefined) {
        data = await env.D1.prepare('SELECT start_count, start_window_start FROM message_rates WHERE chat_id = ?')
          .bind(chatId).first();
        if (!data) {
          data = { start_count: 0, start_window_start: now };
          await env.D1.prepare('INSERT INTO message_rates (chat_id, start_count, start_window_start) VALUES (?, ?, ?)')
            .bind(chatId, 0, now).run();
        }
        messageRateCache.set(chatId, data);
      }

      if (now - data.start_window_start > window) {
        data.start_count = 1;
        data.start_window_start = now;
      } else {
        data.start_count += 1;
      }

      await env.D1.prepare('UPDATE message_rates SET start_count = ?, start_window_start = ? WHERE chat_id = ?')
        .bind(data.start_count, data.start_window_start, chatId).run();
      messageRateCache.set(chatId, data);
      return data.start_count > 1;
    }

    async function checkMessageRate(chatId) {
      const now = Date.now();
      const window = 60 * 1000;

      let data = messageRateCache.get(chatId);
      if (data === undefined) {
        data = await env.D1.prepare('SELECT message_count, window_start FROM message_rates WHERE chat_id = ?')
          .bind(chatId).first();
        if (!data) {
          data = { message_count: 0, window_start: now };
          await env.D1.prepare('INSERT INTO message_rates (chat_id, message_count, window_start) VALUES (?, ?, ?)')
            .bind(chatId, 0, now).run();
        }
        messageRateCache.set(chatId, data);
      }

      if (now - data.window_start > window) {
        data.message_count = 1;
        data.window_start = now;
      } else {
        data.message_count += 1;
      }

      await env.D1.prepare('UPDATE message_rates SET message_count = ?, window_start = ? WHERE chat_id = ?')
        .bind(data.message_count, data.window_start, chatId).run();
      messageRateCache.set(chatId, data);
      return data.message_count > MAX_MESSAGES_PER_MINUTE;
    }

    async function getSetting(key, d1) {
      const result = await d1.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
      return result?.value || null;
    }

    async function setSetting(key, value) {
      await env.D1.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
      if (key === 'verification_enabled') {
        settingsCache.set('verification_enabled', value === 'true');
        if (value === 'false') {
          const nowSeconds = Math.floor(Date.now() / 1000);
          const verifiedExpiry = nowSeconds + 3600 * 24;
          await env.D1.prepare('UPDATE user_states SET is_verified = ?, verified_expiry = ?, is_verifying = FALSE WHERE is_blocked = FALSE')
            .bind(true, verifiedExpiry).run();
          userStateCache.clear();
        }
      }
    }

    async function onCallbackQuery(callbackQuery) {
      const chatId = callbackQuery.message.chat.id.toString();
      const topicId = callbackQuery.message.message_thread_id;
      const data = callbackQuery.data;
      const messageId = callbackQuery.message.message_id;
      const callbackKey = `${chatId}:${callbackQuery.id}`;

      if (processedCallbacks.has(callbackKey)) return;
      processedCallbacks.add(callbackKey);

      let action, privateChatId;

      if (data.startsWith('toggle_verification_')) {
        action = 'toggle_verification';
        privateChatId = data.slice('toggle_verification_'.length);
      } else if (data.startsWith('check_blocklist_')) {
        action = 'check_blocklist';
        privateChatId = data.slice('check_blocklist_'.length);
      } else if (data.startsWith('delete_user_')) {
        action = 'delete_user';
        privateChatId = data.slice('delete_user_'.length);
      } else if (data.startsWith('block_')) {
        action = 'block';
        privateChatId = data.slice('block_'.length);
      } else if (data.startsWith('unblock_')) {
        action = 'unblock';
        privateChatId = data.slice('unblock_'.length);
      } else {
        action = data;
        privateChatId = '';
      }

      const senderId = callbackQuery.from.id.toString();
      const isAdmin = await checkIfAdmin(senderId);
      if (!isAdmin) {
        await sendMessageToTopic(topicId, '只有管理员可以使用此功能。');
        await sendAdminPanel(chatId, topicId, privateChatId, messageId);
        return;
      }

      if (action === 'block') {
        await env.D1.prepare('INSERT OR REPLACE INTO user_states (chat_id, is_blocked) VALUES (?, ?)')
          .bind(privateChatId, true).run();
        let state = userStateCache.get(privateChatId) || {};
        state.is_blocked = true;
        userStateCache.set(privateChatId, state);
        await sendMessageToTopic(topicId, `用户 ${privateChatId} 已被拉黑。`);
      } else if (action === 'unblock') {
        await env.D1.prepare('UPDATE user_states SET is_blocked = FALSE, is_first_verification = TRUE WHERE chat_id = ?')
          .bind(privateChatId).run();
        let state = userStateCache.get(privateChatId) || {};
        state.is_blocked = false;
        state.is_first_verification = true;
        userStateCache.set(privateChatId, state);
        await sendMessageToTopic(topicId, `用户 ${privateChatId} 已解除拉黑。`);
      } else if (action === 'toggle_verification') {
        const currentState = (await getSetting('verification_enabled', env.D1)) === 'true';
        const newState = !currentState;
        await setSetting('verification_enabled', newState.toString());
        await sendMessageToTopic(topicId, `验证码功能已${newState ? '开启' : '关闭'}。`);
      } else if (action === 'check_blocklist') {
        const blockedUsers = await env.D1.prepare('SELECT chat_id FROM user_states WHERE is_blocked = TRUE').all();
        const blockList = blockedUsers.results.length > 0
          ? blockedUsers.results.map(row => row.chat_id).join('\n')
          : '当前没有被拉黑的用户。';
        await sendMessageToTopic(topicId, `黑名单列表：\n${blockList}`);
      } else if (action === 'delete_user') {
        await env.D1.batch([
          env.D1.prepare('DELETE FROM user_states WHERE chat_id = ?').bind(privateChatId),
          env.D1.prepare('DELETE FROM message_rates WHERE chat_id = ?').bind(privateChatId),
          env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(privateChatId)
        ]);
        userStateCache.set(privateChatId, undefined);
        messageRateCache.set(privateChatId, undefined);
        topicIdCache.set(privateChatId, undefined);
        await sendMessageToTopic(topicId, `用户 ${privateChatId} 的所有数据已删除。`);
      }

      await sendAdminPanel(chatId, topicId, privateChatId, messageId);

      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id })
      });
    }

    async function checkIfAdmin(userId) {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, user_id: userId })
      });
      const data = await response.json();
      return data.ok && (data.result.status === 'administrator' || data.result.status === 'creator');
    }

    async function getUserInfo(chatId) {
      let userInfo = userInfoCache.get(chatId);
      if (userInfo !== undefined) return userInfo;

      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId })
      });
      const data = await response.json();
      if (!data.ok) {
        userInfo = { id: chatId, username: `User_${chatId}`, nickname: `User_${chatId}` };
      } else {
        const result = data.result;
        const nickname = result.first_name
          ? `${result.first_name}${result.last_name ? ` ${result.last_name}` : ''}`.trim()
          : result.username || `User_${chatId}`;
        userInfo = {
          id: result.id || chatId,
          username: result.username || `User_${chatId}`,
          nickname: nickname
        };
      }

      userInfoCache.set(chatId, userInfo);
      return userInfo;
    }

    async function getExistingTopicId(chatId) {
      let topicId = topicIdCache.get(chatId);
      if (topicId !== undefined) return topicId;

      const result = await env.D1.prepare('SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?')
        .bind(chatId).first();
      topicId = result?.topic_id || null;
      if (topicId) topicIdCache.set(chatId, topicId);
      return topicId;
    }

    async function createForumTopic(nickname, userName, userId) {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, name: nickname })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to create forum topic: ${data.description}`);
      const topicId = data.result.message_thread_id;

      const now = new Date();
      const formattedTime = now.toISOString().replace('T', ' ').substring(0, 19);
      const notificationContent = getNotificationContent();
      const pinnedMessage = `昵称: ${nickname}\n用户名: @${userName}\nUserID: ${userId}\n发起时间: ${formattedTime}\n\n${notificationContent}`;
      const messageResponse = await sendMessageToTopic(topicId, pinnedMessage);
      const msgId = messageResponse.result.message_id;
      await pinMessage(topicId, msgId);

      return topicId;
    }

    async function saveTopicId(chatId, topicId) {
      await env.D1.prepare('INSERT OR REPLACE INTO chat_topic_mappings (chat_id, topic_id) VALUES (?, ?)')
        .bind(chatId, topicId).run();
      topicIdCache.set(chatId, topicId);
    }

    async function getPrivateChatId(topicId) {
      for (const [chatId, tid] of topicIdCache.cache) if (tid === topicId) return chatId;
      const mapping = await env.D1.prepare('SELECT chat_id FROM chat_topic_mappings WHERE topic_id = ?')
        .bind(topicId).first();
      return mapping?.chat_id || null;
    }

    async function sendMessageToTopic(topicId, text) {
      if (!text.trim()) throw new Error('Message text is empty');
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, text: text, message_thread_id: topicId })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to send message to topic: ${data.description}`);
      return data;
    }

    async function copyMessageToTopic(topicId, message) {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, from_chat_id: message.chat.id, message_id: message.message_id, message_thread_id: topicId, disable_notification: true })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to copy message to topic: ${data.description}`);
    }

    async function pinMessage(topicId, messageId) {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, message_id: messageId, message_thread_id: topicId })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to pin message: ${data.description}`);
    }

    async function forwardMessageToPrivateChat(privateChatId, message) {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: privateChatId, from_chat_id: message.chat.id, message_id: message.message_id, disable_notification: true })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to forward message: ${data.description}`);
    }

    async function sendMessageToUser(chatId, text) {
      const response = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Failed to send message to user: ${data.description}`);
    }

    async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
      for (let i = 0; i < retries; i++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(url, { ...options, signal: controller.signal });
          clearTimeout(timeoutId);

          if (response.ok) return response;
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After') || 5;
            await new Promise(resolve => setTimeout(resolve, parseInt(retryAfter) * 1000));
            continue;
          }
          throw new Error(`Request failed with status ${response.status}`);
        } catch (error) {
          if (i === retries - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, backoff * Math.pow(2, i)));
        }
      }
      throw new Error(`Failed to fetch after ${retries} retries`);
    }

    async function registerWebhook(request) {
      const webhookUrl = `${new URL(request.url).origin}/webhook`;
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl })
      }).then(r => r.json());
      return new Response(response.ok ? 'Webhook set successfully' : JSON.stringify(response, null, 2));
    }

    async function unRegisterWebhook() {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: '' })
      }).then(r => r.json());
      return new Response(response.ok ? 'Webhook removed' : JSON.stringify(response, null, 2));
    }

    try {
      return await handleRequest(request);
    } catch (error) {
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
