import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, ReactNode } from 'react';
import type { Project, Task, Settings, User } from '../types/index';
import * as projectService from '../services/projectService';
import * as taskService from '../services/taskService';
import type { GetProjectTasksOptions } from '../services/projectService';
import type { CreateTaskPayload } from '../services/taskService';
import * as settingsService from '../services/settingsService';

// ==================== State Types ====================

interface AppState {
  projects: Project[];
  currentProject: Project | null;
  tasks: Task[];
  currentTask: Task | null;
  settings: Settings;
  loading: boolean;
  error: string | null;
}

type Action =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_PROJECTS'; payload: Project[] }
  | { type: 'SET_CURRENT_PROJECT'; payload: Project | null }
  | { type: 'ADD_PROJECT'; payload: Project }
  | { type: 'UPDATE_PROJECT'; payload: Project }
  | { type: 'DELETE_PROJECT'; payload: number }
  | { type: 'SET_TASKS'; payload: Task[] }
  | { type: 'SET_CURRENT_TASK'; payload: Task | null }
  | { type: 'ADD_TASK'; payload: Task }
  | { type: 'UPDATE_TASK'; payload: Task }
  | { type: 'DELETE_TASK'; payload: number }
  | { type: 'SET_SETTINGS'; payload: Settings };

// ==================== Initial State ====================

const initialState: AppState = {
  projects: [],
  currentProject: null,
  tasks: [],
  currentTask: null,
  settings: {},
  loading: false,
  error: null,
};

// ==================== Reducer ====================

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_PROJECTS':
      return { ...state, projects: action.payload };
    case 'SET_CURRENT_PROJECT':
      return { ...state, currentProject: action.payload };
    case 'ADD_PROJECT':
      return { ...state, projects: [...state.projects, action.payload] };
    case 'UPDATE_PROJECT':
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.payload.id ? action.payload : p
        ),
        currentProject:
          state.currentProject?.id === action.payload.id
            ? action.payload
            : state.currentProject,
      };
    case 'DELETE_PROJECT':
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== action.payload),
        currentProject:
          state.currentProject?.id === action.payload ? null : state.currentProject,
      };
    case 'SET_TASKS':
      return { ...state, tasks: action.payload };
    case 'SET_CURRENT_TASK':
      return { ...state, currentTask: action.payload };
    case 'ADD_TASK':
      return { ...state, tasks: [...state.tasks, action.payload] };
    case 'UPDATE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.payload.id ? action.payload : t
        ),
        currentTask:
          state.currentTask?.id === action.payload.id
            ? action.payload
            : state.currentTask,
      };
    case 'DELETE_TASK':
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.payload),
        currentTask:
          state.currentTask?.id === action.payload ? null : state.currentTask,
      };
    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };
    default:
      return state;
  }
}

// ==================== Context ====================

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  currentUser: User | null;
  // Project actions
  loadProjects: () => Promise<void>;
  createProjectAction: (name: string, description?: string, settings?: Record<string, any>) => Promise<Project>;
  updateProjectAction: (id: number, data: Partial<Project>) => Promise<void>;
  deleteProjectAction: (id: number) => Promise<void>;
  selectProject: (project: Project | null) => void;
  loadProjectTasks: (projectId: number, options?: GetProjectTasksOptions) => Promise<void>;
  // Task actions
  createTaskAction: (projectId: number, payload: CreateTaskPayload) => Promise<Task>;
  updateTaskAction: (id: number, data: Partial<Task>) => Promise<void>;
  deleteTaskAction: (id: number) => Promise<void>;
  // Settings
  loadSettings: () => Promise<void>;
  updateSettingsAction: (settings: Record<string, string>) => Promise<void>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

// ==================== Provider ====================

export function AppProvider({ children, currentUser }: { children: ReactNode; currentUser: User | null }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const loadProjects = useCallback(async () => {
    if (!currentUser) {
      dispatch({ type: 'SET_PROJECTS', payload: [] });
      dispatch({ type: 'SET_CURRENT_PROJECT', payload: null });
      dispatch({ type: 'SET_TASKS', payload: [] });
      dispatch({ type: 'SET_CURRENT_TASK', payload: null });
      dispatch({ type: 'SET_ERROR', payload: null });
      dispatch({ type: 'SET_LOADING', payload: false });
      return;
    }

    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      const projects = await projectService.getProjects();
      dispatch({ type: 'SET_PROJECTS', payload: projects });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: error instanceof Error ? error.message : '加载项目失败' });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [currentUser]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const createProjectAction = useCallback(async (
    name: string,
    description?: string,
    settings?: Record<string, any>
  ): Promise<Project> => {
    const project = await projectService.createProject(name, description, settings);
    dispatch({ type: 'ADD_PROJECT', payload: project });
    return project;
  }, []);

  const updateProjectAction = useCallback(async (
    id: number,
    data: Partial<Project>
  ): Promise<void> => {
    const project = await projectService.updateProject(id, data);
    dispatch({ type: 'UPDATE_PROJECT', payload: project });
  }, []);

  const deleteProjectAction = useCallback(async (id: number): Promise<void> => {
    await projectService.deleteProject(id);
    dispatch({ type: 'DELETE_PROJECT', payload: id });
  }, []);

  const loadProjectTasks = useCallback(async (projectId: number, options: GetProjectTasksOptions = {}) => {
    try {
      const tasks = await projectService.getProjectTasks(projectId, options);
      dispatch({ type: 'SET_TASKS', payload: tasks });
    } catch (error) {
      dispatch({
        type: 'SET_ERROR',
        payload: error instanceof Error ? error.message : '加载任务失败',
      });
    }
  }, []);

  const selectProject = useCallback((project: Project | null) => {
    dispatch({ type: 'SET_CURRENT_PROJECT', payload: project });
    if (project) {
      void loadProjectTasks(project.id);
    } else {
      dispatch({ type: 'SET_TASKS', payload: [] });
    }
  }, [loadProjectTasks]);

  const createTaskAction = useCallback(async (
    projectId: number,
    payload: CreateTaskPayload
  ): Promise<Task> => {
    const task = await taskService.createTask(projectId, payload);
    dispatch({ type: 'ADD_TASK', payload: task });
    return task;
  }, []);

  const updateTaskAction = useCallback(async (
    id: number,
    data: Partial<Task>
  ): Promise<void> => {
    const task = await taskService.updateTask(id, data);
    dispatch({ type: 'UPDATE_TASK', payload: task });
  }, []);

  const deleteTaskAction = useCallback(async (id: number): Promise<void> => {
    await taskService.deleteTask(id);
    dispatch({ type: 'DELETE_TASK', payload: id });
  }, []);

  const loadSettings = useCallback(async () => {
    if (!currentUser) {
      dispatch({ type: 'SET_SETTINGS', payload: {} });
      return;
    }

    try {
      const settings = await settingsService.getSettings();
      dispatch({ type: 'SET_SETTINGS', payload: settings });
    } catch (error) {
      console.error('加载设置失败:', error);
    }
  }, [currentUser]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateSettingsAction = useCallback(async (
    settings: Record<string, string>
  ): Promise<void> => {
    const updated = await settingsService.updateSettings(settings);
    dispatch({ type: 'SET_SETTINGS', payload: updated });
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    state,
    dispatch,
    currentUser,
    loadProjects,
    createProjectAction,
    updateProjectAction,
    deleteProjectAction,
    selectProject,
    loadProjectTasks,
    createTaskAction,
    updateTaskAction,
    deleteTaskAction,
    loadSettings,
    updateSettingsAction,
  }), [
    state,
    currentUser,
    loadProjects,
    createProjectAction,
    updateProjectAction,
    deleteProjectAction,
    selectProject,
    loadProjectTasks,
    createTaskAction,
    updateTaskAction,
    deleteTaskAction,
    loadSettings,
    updateSettingsAction,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ==================== Hook ====================

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}

export default { AppProvider, useApp };
