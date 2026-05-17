/**
 * ModelToo 内部接口客户端：consume_budget, projects, my-balance
 * 使用 X-Internal-Token 认证
 */

/**
 * 通过 email 获取用户 UUID
 */
async function getUserIdFromEmail(email) {
  const apiUrl = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
  const internalToken = (process.env.MODELTOO_INTERNAL_TOKEN || '').trim();

  if (!apiUrl) {
    throw new Error('未配置 MODELTOO_API_URL');
  }
  if (!internalToken) {
    throw new Error('未配置 MODELTOO_INTERNAL_TOKEN');
  }

  const resp = await fetch(`${apiUrl}/api/v1/internal/users?email=${encodeURIComponent(email)}`, {
    headers: {
      'X-Internal-Token': internalToken,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo get_user_id failed HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = await resp.json();
  if (body.items && body.items.length > 0) {
    return body.items[0].id;
  }
  throw new Error('用户不存在');
}

export async function consumeBudget({
  projectId,
  amount,
  idempotencyKey,
  userId,
  actorUserId,
  source = 'sd',
  metadata = null,
  allowNegative = false,
}) {
  const apiUrl = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
  const internalToken = (process.env.MODELTOO_INTERNAL_TOKEN || '').trim();

  if (!apiUrl) {
    throw new Error('未配置 MODELTOO_API_URL');
  }
  if (!internalToken) {
    throw new Error('未配置 MODELTOO_INTERNAL_TOKEN');
  }

  const body = {
    project_id: projectId,
    amount,
    idempotency_key: idempotencyKey,
    source,
    allow_negative: allowNegative,
  };
  if (userId) body.user_id = userId;
  if (actorUserId) body.actor_user_id = actorUserId;
  if (metadata) body.metadata = metadata;

  const resp = await fetch(`${apiUrl}/api/v1/internal/budget/consume`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': internalToken,
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 402) {
    const data = await resp.json().catch(() => ({}));
    const err = new Error('余额不足');
    err.status = 402;
    err.detail = data;
    throw err;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo consume 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

export async function listProjects(userId) {
  const apiUrl = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
  const internalToken = (process.env.MODELTOO_INTERNAL_TOKEN || '').trim();

  if (!apiUrl) {
    throw new Error('未配置 MODELTOO_API_URL');
  }
  if (!internalToken) {
    throw new Error('未配置 MODELTOO_INTERNAL_TOKEN');
  }

  const resp = await fetch(`${apiUrl}/api/v1/internal/projects?user_id=${userId}`, {
    headers: {
      'X-Internal-Token': internalToken,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo list_projects 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = await resp.json();
  return body.items || [];
}

export async function getMyBalance(userId) {
  const apiUrl = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
  const internalToken = (process.env.MODELTOO_INTERNAL_TOKEN || '').trim();

  if (!apiUrl) {
    throw new Error('未配置 MODELTOO_API_URL');
  }
  if (!internalToken) {
    throw new Error('未配置 MODELTOO_INTERNAL_TOKEN');
  }

  const resp = await fetch(`${apiUrl}/api/v1/internal/budget/my-balance?user_id=${userId}`, {
    headers: {
      'X-Internal-Token': internalToken,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo get_my_balance 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = await resp.json();
  return body.items || [];
}

export async function getProjectsWithBalance(userId) {
  const apiUrl = (process.env.MODELTOO_API_URL || '').replace(/\/+$/, '');
  const internalToken = (process.env.MODELTOO_INTERNAL_TOKEN || '').trim();

  if (!apiUrl) {
    throw new Error('未配置 MODELTOO_API_URL');
  }
  if (!internalToken) {
    throw new Error('未配置 MODELTOO_INTERNAL_TOKEN');
  }

  const resp = await fetch(`${apiUrl}/api/v1/internal/projects-with-balance?user_id=${userId}`, {
    headers: {
      'X-Internal-Token': internalToken,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ModelToo get_projects_with_balance 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = await resp.json();
  return body.items || [];
}
