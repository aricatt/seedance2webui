/**
 * ModelToo 管理接口客户端：分组列表、分组成员。
 * 优先使用 MODELTOO_ADMIN_TOKEN；否则用 MODELTOO_ADMIN_USERNAME + MODELTOO_ADMIN_PASSWORD 自动登录并缓存 JWT。
 */

function decodeJwtExpMs(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

let tokenCache = { token: '', expiresAtMs: 0 };

/**
 * 获取用于调用 ModelToo /admin/* 的 Bearer Token
 */
export async function getModelTooAdminBearer() {
  const apiUrl = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
  const staticToken = (process.env.MODELTOO_ADMIN_TOKEN || '').trim();
  const username = (process.env.MODELTOO_ADMIN_USERNAME || '').trim();
  const password = (process.env.MODELTOO_ADMIN_PASSWORD || '').trim();

  if (!apiUrl) {
    throw new Error('未配置 MODELTOO_API_URL');
  }

  if (staticToken.length > 20) {
    return staticToken;
  }

  if (!username || !password) {
    throw new Error(
      '请配置 MODELTOO_ADMIN_USERNAME / MODELTOO_ADMIN_PASSWORD，或在 .env 中设置 MODELTOO_ADMIN_TOKEN'
    );
  }

  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAtMs > now + 30_000) {
    return tokenCache.token;
  }

  const resp = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
    throw new Error(`ModelToo 管理员登录失败 HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const token = data.access_token;
  if (!token) {
    throw new Error('ModelToo 登录响应缺少 access_token');
  }

  let expMs = decodeJwtExpMs(token);
  if (!expMs) {
    expMs = now + 50 * 60 * 1000;
  }
  // 提前 2 分钟刷新，避免边界过期
  tokenCache = { token, expiresAtMs: expMs - 120_000 };

  return token;
}

export async function fetchModelTooGroups(apiUrl) {
  const base = apiUrl.replace(/\/+$/, '');
  const adminToken = await getModelTooAdminBearer();
  const resp = await fetch(`${base}/api/v1/admin/groups?skip=0&limit=500&include_inactive=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo 分组列表失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  return body.items || [];
}

export async function fetchModelTooGroupUsers(apiUrl, groupId) {
  const base = apiUrl.replace(/\/+$/, '');
  const adminToken = await getModelTooAdminBearer();
  const resp = await fetch(`${base}/api/v1/admin/groups/${groupId}/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo 分组成员失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  if (body && Array.isArray(body.users)) return body.users;
  return [];
}

/**
 * 分页扫描 ModelToo 用户表，按 username / email（忽略大小写与首尾空格）匹配 SD 登录名 users.email。
 */
export async function findModelTooUserIdByLoginHint(apiUrl, hint) {
  const base = apiUrl.replace(/\/+$/, '');
  const h = String(hint || '').trim().toLowerCase();
  if (!h || !base) return null;

  try {
    const adminToken = await getModelTooAdminBearer();
    const limit = 100;
    let skip = 0;
    for (;;) {
      const resp = await fetch(`${base}/api/v1/admin/users?skip=${skip}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!resp.ok) {
        return null;
      }
      const body = await resp.json().catch(() => ({}));
      const items = Array.isArray(body.items) ? body.items : [];
      for (const u of items) {
        const un = String(u.username || '').trim().toLowerCase();
        const em = String(u.email || '').trim().toLowerCase();
        if (un === h || em === h) {
          return u.id != null ? String(u.id) : null;
        }
        if (em.includes('@')) {
          const local = em.split('@')[0];
          if (local === h) return u.id != null ? String(u.id) : null;
        }
      }
      if (items.length < limit) break;
      skip += limit;
      if (skip > 20000) break;
    }
  } catch {
    return null;
  }
  return null;
}
