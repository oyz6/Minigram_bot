以下是根据新整合的单 Worker 方案编写的部署文档，去掉了旧的 `register_bot.js` 和 `tg_worker.js`，只需两个 Worker：

---

## 部署 Turnstile 人机验证 + Telegram 私聊转发 Bot

### 所需变量一览
| 变量名 | 用途 | 示例值 |
|--------|------|--------|
| `Captcha_SECRET_KEY` | Cloudflare Turnstile 后端密钥 | `0x3...FF` |
| `Captcha_SITE_KEY` | Cloudflare Turnstile 前端密钥 | `3x0...FF` |
| `verify_SECRET` | HMAC 签名密钥（两个 Worker 必须一致） | `u0zcgbzN4vYJpEmzs0yR` |
| `BOT_TOKEN_ENV` | Telegram Bot Token | `123456789:ABC...` |
| `GROUP_ID_ENV` | 接收消息的群组 ID（带 `-100`） | `-1001234567890` |
| `MAX_MESSAGES_PER_MINUTE_ENV` | 每分钟消息速率限制 | `40` |
| `VERIFY_URL` | Turnstile 验证页面的完整 URL | `https://verify.example.com/myapp` |
| `VERIFY_SECRET` | 与 `verify_SECRET` 相同的 HMAC 密钥 | `u0zcgbzN4vYJpEmzs0yR` |

---

### 步骤 1：获取各类密钥和 ID

1. **Telegram Bot Token**  
   与 [@BotFather](https://t.me/BotFather) 对话创建 Bot，获取格式为 `123456789:ABCDEFGHIKabcnopqrstuvwxyzA` 的 Token。

2. **群组 ID**  
   将 Bot 拉入一个 **开启了话题模式** 的超级群组，并设为管理员。  
   使用 [@getidsbot](https://t.me/getidsbot) 或发送 `/chat_id@your_bot` 获取群组 ID（负数，带 `-100`）。

3. **Turnstile 密钥**  
   登录 Cloudflare，进入 Turnstile 页面，创建一个站点，获取 **Site Key** 和 **Secret Key**。

4. **HMAC 签名密钥**  
   在终端生成随机密钥（两个 Worker 共用）：  
   `openssl rand -base64 15`  
   或自定义字符串。

---

### 步骤 2：部署验证页面 Worker（`captcha.js`）

1. 在 Cloudflare Workers 中创建一个新的 Worker。
2. 将原始的 `captcha.js` 代码粘贴进去（你已有该代码）。
3. 在 Worker 设置 → **Variables** 中添加以下变量：
   - `Captcha_SECRET_KEY`：你的 Turnstile Secret Key
   - `Captcha_SITE_KEY`：你的 Turnstile Site Key
   - `verify_SECRET`：步骤 1 中生成的 HMAC 密钥
4. 部署，并记下 Worker 分配的 URL，例如 `https://verify.example.com/myapp`（这就是 `VERIFY_URL`）。

---

### 步骤 3：部署主 Bot Worker（整合代码）

1. 在 Cloudflare Workers 中创建另一个 Worker。
2. 将我们提供的**最终整合代码**（约 700 行，包含 `HMac_sum` 和所有逻辑）粘贴进去。
3. 绑定 D1 数据库：
   - 先在 Cloudflare 中创建一个 D1 数据库。
   - 在 Worker 设置 → **D1 数据库绑定** 中添加绑定，变量名设为 **`D1`**，选择刚创建的数据库。
4. 添加环境变量（在 Worker 设置 → **Variables**）：
   - `BOT_TOKEN_ENV`：你的 Bot Token
   - `GROUP_ID_ENV`：群组 ID（例如 `-1001234567890`）
   - `MAX_MESSAGES_PER_MINUTE_ENV`：每分钟消息限制（如 `40`）
   - `VERIFY_URL`：验证页面 URL（`https://verify.example.com/myapp`）
   - `VERIFY_SECRET`：与 `verify_SECRET` 相同的 HMAC 密钥
5. 部署 Worker。

---

### 步骤 4：初始化数据库与 Webhook

1. **初始化数据库表**  
   访问：`https://你的Worker域名/checkTables`  
   返回 `Database tables checked and repaired` 即成功。

2. **注册 Webhook**  
   访问：`https://你的Worker域名/registerWebhook`  
   返回 `Webhook set successfully` 即完成。

---

### 步骤 5：使用说明

- **用户验证**  
  - 用户私聊 Bot 发送 `/start`，会收到一个 Turnstile 验证链接。
  - 打开链接完成人机验证，复制页面显示的 `/checkin ...` 命令并发送给 Bot。
  - 验证通过后即可正常聊天，消息会转发到群组对应的话题中（每个用户独立话题）。

- **管理功能**  
  在群组中任意用户话题内发送 `/admin`，会弹出管理员面板，可进行：
  - 拉黑 / 解除拉黑
  - 开启 / 关闭验证码
  - 查询黑名单
  - 删除用户数据
  - 切换用户端 Raw 内容开关

- **重置用户**  
  在群组话题中发送 `/reset_user <chat_id>` 可清空该用户的状态（需管理员）。

- **验证有效期**  
  默认 24 小时，过期后用户需重新验证。

---

### 注意事项

- `VERIFY_SECRET` 与 `verify_SECRET` 必须完全一致，否则 `/checkin` 验证会失败。
- 群组必须开启话题模式，且 Bot 需拥有管理员权限（至少能管理消息、创建话题）。
- D1 数据库无需手动建表，首次部署后通过 `/checkTables` 自动创建。
- 若需要取消验证码，可在管理面板中关闭，此时所有用户可直接发送消息。

---

部署完成后，你的 Bot 就具备了 Turnstile 人机验证 + 自动话题转发的完整功能。
