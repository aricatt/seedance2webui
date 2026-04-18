import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { register, checkEmailStatus, sendEmailCode, verifyEmailCode } from '../services/authService';
import type { User } from '../types';
import { MailIcon, LockIcon, EyeIcon, EyeOffIcon, SparkleIcon, CheckIcon } from '../components/Icons';

interface RegisterFormData {
  email: string;
  password: string;
  confirmPassword: string;
  verificationCode: string;
}

interface RegisterPageProps {
  onRegisterSuccess: (user: User) => void;
}

export default function RegisterPage({ onRegisterSuccess }: RegisterPageProps) {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<RegisterFormData>({
    email: '',
    password: '',
    confirmPassword: '',
    verificationCode: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [emailVerified, setEmailVerified] = useState(false);

  const validatePassword = (password: string): { valid: boolean; message: string } => {
    if (!password) {
      return { valid: false, message: '请输入密码' };
    }
    return { valid: true, message: '' };
  };

  const handleEmailBlur = async () => {
    if (formData.email) {
      try {
        const result = await checkEmailStatus(formData.email);
        if (result.isRegistered) {
          setError('该邮箱已被注册，请直接登录');
        } else {
          setError('');
        }
      } catch {
        // 忽略错误
      }
    }
  };

  const handleSendCode = async () => {
    if (!formData.email) {
      setError('请先输入账号');
      return;
    }

    if (formData.email.trim().length < 2) {
      setError('账号至少 2 个字符');
      return;
    }

    setSendingCode(true);
    setError('');

    try {
      // 开发环境下会返回验证码
      await sendEmailCode(formData.email);
      setCodeSent(true);
      setCountdown(60);

      // 倒计时
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!formData.verificationCode) {
      setError('请输入验证码');
      return;
    }

    try {
      await verifyEmailCode(formData.email, formData.verificationCode);
      setEmailVerified(true);
      setError('邮箱验证成功，请设置密码');
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码错误');
    }
  };

  const handleVerifyCodeAndSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // 验证密码
    const passwordValidation = validatePassword(formData.password);
    if (!passwordValidation.valid) {
      setError(passwordValidation.message);
      return;
    }

    // 验证密码一致性
    if (formData.password !== formData.confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    // 验证邮箱已验证
    if (!emailVerified) {
      setError('请先获取并验证邮箱验证码');
      return;
    }

    setLoading(true);

    try {
      const result = await register({
        email: formData.email,
        password: formData.password,
        emailCode: formData.verificationCode,
      });
      onRegisterSuccess(result.user);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
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
          <h1 className="text-3xl font-bold text-white mb-2">Seedance 2.0</h1>
          <p className="text-gray-400">AI 视频生成平台</p>
        </div>

        {/* 注册表单 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-8 shadow-xl">
          <h2 className="text-xl font-semibold text-white mb-6 text-center">创建账号</h2>

          {error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleVerifyCodeAndSubmit} className="space-y-5">
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
                  placeholder="请输入账号（邮箱或用户名）"
                  required
                />
              </div>
            </div>

            {/* 验证码输入 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                邮箱验证码
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={formData.verificationCode}
                    onChange={(e) => setFormData({ ...formData, verificationCode: e.target.value })}
                    className="w-full px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                    placeholder="6 位验证码"
                    maxLength={6}
                    required
                  />
                  {emailVerified && (
                    <div className="absolute inset-y-0 right-0 pr-4 flex items-center">
                      <CheckIcon className="w-5 h-5 text-green-500" />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleVerifyCode}
                  disabled={sendingCode || !formData.verificationCode || emailVerified}
                  className="px-4 py-3 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 font-medium rounded-xl border border-purple-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {sendingCode ? '验证中...' : emailVerified ? '已验证' : '验证'}
                </button>
                <button
                  type="button"
                  onClick={handleSendCode}
                  disabled={sendingCode || !formData.email}
                  className="px-4 py-3 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 font-medium rounded-xl border border-emerald-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {sendingCode ? '发送中...' : codeSent && countdown > 0 ? `${countdown}秒` : '获取验证码'}
                </button>
              </div>
              {codeSent && !emailVerified && (
                <p className="mt-1 text-xs text-gray-500">
                  请输入收到的 6 位验证码，然后点击「验证」按钮
                </p>
              )}
              {emailVerified && (
                <p className="mt-1 text-xs text-green-500">
                  邮箱验证通过，请设置密码后点击「创建账号」
                </p>
              )}
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

            {/* 确认密码 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                确认密码
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <LockIcon className="w-5 h-5 text-gray-500" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  className="w-full pl-12 pr-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                  placeholder="请再次输入密码"
                  required
                />
              </div>
            </div>

            {/* 注册按钮 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-medium rounded-xl shadow-lg shadow-purple-500/30 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-[#1c1f2e] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? '注册中...' : '创建账号'}
            </button>
          </form>

          {/* 登录链接 */}
          <div className="mt-6 text-center">
            <p className="text-gray-400 text-sm">
              已有账号？{' '}
              <button
                onClick={() => navigate('/login')}
                className="text-purple-400 hover:text-purple-300 font-medium transition-colors"
              >
                立即登录
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
