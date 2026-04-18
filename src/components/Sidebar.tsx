import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  FilmIcon,
  PackageIcon,
  DownloadIcon,
  SettingsIcon,
  MenuIcon,
  CloseIcon,
  UserIcon,
  ShieldIcon,
  LogoutIcon,
  SparkleIcon,
} from '../components/Icons';
import type { User } from '../types';
import { logout } from '../services/authService';

interface SidebarProps {
  currentUser: User | null;
  onLogout: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  /** true = 入口暂不对外暴露 (但路由仍可直接访问, 便于恢复) */
  hidden?: boolean;
  accent?: string;
}

export default function Sidebar({ currentUser, onLogout }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  const menuItems: MenuItem[] = [
    {
      id: 'SINGLE_TASK',
      label: '单任务生成',
      path: '/',
      icon: FilmIcon,
    },
    {
      id: 'BATCH_MANAGEMENT',
      label: '批量管理（暂不开放）',
      path: '/batch',
      icon: PackageIcon,
    },
    {
      id: 'DOWNLOAD_MANAGEMENT',
      label: '下载管理',
      path: '/download',
      icon: DownloadIcon,
    },
    {
      id: 'SETTINGS',
      label: '设置',
      path: '/settings',
      icon: SettingsIcon,
    },
    {
      id: 'ADMIN',
      label: '管理后台',
      path: '/admin',
      icon: ShieldIcon,
      adminOnly: true,
      accent: 'text-amber-500',
    },
  ];

  const handleLogout = async () => {
    await logout();
    onLogout();
    navigate('/login');
  };

  const visibleItems = menuItems.filter(
    (item) =>
      !item.hidden && (!item.adminOnly || currentUser?.role === 'admin')
  );

  return (
    <>
      {/* 移动端遮罩 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside
        className={`fixed top-0 left-0 z-50 h-screen bg-[#1c1f2e] border-r border-gray-800 transition-all duration-300 ${expanded ? 'w-60' : 'w-16'
          } ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
        {/* Logo 区域 */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-gray-800">
          <div className={`flex items-center gap-3 ${!expanded && 'justify-center'}`}>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
              <SparkleIcon className="w-5 h-5 text-white" />
            </div>
            {expanded && (
              <span className="text-lg font-bold text-white whitespace-nowrap">
                Seedance 2.0
              </span>
            )}
          </div>
          {expanded && (
            <button
              onClick={() => setMobileOpen(false)}
              className="lg:hidden text-gray-400 hover:text-white"
            >
              <CloseIcon className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 菜单项 */}
        <nav className="p-3 space-y-1">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.path);

            return (
              <Link
                key={item.id}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${active
                    ? 'bg-purple-500/20 text-purple-400'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  } ${!expanded && 'justify-center'}`}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${item.accent || ''}`} />
                {expanded && (
                  <span className={`text-sm font-medium ${item.accent || ''}`}>
                    {item.label}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* 底部用户信息 */}
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-gray-800">
          {expanded ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                  <UserIcon className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {currentUser?.email || '用户'}
                  </p>
                  <p className="text-xs text-gray-500">
                    {currentUser?.role === 'admin' ? '管理员' : '普通用户'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                title="退出登录"
              >
                <LogoutIcon className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={handleLogout}
                className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                title="退出登录"
              >
                <LogoutIcon className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* 顶部导航栏（移动端） */}
      <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-[#1c1f2e] border-b border-gray-800 z-30 flex items-center justify-between px-4">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 text-gray-400 hover:text-white"
        >
          <MenuIcon className="w-6 h-6" />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
            <SparkleIcon className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-bold text-white">Seedance 2.0</span>
        </div>
        <div className="w-10" /> {/* 占位 */}
      </header>

      {/* 展开/收起按钮（桌面端） */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="hidden lg:flex fixed top-1/2 -right-3 z-50 w-6 h-12 bg-[#1c1f2e] border border-gray-800 rounded-r-lg items-center justify-center text-gray-400 hover:text-white transition-all"
      >
        {expanded ? (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        )}
      </button>
    </>
  );
}
