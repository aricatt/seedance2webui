import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, checkEmailStatus } from '../services/authService';
import type { User } from '../types';
import { MailIcon, LockIcon, EyeIcon, EyeOffIcon, SparkleIcon } from '../components/Icons';

interface LoginFormData {
  email: string;
  password: string;
}

interface LoginPageProps {
  onLoginSuccess: (user: User) => void;
}

export default function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<LoginFormData>({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(formData);
      onLoginSuccess(result.user);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查账号和密码');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailBlur = async () => {
    if (formData.email) {
      try {
        const result = await checkEmailStatus(formData.email);
        if (!result.isRegistered) {
          setError('该账号未注册，请联系管理员');
        }
      } catch {
        // 忽略错误
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0f111a] via-[#1a1d2e] to-[#0f111a] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 mb-4 shadow-lg shadow-purple-500/30">
            <SparkleIcon className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">ModelToo SD</h1>
          <p className="text-gray-400">AI 视频生成平台</p>
        </div>

        {/* 登录表单 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-8 shadow-xl">
          <h2 className="text-xl font-semibold text-white mb-6 text-center">用户登录</h2>

          {error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* 账号输入 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                账号
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <MailIcon className="w-5 h-5 text-gray-500" />
                </div>
                <input
                  type="text"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  onBlur={handleEmailBlur}
                  className="w-full pl-12 pr-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                  placeholder="请输入账号"
                  required
                />
              </div>
            </div>

            {/* 密码输入 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                密码
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <LockIcon className="w-5 h-5 text-gray-500" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full pl-12 pr-12 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                  placeholder="请输入密码"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showPassword ? (
                    <EyeOffIcon className="w-5 h-5" />
                  ) : (
                    <EyeIcon className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            {/* 登录按钮 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-medium rounded-xl shadow-lg shadow-purple-500/30 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-[#1c1f2e] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>

          {/* 注册入口: 暂时隐藏, 新账号统一由管理员在 /admin 创建
          <div className="mt-6 text-center">
            <p className="text-gray-400 text-sm">
              还没有账号？{' '}
              <button
                onClick={() => navigate('/register')}
                className="text-purple-400 hover:text-purple-300 font-medium transition-colors"
              >
                立即注册
              </button>
            </p>
          </div>
          */}

          {/* 测试账号提示已移除: 避免将默认管理员凭据暴露在登录页 */}
        </div>
      </div>
    </div>
  );
}
