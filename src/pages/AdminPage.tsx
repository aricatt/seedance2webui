import { useState, useEffect } from 'react';
import {
  getSystemStats,
  getUserList,
  updateUserStatus,
  updateUserCredits,
  updateUserRole,
  resetUserPassword,
  adminCreateUser,
} from '../services/authService';
import type { User } from '../types';
import { UsersIcon, ShieldIcon, CheckIcon, SparkleIcon } from '../components/Icons';
import { useToast } from '../components/Toast';
import { formatDbDate } from '../utils/datetime';

interface SystemStats {
  totalUsers: number;
  activeUsers: number;
  totalProjects: number;
  totalTasks: number;
  todayCheckIns: number;
  totalCreditsIssued: number;
}

export default function AdminPage() {
  const { toast } = useToast();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterRole, setFilterRole] = useState<string>('all');

  // 弹窗状态
  const [showUserModal, setShowUserModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [editCredits, setEditCredits] = useState('');
  const [editOperation, setEditOperation] = useState<'set' | 'add' | 'subtract'>('set');
  const [resetPassword, setResetPassword] = useState('');
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user');

  // 新建用户弹窗
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    email: string;
    displayName: string;
    password: string;
    role: 'user' | 'admin';
    credits: string;
  }>({ email: '', displayName: '', password: '', role: 'user', credits: '10' });
  const [creating, setCreating] = useState(false);

  // 统计数据 Tab
  const [activeTab, setActiveTab] = useState<'users' | 'stats'>('users');
  const [statsTimeRange, setStatsTimeRange] = useState<'7' | '30' | '90' | 'all'>('all'); // 默认显示全部历史数据
  const [statsGroupFilter, setStatsGroupFilter] = useState<string>(''); // group id from ModelToo

  // 真实统计数据
  const [generationStats, setGenerationStats] = useState<any>(null);
  const [errorDistribution, setErrorDistribution] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [modelTooGroups, setModelTooGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupsLoadError, setGroupsLoadError] = useState<string>('');

  const loadStats = async () => {
    try {
      const data = await getSystemStats();
      setStats(data);
    } catch (err) {
      console.error('加载系统统计失败:', err);
    }
  };

  const loadUsers = async (page: number = 1) => {
    try {
      setLoading(true);
      const filters: Record<string, string> = {};
      if (filterStatus !== 'all') filters.status = filterStatus;
      if (filterRole !== 'all') filters.role = filterRole;

      const result = await getUserList(page, 20, filters);
      setUsers(result.users);
      setTotalPages(result.pagination.totalPages);
      setTotalUsers(result.pagination.total);
      setCurrentPage(result.pagination.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
    loadUsers();
  }, []);

  useEffect(() => {
    loadUsers(1);
  }, [filterStatus, filterRole]);

  const loadModelTooGroups = async () => {
    const sessionId = localStorage.getItem('seedance_session_id') || '';
    try {
      const res = await fetch('/api/admin/modeltoo/groups', {
        headers: { 'X-Session-ID': sessionId },
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const msg =
          typeof j.error === 'string' && j.error.trim()
            ? j.error
            : `分组列表加载失败 (${res.status})`;
        setGroupsLoadError(msg);
        setModelTooGroups([]);
        toast.error(msg);
        return;
      }
      setGroupsLoadError('');
      const j = await res.json();
      const items = (j.data || []) as { id: string; name: string }[];
      setModelTooGroups(items.map((g) => ({ id: String(g.id), name: g.name || String(g.id) })));
    } catch {
      setGroupsLoadError('分组列表网络错误');
      setModelTooGroups([]);
    }
  };

  // 加载生成统计数据
  const loadGenerationStats = async () => {
    try {
      setLoadingStats(true);
      const days = statsTimeRange === 'all' ? 0 : parseInt(statsTimeRange, 10);
      const sessionId = localStorage.getItem('seedance_session_id') || '';
      const gid = statsGroupFilter.trim();
      const q = new URLSearchParams({ days: String(days) });
      if (gid) q.set('group_id', gid);

      const [genRes, errRes] = await Promise.all([
        fetch(`/api/admin/stats/generation?${q}`, { headers: { 'X-Session-ID': sessionId } }),
        fetch(`/api/admin/stats/error-distribution?${q}`, { headers: { 'X-Session-ID': sessionId } }),
      ]);

      const parseErr = async (res: Response, fallback: string) => {
        try {
          const j = (await res.json()) as { error?: string };
          return typeof j?.error === 'string' && j.error.trim() ? j.error : fallback;
        } catch {
          return fallback;
        }
      };
      if (!genRes.ok) throw new Error(await parseErr(genRes, '加载生成统计失败'));
      if (!errRes.ok) throw new Error(await parseErr(errRes, '加载失败分布失败'));

      const genJson = await genRes.json();
      const errJson = await errRes.json();

      setGenerationStats(genJson.data);
      setErrorDistribution(errJson.data);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : '加载生成统计失败');
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'stats') {
      loadModelTooGroups();
    }
  }, [activeTab]);

  // 当切换到统计 Tab 或筛选条件变化时加载数据
  useEffect(() => {
    if (activeTab === 'stats') {
      loadGenerationStats();
    }
  }, [activeTab, statsTimeRange, statsGroupFilter]);

  const handleStatusChange = async (userId: number, newStatus: 'active' | 'disabled') => {
    try {
      await updateUserStatus(userId, newStatus);
      loadUsers(currentPage);
      loadStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新状态失败');
    }
  };

  const handleOpenUserModal = (user: User) => {
    setSelectedUser(user);
    setEditCredits('');
    setResetPassword('');
    setEditRole((user.role as 'user' | 'admin') || 'user');
    setShowUserModal(true);
  };

  const handleUpdateCredits = async () => {
    if (!selectedUser || !editCredits) return;

    try {
      const credits = parseInt(editCredits);
      if (isNaN(credits) || credits < 0) {
        toast.warning('请输入有效的积分数量');
        return;
      }

      await updateUserCredits(selectedUser.id, credits, editOperation);
      loadUsers(currentPage);
      loadStats();
      setShowUserModal(false);
      toast.success('积分已更新');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新积分失败');
    }
  };

  const handleUpdateRole = async () => {
    if (!selectedUser) return;
    if (editRole === selectedUser.role) return;
    try {
      await updateUserRole(selectedUser.id, editRole);
      loadUsers(currentPage);
      setShowUserModal(false);
      toast.success(`用户 ${selectedUser.email} 的角色已更新为${editRole === 'admin' ? '管理员' : '普通用户'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '修改角色失败');
    }
  };

  const handleCreateUser = async () => {
    const email = createForm.email.trim();
    const password = createForm.password;
    if (!email || !password) {
      toast.warning('账号和密码都要填');
      return;
    }
    try {
      setCreating(true);
      const credits = Number(createForm.credits);
      const displayName = createForm.displayName.trim();
      await adminCreateUser({
        email,
        password,
        ...(displayName ? { displayName } : {}),
        role: createForm.role,
        credits: Number.isFinite(credits) ? credits : 10,
      });
      setShowCreateModal(false);
      setCreateForm({ email: '', displayName: '', password: '', role: 'user', credits: '10' });
      loadUsers(1);
      loadStats();
      toast.success(`已创建用户 ${email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建用户失败');
    } finally {
      setCreating(false);
    }
  };

  const handleResetPassword = async () => {
    if (!selectedUser) return;

    if (!resetPassword) {
      toast.warning('请先输入新密码');
      return;
    }

    try {
      await resetUserPassword(selectedUser.id, resetPassword);
      toast.success(`用户 ${selectedUser.email} 的密码已重置`);
      setResetPassword('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重置密码失败');
    }
  };

  const StatCard = ({ title, value, icon: Icon, color }: {
    title: string;
    value: string | number;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }) => (
    <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-400 text-sm mb-1">{title}</p>
          <p className="text-3xl font-bold text-white">{value}</p>
        </div>
        <div className={`w-12 h-12 rounded-xl ${color} flex items-center justify-center`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0f111a] p-6">
      <div className="max-w-7xl mx-auto">
        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">管理后台</h1>
          <p className="text-gray-400">管理系统用户和查看系统统计</p>
        </div>

        {/* Tab 导航 */}
        <div className="flex gap-2 mb-6 border-b border-gray-800">
          <button
            onClick={() => setActiveTab('users')}
            className={`px-6 py-3 text-sm font-medium transition-all ${
              activeTab === 'users'
                ? 'text-white border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            用户管理
          </button>
          <button
            onClick={() => setActiveTab('stats')}
            className={`px-6 py-3 text-sm font-medium transition-all ${
              activeTab === 'stats'
                ? 'text-white border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            统计数据
          </button>
        </div>

        {/* 统计卡片（仅在用户管理 Tab 显示） */}
        {activeTab === 'users' && stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
            <StatCard
              title="总用户数"
              value={stats.totalUsers}
              icon={UsersIcon}
              color="bg-gradient-to-br from-blue-500 to-cyan-500"
            />
            <StatCard
              title="活跃用户"
              value={stats.activeUsers}
              icon={CheckIcon}
              color="bg-gradient-to-br from-green-500 to-emerald-500"
            />
            <StatCard
              title="总项目数"
              value={stats.totalProjects}
              icon={SparkleIcon}
              color="bg-gradient-to-br from-purple-500 to-pink-500"
            />
            <StatCard
              title="总任务数"
              value={stats.totalTasks}
              icon={ShieldIcon}
              color="bg-gradient-to-br from-amber-500 to-orange-500"
            />
            <StatCard
              title="今日签到"
              value={stats.todayCheckIns}
              icon={CheckIcon}
              color="bg-gradient-to-br from-rose-500 to-red-500"
            />
            <StatCard
              title="发放积分"
              value={stats.totalCreditsIssued}
              icon={SparkleIcon}
              color="bg-gradient-to-br from-indigo-500 to-violet-500"
            />
          </div>
        )}

        {/* 用户列表（仅在用户管理 Tab 显示） */}
        {activeTab === 'users' && (
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-gray-800">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <h2 className="text-xl font-semibold text-white">用户管理</h2>
              <div className="flex items-center gap-3">
                <button
                  disabled
                  title="用户通过 ModelToo 系统登录时会自动创建"
                  className="px-4 py-2 bg-gray-600/50 text-gray-500 text-sm font-medium rounded-xl cursor-not-allowed"
                >
                  + 添加用户
                </button>
                <select
                  value={filterRole}
                  onChange={(e) => setFilterRole(e.target.value)}
                  className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="all">所有角色</option>
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="all">所有状态</option>
                  <option value="active">正常</option>
                  <option value="disabled">禁用</option>
                </select>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin text-purple-500">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" />
                </svg>
              </div>
              <p className="text-gray-400 mt-4">加载中...</p>
            </div>
          ) : error ? (
            <div className="p-12 text-center text-red-400">{error}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-[#0f111a]">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        ID
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        账号
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        显示名
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        角色
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        状态
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        积分
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        注册时间
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {users.map((user) => (
                      <tr key={user.id} className="hover:bg-[#0f111a]/50">
                        <td className="px-6 py-4 text-sm text-gray-400">#{user.id}</td>
                        <td className="px-6 py-4 text-sm text-white">{user.email}</td>
                        <td className="px-6 py-4 text-sm text-gray-300">
                          {user.displayName?.trim() || '—'}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <span className={`px-2 py-1 rounded-lg text-xs font-medium ${
                            user.role === 'admin'
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-gray-500/20 text-gray-400'
                          }`}>
                            {user.role === 'admin' ? '管理员' : '普通用户'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <span className={`px-2 py-1 rounded-lg text-xs font-medium ${
                            user.status === 'active'
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}>
                            {user.status === 'active' ? '正常' : '禁用'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-white">{user.credits}</td>
                        <td className="px-6 py-4 text-sm text-gray-400">
                          {formatDbDate((user as any).created_at || user.createdAt)}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleStatusChange(
                                user.id,
                                user.status === 'active' ? 'disabled' : 'active'
                              )}
                              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                user.status === 'active'
                                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                  : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                              }`}
                            >
                              {user.status === 'active' ? '禁用' : '启用'}
                            </button>
                            <button
                              onClick={() => handleOpenUserModal(user)}
                              className="px-3 py-1.5 bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 rounded-lg text-xs font-medium transition-all"
                            >
                              编辑
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 分页 */}
              <div className="p-6 border-t border-gray-800 flex items-center justify-between">
                <p className="text-sm text-gray-400">
                  共 {totalUsers} 个用户，第 {currentPage} / {totalPages} 页
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => loadUsers(currentPage - 1)}
                    disabled={currentPage <= 1}
                    className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    上一页
                  </button>
                  <button
                    onClick={() => loadUsers(currentPage + 1)}
                    disabled={currentPage >= totalPages}
                    className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        )}

        {/* 统计数据 Tab 内容 */}
        {activeTab === 'stats' && (
          <div className="space-y-6">
            {/* 筛选工具栏 */}
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">时间范围</label>
                  <select
                    value={statsTimeRange}
                    onChange={(e) => setStatsTimeRange(e.target.value as any)}
                    className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="7">最近 7 天</option>
                    <option value="30">最近 30 天</option>
                    <option value="90">最近 90 天</option>
                    <option value="all">全部时间</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">分组筛选（ModelToo）</label>
                  <select
                    value={statsGroupFilter}
                    onChange={(e) => setStatsGroupFilter(e.target.value)}
                    className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 min-w-[200px]"
                  >
                    <option value="">全部分组</option>
                    {modelTooGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  {groupsLoadError ? (
                    <p className="text-xs text-amber-400 mt-1 max-w-xs">{groupsLoadError}</p>
                  ) : null}
                  {generationStats?.groupFilter?.groupId ? (
                    <p className="text-xs text-gray-500 mt-1">
                      ModelToo 成员 {generationStats.groupFilter.modelTooMemberCount ?? '?'} 人 · 本地已匹配{' '}
                      {generationStats.groupFilter.matchedLocalUsers} 人（按用户名或邮箱与 SD 的 users.email 对齐）
                      {(generationStats.groupFilter.modelTooMemberCount ?? 0) > 0 &&
                      generationStats.groupFilter.matchedLocalUsers === 0 ? (
                        <span className="block text-amber-400 mt-1">
                          未匹配到本地账号：请让组成员至少用同一登录名/邮箱登录过一次 SD，以便写入本地 users 表。
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                <button
                  onClick={loadGenerationStats}
                  disabled={loadingStats}
                  className="mt-5 px-5 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all"
                >
                  刷新数据
                </button>
              </div>
            </div>

            {/* KPI 卡片 - 视频生成维度（真实数据，显示全部历史） */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
                <p className="text-gray-400 text-sm mb-1">总生成视频数</p>
                <p className="text-3xl font-bold text-white">{generationStats?.summary?.totalVideos ?? 0}</p>
                <p className="text-xs text-emerald-400 mt-1">成功 {generationStats?.summary?.successVideos ?? 0} 个</p>
              </div>
              <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
                <p className="text-gray-400 text-sm mb-1">总任务数</p>
                <p className="text-3xl font-bold text-white">{generationStats?.summary?.totalTasks ?? 0}</p>
              </div>
              <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
                <p className="text-gray-400 text-sm mb-1">成功率</p>
                <p className="text-3xl font-bold text-white">{generationStats?.summary?.successRate ?? 0}%</p>
              </div>
              <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
                <p className="text-gray-400 text-sm mb-1">活跃创作者</p>
                <p className="text-3xl font-bold text-white">{generationStats?.summary?.activeUsers ?? 0}</p>
              </div>
            </div>

            {/* 失败统计（按阶段，只显示总数） */}
            {errorDistribution && (
              <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-800">
                  <h3 className="text-lg font-semibold text-white">失败统计（按阶段）</h3>
                  <p className="text-sm text-gray-400 mt-1">基于你数据库中所有历史数据</p>
                </div>

                <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-[#0f111a] rounded-2xl p-5">
                    <div className="text-sm text-gray-400">提交阶段失败</div>
                    <div className="text-3xl font-bold text-red-400 mt-1">
                      {errorDistribution.submissionFailures?.reduce((s: number, i: any) => s + i.count, 0) || 0}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">参考图过大、敏感内容、欠费等</div>
                  </div>

                  <div className="bg-[#0f111a] rounded-2xl p-5">
                    <div className="text-sm text-gray-400">生成阶段失败</div>
                    <div className="text-3xl font-bold text-amber-400 mt-1">
                      {errorDistribution.generationFailures?.reduce((s: number, i: any) => s + i.count, 0) || 0}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">超时、真实人物、版权限制等</div>
                  </div>

                  <div className="bg-[#0f111a] rounded-2xl p-5">
                    <div className="text-sm text-gray-400">下载阶段失败</div>
                    <div className="text-3xl font-bold text-orange-400 mt-1">
                      {errorDistribution.downloadFailedCount || 0}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">生成成功但下载失败</div>
                  </div>
                </div>

                <div className="px-6 pb-6 text-xs text-gray-400">
                  总失败任务数：{errorDistribution.totalErrorTasks}
                </div>
              </div>
            )}

            {/* 按用户统计表（真实数据） */}
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">按用户统计（Top 100）</h3>
                {loadingStats && <span className="text-xs text-gray-400">加载中...</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0f111a] text-gray-400">
                    <tr>
                      <th className="px-6 py-3 text-left">用户</th>
                      <th className="px-6 py-3 text-right">任务数</th>
                      <th className="px-6 py-3 text-right">生成视频</th>
                      <th className="px-6 py-3 text-right">成功视频</th>
                      <th className="px-6 py-3 text-right">成功率</th>
                      <th className="px-6 py-3 text-right text-red-400">提交失败</th>
                      <th className="px-6 py-3 text-right text-amber-400">生成失败</th>
                      <th className="px-6 py-3 text-right text-orange-400">下载失败</th>
                      <th className="px-6 py-3 text-left">最后活跃</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {generationStats?.users?.length > 0 ? (
                      generationStats.users.map((u: any, idx: number) => (
                        <tr key={idx} className="hover:bg-[#0f111a]/60">
                          <td className="px-6 py-3 text-white font-medium">
                            {u.displayName?.trim()
                              ? `${u.displayName} (${u.email})`
                              : u.email}
                          </td>
                          <td className="px-6 py-3 text-right text-gray-300">{u.taskCount}</td>
                          <td className="px-6 py-3 text-right text-white font-semibold">{u.videoCount}</td>
                          <td className="px-6 py-3 text-right text-emerald-400">{u.successVideoCount}</td>
                          <td className="px-6 py-3 text-right">
                            <span className={`px-2 py-0.5 rounded text-xs ${u.successRate > 80 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                              {u.successRate}%
                            </span>
                          </td>
                          {/* 新增三列失败统计 */}
                          <td className="px-6 py-3 text-right text-red-400 font-medium">{u.submissionFailureCount ?? 0}</td>
                          <td className="px-6 py-3 text-right text-amber-400 font-medium">{u.generationFailureCount ?? 0}</td>
                          <td className="px-6 py-3 text-right text-orange-400 font-medium">{u.downloadFailureCount ?? 0}</td>
                          <td className="px-6 py-3 text-gray-400 text-xs">
                            {u.lastActive ? new Date(u.lastActive).toLocaleDateString() : '-'}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={9} className="px-6 py-8 text-center text-gray-400">
                          {loadingStats ? '加载中...' : '暂无生成记录'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 分组说明：汇总已通过上方「分组筛选」切换 */}
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-800">
                <h3 className="text-lg font-semibold text-white">分组维度统计</h3>
                <p className="text-sm text-gray-400 mt-1">
                  在上方选择分组后，本页 KPI、失败统计与用户表均只统计该组成员（邮箱与本地 users 对齐）。
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 用户编辑弹窗 */}
        {showUserModal && selectedUser && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 w-full max-w-md">
              <h3 className="text-xl font-semibold text-white mb-6">
                编辑用户 - {selectedUser.email}
              </h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    角色
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')}
                      className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="user">普通用户</option>
                      <option value="admin">管理员</option>
                    </select>
                    <button
                      onClick={handleUpdateRole}
                      disabled={editRole === selectedUser.role}
                      className="px-4 py-3 bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 rounded-xl font-medium transition-all disabled:opacity-50 whitespace-nowrap"
                    >
                      更新
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    修改积分
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={editOperation}
                      onChange={(e) => setEditOperation(e.target.value as 'set' | 'add' | 'subtract')}
                      className="px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="set">设置为</option>
                      <option value="add">增加</option>
                      <option value="subtract">减少</option>
                    </select>
                    <input
                      type="number"
                      value={editCredits}
                      onChange={(e) => setEditCredits(e.target.value)}
                      className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder="数量"
                      min="0"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    重置密码
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder="输入新密码"
                    />
                    <button
                      onClick={handleResetPassword}
                      disabled={!resetPassword}
                      className="px-4 py-3 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-xl font-medium transition-all disabled:opacity-50 whitespace-nowrap"
                    >
                      重置
                    </button>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowUserModal(false)}
                    className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 text-white hover:bg-gray-800 rounded-xl font-medium transition-all"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleUpdateCredits}
                    className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-xl font-medium transition-all"
                  >
                    保存积分
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 添加用户弹窗 */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 w-full max-w-md">
              <h3 className="text-xl font-semibold text-white mb-6">添加用户</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">账号</label>
                  <input
                    type="text"
                    value={createForm.email}
                    onChange={(e) =>
                      setCreateForm((f) => ({ ...f, email: e.target.value }))
                    }
                    className="w-full px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    placeholder="输入账号（邮箱或用户名）"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    显示名（可选）
                  </label>
                  <input
                    type="text"
                    value={createForm.displayName}
                    onChange={(e) =>
                      setCreateForm((f) => ({ ...f, displayName: e.target.value }))
                    }
                    className="w-full px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    placeholder="留空则仅显示账号"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    初始密码
                  </label>
                  <input
                    type="text"
                    value={createForm.password}
                    onChange={(e) =>
                      setCreateForm((f) => ({ ...f, password: e.target.value }))
                    }
                    className="w-full px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    placeholder="输入密码"
                  />
                  <p className="text-xs text-gray-500 mt-1">请告知用户登录后尽快自行修改</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">角色</label>
                    <select
                      value={createForm.role}
                      onChange={(e) =>
                        setCreateForm((f) => ({
                          ...f,
                          role: e.target.value as 'user' | 'admin',
                        }))
                      }
                      className="w-full px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="user">普通用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      初始积分
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={createForm.credits}
                      onChange={(e) =>
                        setCreateForm((f) => ({ ...f, credits: e.target.value }))
                      }
                      className="w-full px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setShowCreateModal(false)}
                    disabled={creating}
                    className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 text-white hover:bg-gray-800 rounded-xl font-medium transition-all disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleCreateUser}
                    disabled={creating}
                    className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl font-medium transition-all disabled:opacity-50"
                  >
                    {creating ? '创建中...' : '创建'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
