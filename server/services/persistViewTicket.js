/**
 * Short-lived HMAC tickets authorizing GET /api/tos/persist-image
 * (browser img src cannot send Bearer token).
 *
 * 类似 ModelTooNX 的 persist_view_ticket.py
 */

import crypto from 'crypto';

/**
 * 获取签名密钥
 * 优先使用 JWT_SECRET，否则使用 TOS_SECRET_ACCESS_KEY，最后使用默认值
 */
function getSigningKey() {
  const jwtSecret = (process.env.JWT_SECRET || process.env.MODELTOO_JWT_SECRET || '').trim();
  if (jwtSecret) return jwtSecret;

  const tosSecret = (process.env.TOS_SECRET_ACCESS_KEY || '').trim();
  if (tosSecret) return tosSecret;

  return 'sd-dev-insecure-persist-view';
}

/**
 * Ticket 有效期（秒），默认 1 天
 */
function getTicketTtlSec() {
  const n = parseInt(process.env.PERSIST_VIEW_TICKET_TTL_SEC || '86400', 10);
  return Number.isFinite(n) && n > 60 ? n : 86400;
}

/**
 * 生成持久化视图访问 ticket
 * @param {string} taskId - 任务 ID
 * @param {string} viewerUserId - 查看者用户 ID
 * @param {boolean} viewerIsAdmin - 查看者是否为管理员
 * @returns {string} ticket 字符串
 */
export function signPersistViewTicket(taskId, viewerUserId, viewerIsAdmin = false) {
  const exp = Math.floor(Date.now() / 1000) + getTicketTtlSec();
  const payload = {
    tid: String(taskId),
    vid: String(viewerUserId),
    adm: Boolean(viewerIsAdmin),
    exp,
  };

  const body = JSON.stringify(payload);
  const key = getSigningKey();
  const sig = crypto.createHmac('sha256', key).update(body).digest('hex');
  const bodyB64 = Buffer.from(body).toString('base64url').replace(/=+$/, '');

  return `${bodyB64}.${sig}`;
}

/**
 * 验证持久化视图访问 ticket
 * @param {string} ticket - ticket 字符串
 * @returns {object|null} 验证成功返回 payload 对象，失败返回 null
 */
export function verifyPersistViewTicket(ticket) {
  try {
    if (!ticket || typeof ticket !== 'string') return null;

    const lastDotIndex = ticket.lastIndexOf('.');
    if (lastDotIndex === -1) return null;

    const bodyB64 = ticket.slice(0, lastDotIndex);
    const sig = ticket.slice(lastDotIndex + 1);

    // 添加 padding
    const pad = '='.repeat((4 - (bodyB64.length % 4)) % 4);
    const body = Buffer.from(bodyB64 + pad, 'base64url').toString('utf-8');

    const key = getSigningKey();
    const expectSig = crypto.createHmac('sha256', key).update(body).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expectSig), Buffer.from(sig))) {
      return null;
    }

    const payload = JSON.parse(body);
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch (e) {
    console.error('[persist-view-ticket] 验证失败:', e.message);
    return null;
  }
}

export default {
  signPersistViewTicket,
  verifyPersistViewTicket,
};
