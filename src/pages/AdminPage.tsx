import { useState, useEffect } from 'react';
import {
  getSystemStats,
  getUserList,
  updateUserStatus,
  updateUserCredits,
  resetUserPassword,
  adminCreateUser,
} from '../services/authService';
import type { User } from '../types';
import { UsersIcon, ShieldIcon, CheckIcon, SparkleIcon } from '../components/Icons';
import { useToast } from '../components/Toast';

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

  // 新建用户弹窗
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    email: string;
    password: string;
    role: 'user' | 'admin';
    credits: string;
  }>({ email: '', password: '', role: 'user', credits: '10' });
  const [creating, setCreating] = useState(false);

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
      await adminCreateUser({
        email,
        password,
        role: createForm.role,
        credits: Number.isFinite(credits) ? credits : 10,
      });
      setShowCreateModal(false);
      setCreateForm({ email: '', password: '', role: 'user', credits: '10' });
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

        {/* 统计卡片 */}
        {stats && (
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

        {/* 用户列表 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-gray-800">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <h2 className="text-xl font-semibold text-white">用户管理</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="px-4 py-2 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white text-sm font-medium rounded-xl shadow-lg shadow-purple-500/20 transition-all"
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
                          {(() => {
                            const raw = (user as any).created_at || user.createdAt;
                            if (!raw) return '-';
                            const d = new Date(raw);
                            return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('zh-CN');
                          })()}
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
