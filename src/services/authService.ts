import type { User, LoginCredentials, RegisterCredentials, AuthResponse } from '../types';

const API_BASE = '/api';

/**
 * 获取存储的 Session ID
 */
function getSessionId(): string | null {
  return localStorage.getItem('seedance_session_id');
}

/**
 * 设置 Session ID
 */
function setSessionId(sessionId: string): void {
  localStorage.setItem('seedance_session_id', sessionId);
}

/**
 * 移除 Session ID
 */
function removeSessionId(): void {
  localStorage.removeItem('seedance_session_id');
  localStorage.removeItem('seedance_user_cache');
}

export function getAuthSessionId(): string | null {
  return getSessionId();
}

export function getAuthHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const sessionId = getSessionId();
  if (!sessionId) {
    throw new Error('未登录');
  }

  return {
    ...headers,
    'X-Session-ID': sessionId,
  };
}

/**
 * 获取缓存的用户信息
 */
function getCachedUser(): User | null {
  const cached = localStorage.getItem('seedance_user_cache');
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 缓存用户信息
 */
function cacheUser(user: User): void {
  localStorage.setItem('seedance_user_cache', JSON.stringify(user));
}

/**
 * 注册新用户
 */
export async function register(credentials: RegisterCredentials): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '注册失败');
  }

  if (data.data) {
    setSessionId(data.data.sessionId);
    cacheUser(data.data.user);
  }

  return data.data;
}

/**
 * 用户登录
 */
export async function login(credentials: LoginCredentials): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '登录失败');
  }

  if (data.data) {
    setSessionId(data.data.sessionId);
    cacheUser(data.data.user);
  }

  return data.data;
}

/**
 * 用户登出
 */
export async function logout(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'X-Session-ID': sessionId,
        },
      });
    } catch (error) {
      console.error('登出失败:', error);
    }
  }
  removeSessionId();
}

/**
 * 获取当前用户信息
 */
export async function getCurrentUser(): Promise<User | null> {
  const sessionId = getSessionId();

  if (!sessionId) {
    return null;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      headers: {
        'X-Session-ID': sessionId,
      },
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      removeSessionId();
      return null;
    }

    const user = data.data.user;
    cacheUser(user);
    return user;
  } catch (error) {
    console.error('获取用户信息失败:', error);
    return null;
  }
}

/**
 * 修改密码
 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/auth/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ oldPassword, newPassword }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '修改密码失败');
  }

  // 修改密码后需要重新登录
  removeSessionId();
}

/**
 * 扣减积分
 */
export async function deductCredits(amount: number): Promise<{ remainingCredits: number }> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/credits/deduct`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ amount }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '扣减积分失败');
  }

  // 更新缓存的用户信息
  const user = getCachedUser();
  if (user) {
    user.credits = data.data.remainingCredits;
    cacheUser(user);
  }

  return data.data;
}

/**
 * 充值积分
 */
export async function rechargeCredits(amount: number): Promise<{ credits: number }> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/credits/add`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ amount }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '充值积分失败');
  }

  // 更新缓存的用户信息
  const user = getCachedUser();
  if (user) {
    user.credits = data.data.credits;
    cacheUser(user);
  }

  return data.data;
}

/**
 * 每日签到
 */
export async function checkIn(): Promise<{ creditsEarned: number }> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/credits/checkin`, {
    method: 'POST',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '签到失败');
  }

  // 更新缓存的用户信息
  const user = getCachedUser();
  if (user) {
    user.credits = (user.credits || 0) + data.data.creditsEarned;
    cacheUser(user);
  }

  return data.data;
}

/**
 * 获取签到状态
 */
export async function getCheckInStatus(): Promise<{ hasCheckedInToday: boolean; totalCheckIns: number }> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/credits/checkin/status`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取签到状态失败');
  }

  return data.data;
}

/**
 * 发送邮箱验证码
 */
export async function sendEmailCode(email: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/email-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '发送验证码失败');
  }

  return data.data;
}

/**
 * 检查邮箱状态
 */
export async function checkEmailStatus(email: string): Promise<{ isRegistered: boolean }> {
  const response = await fetch(`${API_BASE}/auth/email-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '检查邮箱状态失败');
  }

  return data.data;
}

/**
 * 验证邮箱验证码
 */
export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/verify-email-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, code }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '验证码错误');
  }

  return data;
}

// ============================================================
// 管理员 API
// ============================================================

/**
 * 获取系统统计
 */
export async function getSystemStats(): Promise<{
  totalUsers: number;
  activeUsers: number;
  totalProjects: number;
  totalTasks: number;
  todayCheckIns: number;
  totalCreditsIssued: number;
}> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/stats`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取系统统计失败');
  }

  return data.data;
}

/**
 * 获取用户列表
 */
export async function getUserList(
  page: number = 1,
  pageSize: number = 20,
  filters?: { role?: string; status?: string; email?: string }
): Promise<{
  users: User[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    ...filters,
  } as Record<string, string>);

  const response = await fetch(`${API_BASE}/admin/users?${params.toString()}`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取用户列表失败');
  }

  return data.data;
}

/**
 * 管理员: 直接创建用户 (无需邮箱验证码)
 */
export async function adminCreateUser(payload: {
  email: string;
  password: string;
  role?: 'user' | 'admin';
  credits?: number;
  status?: 'active' | 'disabled';
}): Promise<User> {
  const sessionId = getSessionId();
  if (!sessionId) throw new Error('未登录');

  const response = await fetch(`${API_BASE}/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || '创建用户失败');
  }
  return data as User;
}

/**
 * 获取用户详情
 */
export async function getUserDetail(userId: number): Promise<User | null> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取用户详情失败');
  }

  return data.data;
}

/**
 * 更新用户状态
 */
export async function updateUserStatus(userId: number, status: 'active' | 'disabled'): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ status }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '更新用户状态失败');
  }
}

/**
 * 修改用户积分
 */
export async function updateUserCredits(
  userId: number,
  credits: number,
  operation: 'set' | 'add' | 'subtract' = 'set'
): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}/credits`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ credits, operation }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '修改用户积分失败');
  }
}

/**
 * 重置用户密码
 */
export async function resetUserPassword(userId: number, newPassword: string): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ newPassword }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '重置用户密码失败');
  }
}
