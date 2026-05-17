import { useState, useEffect, useCallback } from 'react';
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
import ProjectSelectionModal from './components/ProjectSelectionModal';
import type { User } from './types';
import { getCurrentUser } from './services/authService';
import { ModelTooProjectWithBalance, getModelTooProjectsWithBalance } from './services/modeltooBudgetService';
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
  selectedProject,
  onOpenProjectModal,
}: {
  currentUser: User | null;
  onLogout: () => void;
  children: React.ReactNode;
  selectedProject?: ModelTooProjectWithBalance | null;
  onOpenProjectModal?: () => void;
}) {
  return (
    <div className="min-h-screen bg-[#0f111a]">
      <Sidebar currentUser={currentUser} onLogout={onLogout} selectedProject={selectedProject} onOpenProjectModal={onOpenProjectModal} />
      <main className="lg:pl-60 pt-16 lg:pt-0 min-h-screen">
        {children}
      </main>
    </div>
  );
}

function AppContent() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  
  // ModelToo project selection state
  const [selectedProject, setSelectedProject] = useState<ModelTooProjectWithBalance | null>(null);
  const [showProjectModal, setShowProjectModal] = useState(false);

  /** 退出或未登录：清掉 ModelToo 项目 UI 与本地缓存，避免串到下一账号 */
  const clearModelTooProjectSelection = useCallback(() => {
    setSelectedProject(null);
    localStorage.removeItem('modeltoo_selected_project');
    setShowProjectModal(false);
  }, []);

  /**
   * 登录后根据「当前账号」在 ModelToo 可见的项目列表，校验 localStorage 里的选中项。
   * 仅当 project_id 仍属于该用户时才恢复；否则清空，并在有可选项时弹出项目选择。
   */
  const reconcileProjectAfterAuth = useCallback(async () => {
      let savedProjectId: string | null = null;
      const raw = localStorage.getItem('modeltoo_selected_project');
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { project_id?: string | number };
          if (parsed?.project_id != null && parsed.project_id !== '') {
            savedProjectId = String(parsed.project_id);
          }
        } catch {
          localStorage.removeItem('modeltoo_selected_project');
        }
      }

      let projects: ModelTooProjectWithBalance[] = [];
      try {
        projects = await getModelTooProjectsWithBalance();
      } catch (error) {
        console.error('加载 ModelToo 项目列表失败:', error);
        localStorage.removeItem('modeltoo_selected_project');
        setSelectedProject(null);
        return;
      }

      const match = savedProjectId
        ? projects.find((p) => String(p.project_id) === savedProjectId)
        : null;

      if (match) {
        setSelectedProject(match);
        localStorage.setItem('modeltoo_selected_project', JSON.stringify(match));
        setShowProjectModal(false);
        return;
      }

      localStorage.removeItem('modeltoo_selected_project');
      setSelectedProject(null);
      if (projects.length > 0) {
        setTimeout(() => setShowProjectModal(true), 500);
      } else {
        setShowProjectModal(false);
      }
    }, []);

  const handleAuthSuccess = async (user: User) => {
    setCurrentUser(user);
    await reconcileProjectAfterAuth();
  };

  const handleProjectSelect = (project: ModelTooProjectWithBalance) => {
    setSelectedProject(project);
    localStorage.setItem('modeltoo_selected_project', JSON.stringify(project));
  };

  const refreshSelectedProjectBalance = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const projects = await getModelTooProjectsWithBalance();
      const updatedProject = projects.find((p: ModelTooProjectWithBalance) => p.project_id === selectedProject.project_id);
      if (updatedProject) {
        setSelectedProject(updatedProject);
        localStorage.setItem('modeltoo_selected_project', JSON.stringify(updatedProject));
      }
    } catch (error) {
      console.error('刷新项目余额失败:', error);
    }
  }, [selectedProject]);

  const handleOpenProjectModal = () => {
    setShowProjectModal(true);
  };

  const handleCloseProjectModal = () => {
    setShowProjectModal(false);
  };

  // 加载当前用户，并按账号校验 ModelToo 选中项目（避免沿用上一位用户的 localStorage）
  useEffect(() => {
    let cancelled = false;
    const loadUser = async () => {
      try {
        const user = await getCurrentUser();
        if (cancelled) return;
        setCurrentUser(user);
        if (user) {
          await reconcileProjectAfterAuth();
        } else {
          clearModelTooProjectSelection();
        }
      } catch (error) {
        console.error('加载用户信息失败:', error);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void loadUser();
    return () => {
      cancelled = true;
    };
  }, [reconcileProjectAfterAuth, clearModelTooProjectSelection]);

  const handleLogout = () => {
    setCurrentUser(null);
    clearModelTooProjectSelection();
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
              <MainLayout currentUser={currentUser} onLogout={handleLogout} selectedProject={selectedProject} onOpenProjectModal={handleOpenProjectModal}>
                <SingleTaskPage
                  onRefreshBalance={refreshSelectedProjectBalance}
                  selectedProject={selectedProject}
                />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/batch"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} selectedProject={selectedProject} onOpenProjectModal={handleOpenProjectModal}>
                <BatchManagementPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/download"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} selectedProject={selectedProject} onOpenProjectModal={handleOpenProjectModal}>
                <DownloadManagementPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} selectedProject={selectedProject} onOpenProjectModal={handleOpenProjectModal}>
                <SettingsPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute requireAdmin currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} selectedProject={selectedProject} onOpenProjectModal={handleOpenProjectModal}>
                <AdminPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        {/* 404 重定向 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Project Selection Modal */}
      {currentUser && (
        <ProjectSelectionModal
          isOpen={showProjectModal}
          onClose={handleCloseProjectModal}
          onProjectSelect={handleProjectSelect}
        />
      )}
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
