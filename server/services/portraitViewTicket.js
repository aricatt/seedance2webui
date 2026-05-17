/**
 * HMAC tickets for GET /api/portraits/:id/preview
 * (img src cannot send Bearer token).
 */

import crypto from 'crypto';

function getSigningKey() {
  const jwtSecret = (process.env.JWT_SECRET || process.env.MODELTOO_JWT_SECRET || '').trim();
  if (jwtSecret) return jwtSecret;

  const tosSecret = (process.env.TOS_SECRET_ACCESS_KEY || '').trim();
  if (tosSecret) return tosSecret;

  return 'sd-dev-insecure-portrait-view';
}

function getTicketTtlSec() {
  const n = parseInt(process.env.PERSIST_VIEW_TICKET_TTL_SEC || '86400', 10);
  return Number.isFinite(n) && n > 60 ? n : 86400;
}

export function signPortraitViewTicket(portraitId, mtProjectId, viewerUserId, viewerIsAdmin = false) {
  const exp = Math.floor(Date.now() / 1000) + getTicketTtlSec();
  const payload = {
    pid: String(portraitId),
    proj: String(mtProjectId),
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

export function verifyPortraitViewTicket(ticket) {
  try {
    if (!ticket || typeof ticket !== 'string') return null;

    const lastDotIndex = ticket.lastIndexOf('.');
    if (lastDotIndex === -1) return null;

    const bodyB64 = ticket.slice(0, lastDotIndex);
    const sig = ticket.slice(lastDotIndex + 1);
    const pad = '='.repeat((4 - (bodyB64.length % 4)) % 4);
    const body = Buffer.from(bodyB64 + pad, 'base64url').toString('utf-8');

    const key = getSigningKey();
    const expectSig = crypto.createHmac('sha256', key).update(body).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expectSig), Buffer.from(sig))) {
      return null;
    }

    const payload = JSON.parse(body);
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch (e) {
    console.warn('[portrait-view-ticket] 验证失败:', e.message);
    return null;
  }
}

export default {
  signPortraitViewTicket,
  verifyPortraitViewTicket,
};
