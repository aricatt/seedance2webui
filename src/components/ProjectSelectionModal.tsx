import { useState, useEffect } from 'react';
import { getModelTooProjectsWithBalance, ModelTooProjectWithBalance } from '../services/modeltooBudgetService';

interface ProjectSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectSelect: (project: ModelTooProjectWithBalance) => void;
}

export default function ProjectSelectionModal({
  isOpen,
  onClose,
  onProjectSelect,
}: ProjectSelectionModalProps) {
  const [projects, setProjects] = useState<ModelTooProjectWithBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      loadProjects();
    }
  }, [isOpen]);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await getModelTooProjectsWithBalance();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载项目列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = () => {
    const project = projects.find((p) => p.project_id === selectedProjectId);
    if (project) {
      onProjectSelect(project);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 w-full max-w-lg mx-4">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">选择项目</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8">
            <div className="inline-block animate-spin text-purple-500 mb-4">
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-gray-400">加载项目列表中...</p>
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={loadProjects}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors"
            >
              重试
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-400">暂无可用项目</p>
            <p className="text-sm text-gray-500 mt-2">请联系管理员添加项目或分配权限</p>
          </div>
        ) : (
          <>
            <div className="space-y-3 max-h-96 overflow-y-auto mb-6">
              {projects.map((project) => (
                <button
                  key={project.project_id}
                  onClick={() => setSelectedProjectId(project.project_id)}
                  className={`w-full p-4 rounded-xl border-2 transition-all text-left ${
                    selectedProjectId === project.project_id
                      ? 'border-purple-500 bg-purple-500/10'
                      : 'border-gray-700 hover:border-gray-600 bg-[#0f111a]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-white">{project.project_name}</p>
                      <p className="text-sm text-gray-400 mt-1">
                        {project.is_member ? '个人余额' : '项目池余额'}: {project.balance} 点
                      </p>
                    </div>
                    {selectedProjectId === project.project_id && (
                      <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSelect}
                disabled={!selectedProjectId}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                确认选择
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
