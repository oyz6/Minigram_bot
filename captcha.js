const htmlhead = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Captcha verify</title><script src="https://telegram.org/js/telegram-web-app.js"></script><style>body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto;background:linear-gradient(135deg,#f0f4ff 0%,#e8eeff 100%);display:flex;align-items:center;justify-content:center;min-height:100vh;}form{width:100%;max-width:420px;background:#fff;border:1px solid #e8eaf0;border-radius:14px;padding:28px;box-shadow:0 20px 40px rgba(0,0,0,.15);}form h2{margin:0 0 14px;font-size:1.75rem;font-weight:700;text-align:center;}.field{margin-bottom:14px;}#status{text-align:center;font-size:1rem;color:#6b7280;margin-top:14px;}#codeDisplay{width:100%;padding:12px 14px;font-size:0.9rem;border-radius:10px;border:1px solid #e5e7eb;background:#f8f9fb;color:#374151;outline:none;display:none;word-break:break-all;}.copy-btn{width:100%;padding:12px;font-size:1rem;border-radius:10px;border:none;cursor:pointer;background:#22c55e;color:#fff;margin-top:10px;display:none;}.copy-btn:hover{background:#16a34a}.send-btn{width:100%;padding:12px;font-size:1rem;border-radius:10px;border:none;cursor:pointer;background:#6366f1;color:#fff;margin-top:10px;display:none;}.send-btn:hover{background:#4f46e5}.open-bot-btn{display:none;width:100%;padding:12px;font-size:1rem;border-radius:10px;border:none;cursor:pointer;background:#3b82f6;color:#fff;margin-top:10px;text-decoration:none;text-align:center;}.open-bot-btn:hover{background:#2563eb}</style></head><body>`;

async function HMac_sum(message, key) {
  const enc = new TextEncoder();
  const keyData = enc.encode(key);
  const msgData = enc.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const bytes = new Uint8Array(signature);
  return btoa(String.fromCharCode(...bytes));
}

async function handlePost(request, env) {
  const body = await request.formData();
  const captcha = body.get('cf-turnstile-response');
  const token = body.get('token');
  const ip = request.headers.get('CF-Connecting-IP');

  let formData = new FormData();
  formData.append('secret', env.CAPTCHA_SECRET_KEY);
  formData.append('response', captcha);
  formData.append('remoteip', ip);

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    body: formData,
    method: 'POST',
  });

  const res = await result.json();
  if (!res.success) {
    return new Response(JSON.stringify({ ok: false, error: "Captcha fail" }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!token || token.length < 16 || token.length > 256) {
    return new Response(JSON.stringify({ ok: false, error: "Token is err" }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let parts = token.split("_");
  if (parts.length !== 2) {
    return new Response(JSON.stringify({ ok: false, error: "Token is err" }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let Unixtime = Math.floor(Date.now() / 1000 / 300);
  let timestamp = Unixtime + '';
  let prevTimestamp = (Unixtime - 1) + '';

  if (parts[1] !== timestamp && parts[1] !== prevTimestamp) {
    return new Response(JSON.stringify({ ok: false, error: "session Expire" }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (parts[0].length < 14) {
    return new Response(JSON.stringify({ ok: false, error: "Token is err" }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let tokenTimestamp = parts[1];
  let mySum = await HMac_sum(token, env.VERIFY_SECRET);
  let resp = parts[0].slice(0, 12) + '_' + tokenTimestamp + '_' + mySum;

  return new Response(JSON.stringify({ ok: true, code: `/checkin ${resp}` }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleGet(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get('token');

  if (!token) {
    return new Response("Token is null");
  }
  if (token.length < 12 || token.length > 256) {
    return new Response("Token is err");
  }

  let eToken = encodeURIComponent(token);
  const botUsername = env.BOT_USERNAME || '';

  let body = htmlhead + `<form id="vform" aria-label="Token Login"><h2>人机验证</h2><div class="field"><input type="hidden" id="token" name="token" value="${eToken}"></div><div class="field"><div class="cf-turnstile" data-sitekey="${env.CAPTCHA_SITE_KEY}" data-theme="light" data-callback="onTurnstileSuccess"></div></div><p id="status">请完成上方验证...</p><input type="text" id="codeDisplay" readonly aria-label="验证码"><button type="button" class="send-btn" id="sendBtn" onclick="sendToBot()">发送验证码到 Bot</button><button type="button" class="copy-btn" id="copyBtn" onclick="copyCode()">复制验证码</button><a class="open-bot-btn" id="openBotBtn" href="#" target="_blank" rel="noopener">打开 Bot 对话粘贴发送</a></form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
<script>
let verifyCode = '';
const botUsername = '${botUsername}';

// 检测是否在 Telegram WebApp 环境中
// WebApp 打开时 Telegram 会注入 initData 或在 hash 中包含 tgWebAppData
const isTgWebApp = (function() {
  if (window.location.hash.indexOf('tgWebAppData') !== -1) return true;
  if (window.Telegram && window.Telegram.WebApp) {
    const wd = window.Telegram.WebApp;
    if (wd.initData && wd.initData.length > 0) return true;
    if (wd.platform && wd.platform !== 'unknown') return true;
  }
  return false;
})();

if (isTgWebApp && window.Telegram && window.Telegram.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

function onTurnstileSuccess(turnstileToken) {
  document.getElementById('status').textContent = '验证中...';
  const formData = new FormData();
  formData.append('cf-turnstile-response', turnstileToken);
  formData.append('token', decodeURIComponent(document.getElementById('token').value));

  fetch(window.location.href, {
    method: 'POST',
    body: formData
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      verifyCode = data.code;
      if (isTgWebApp) {
        try {
          window.Telegram.WebApp.sendData(verifyCode);
          document.getElementById('status').textContent = '✅ 验证成功，窗口即将关闭...';
          setTimeout(function() { try { window.Telegram.WebApp.close(); } catch(e){} }, 1000);
        } catch(e) {
          showFallbackUI(true);
        }
      } else {
        showFallbackUI(false);
      }
    } else {
      document.getElementById('status').textContent = '❌ ' + (data.error || '验证失败，请刷新重试');
    }
  })
  .catch(function() {
    document.getElementById('status').textContent = '❌ 网络错误，请重试';
  });
}

function showFallbackUI(isWebAppFallback) {
  if (isWebAppFallback) {
    document.getElementById('status').textContent = '✅ 验证成功，请点击下方按钮发送验证码';
    document.getElementById('sendBtn').style.display = 'block';
  } else {
    document.getElementById('status').textContent = '✅ 验证成功，请复制验证码发送给 Bot';
  }
  document.getElementById('codeDisplay').style.display = 'block';
  document.getElementById('codeDisplay').value = verifyCode;
  document.getElementById('copyBtn').style.display = 'block';
  if (!isWebAppFallback && botUsername) {
    var botLink = document.getElementById('openBotBtn');
    botLink.href = 'https://t.me/' + botUsername;
    botLink.style.display = 'block';
  }
}

function sendToBot() {
  if (window.Telegram && window.Telegram.WebApp && verifyCode) {
    try {
      window.Telegram.WebApp.sendData(verifyCode);
      document.getElementById('status').textContent = '✅ 已发送，窗口即将关闭...';
      setTimeout(function() { try { window.Telegram.WebApp.close(); } catch(e){} }, 1000);
    } catch(e) {
      document.getElementById('status').textContent = '发送失败，请手动复制验证码发送给 Bot';
    }
  }
}

function copyCode() {
  navigator.clipboard.writeText(verifyCode).then(function() {
    document.getElementById('copyBtn').textContent = '已复制 ✅';
    setTimeout(function() { document.getElementById('copyBtn').textContent = '复制验证码'; }, 1500);
  });
}
</script></body></html>`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/html' },
  });
}

// Cloudflare Workers 入口
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      return await handlePost(request, env);
    }
    return handleGet(request, env);
  }
};
