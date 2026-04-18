import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Sidebar from './components/Sidebar';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminPage from './pages/AdminPage';
import SingleTaskPage from './pages/SingleTaskPage';
import BatchManagementPage from './pages/BatchManagement';
import SettingsPage from './pages/Settings';
import DownloadManagementPage from './pages/DownloadManagement';
import type { User } from './types';
import { getCurrentUser } from './services/authService';
import { ToastProvider } from './components/Toast';

// 受保护的路由组件
function ProtectedRoute({
  children,
  requireAdmin = false,
  currentUser,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
  currentUser: User | null;
}) {
  if (!currentUser) {
    return <Navigate to="/login" replace />;
  }

  if (requireAdmin && currentUser.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

// 主布局组件（带侧边栏）
function MainLayout({
  currentUser,
  onLogout,
  children,
}: {
  currentUser: User | null;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0f111a]">
      <Sidebar currentUser={currentUser} onLogout={onLogout} />
      <main className="lg:pl-60 pt-16 lg:pt-0 min-h-screen">
        {children}
      </main>
    </div>
  );
}

function AppContent() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const handleAuthSuccess = (user: User) => {
    setCurrentUser(user);
  };

  // 加载当前用户
  useEffect(() => {
    const loadUser = async () => {
      try {
        const user = await getCurrentUser();
        setCurrentUser(user);
      } catch (error) {
        console.error('加载用户信息失败:', error);
      } finally {
        setLoading(false);
      }
    };
    loadUser();
  }, []);

  const handleLogout = () => {
    setCurrentUser(null);
  };

  // 加载过程中显示加载状态
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f111a] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin text-purple-500 mb-4">
            <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </div>
          <p className="text-gray-400">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <AppProvider currentUser={currentUser}>
      <Routes>
        {/* 公开路由 */}
        <Route
          path="/login"
          element={
            currentUser ? (
              <Navigate to="/" replace />
            ) : (
              <LoginPage onLoginSuccess={handleAuthSuccess} />
            )
          }
        />
        <Route
          path="/register"
          element={
            currentUser ? (
              <Navigate to="/" replace />
            ) : (
              <RegisterPage onRegisterSuccess={handleAuthSuccess} />
            )
          }
        />

        {/* 受保护的路由 */}
        <Route
          path="/"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout}>
                <SingleTaskPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/batch"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout}>
                <BatchManagementPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/download"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout}>
                <DownloadManagementPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout}>
                <SettingsPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute requireAdmin currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout}>
                <AdminPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        {/* 404 重定向 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </BrowserRouter>
  );
}
