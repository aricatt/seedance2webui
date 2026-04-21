import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';

// ============================================================
// Types
// ============================================================
type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  /** 返回非空字符串表示校验错误，返回 null 表示通过 */
  validator?: (value: string) => string | null;
  /** 是否允许空字符串提交；默认 false（空会触发"不能为空"校验） */
  allowEmpty?: boolean;
  /** 是否用多行 textarea，默认 false */
  multiline?: boolean;
}

interface ToastContextType {
  toast: {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
    warning: (msg: string) => void;
  };
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 文本输入弹窗；取消返回 null，确认返回 trim 后字符串 */
  prompt: (options: PromptOptions) => Promise<string | null>;
}

// ============================================================
// Context
// ============================================================
const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

// ============================================================
// Icons
// ============================================================
function SuccessIcon() {
  return (
    <svg className="w-5 h-5 text-green-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}
function ErrorIcon() {
  return (
    <svg className="w-5 h-5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg className="w-5 h-5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
function WarningIcon() {
  return (
    <svg className="w-5 h-5 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );
}

const IconMap: Record<ToastType, () => JSX.Element> = {
  success: SuccessIcon,
  error: ErrorIcon,
  info: InfoIcon,
  warning: WarningIcon,
};

const borderMap: Record<ToastType, string> = {
  success: 'border-green-500/40',
  error: 'border-red-500/40',
  info: 'border-blue-500/40',
  warning: 'border-amber-500/40',
};

// ============================================================
// Toast Item Component
// ============================================================
function ToastItemView({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(item.id), 300);
    }, item.duration);
    return () => clearTimeout(timer);
  }, [item, onDismiss]);

  const Icon = IconMap[item.type];

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-md
        bg-[#1c1f2e]/95 shadow-xl shadow-black/20
        ${borderMap[item.type]}
        transition-all duration-300 ease-out
        ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}
      `}
      style={{ minWidth: 280, maxWidth: 420 }}
    >
      <Icon />
      <span className="text-sm text-gray-200 leading-relaxed break-words">{item.message}</span>
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(() => onDismiss(item.id), 300);
        }}
        className="ml-auto text-gray-500 hover:text-gray-300 transition-colors shrink-0"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ============================================================
// Confirm Dialog Component
// ============================================================
function ConfirmDialog({
  options,
  onResult,
}: {
  options: ConfirmOptions;
  onResult: (ok: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
      <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-in">
        {options.title && (
          <h3 className="text-lg font-semibold text-white mb-2">{options.title}</h3>
        )}
        <p className="text-gray-300 text-sm leading-relaxed mb-6 whitespace-pre-line">
          {options.message}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => onResult(false)}
            className="flex-1 px-4 py-2.5 bg-[#0f111a] border border-gray-700 text-gray-300 hover:bg-gray-800 rounded-xl text-sm font-medium transition-all"
          >
            {options.cancelText || '取消'}
          </button>
          <button
            onClick={() => onResult(true)}
            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all text-white ${
              options.danger
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600'
            }`}
          >
            {options.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Prompt Dialog Component
// ============================================================
function PromptDialog({
  options,
  onResult,
}: {
  options: PromptOptions;
  onResult: (value: string | null) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const [error, setError] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      if (inputRef.current && 'select' in inputRef.current) {
        try {
          (inputRef.current as HTMLInputElement).select();
        } catch {
          /* ignore */
        }
      }
    }, 30);
    return () => clearTimeout(t);
  }, []);

  const validate = (v: string): string | null => {
    const trimmed = v.trim();
    if (!trimmed && !options.allowEmpty) return '不能为空';
    if (options.validator) return options.validator(trimmed);
    return null;
  };

  const submit = () => {
    const err = validate(value);
    if (err) {
      setError(err);
      return;
    }
    onResult(options.allowEmpty ? value : value.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onResult(null);
    } else if (e.key === 'Enter' && !options.multiline) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && options.multiline) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[9999] p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResult(null);
      }}
    >
      <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        {options.title && (
          <h3 className="text-lg font-semibold text-white mb-2">{options.title}</h3>
        )}
        {options.message && (
          <p className="text-gray-400 text-sm leading-relaxed mb-4 whitespace-pre-line">
            {options.message}
          </p>
        )}
        {options.multiline ? (
          <textarea
            ref={(el) => {
              inputRef.current = el;
            }}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={handleKeyDown}
            placeholder={options.placeholder}
            className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none min-h-[96px]"
            rows={4}
          />
        ) : (
          <input
            ref={(el) => {
              inputRef.current = el;
            }}
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={handleKeyDown}
            placeholder={options.placeholder}
            className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
          />
        )}
        {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
        <div className="flex gap-3 mt-5">
          <button
            onClick={() => onResult(null)}
            className="flex-1 px-4 py-2.5 bg-[#0f111a] border border-gray-700 text-gray-300 hover:bg-gray-800 rounded-xl text-sm font-medium transition-all"
          >
            {options.cancelText || '取消'}
          </button>
          <button
            onClick={submit}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all text-white bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
          >
            {options.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Provider
// ============================================================
let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [promptState, setPromptState] = useState<{
    options: PromptOptions;
    resolve: (value: string | null) => void;
  } | null>(null);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string, duration = 3500) => {
    const id = ++nextId;
    setToasts((prev) => [...prev.slice(-4), { id, type, message, duration }]);
  }, []);

  const toast = {
    success: (msg: string) => addToast('success', msg),
    error: (msg: string) => addToast('error', msg, 5000),
    info: (msg: string) => addToast('info', msg),
    warning: (msg: string) => addToast('warning', msg, 4000),
  };

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setConfirmState({ options, resolve });
      }),
    []
  );

  const handleConfirmResult = useCallback(
    (ok: boolean) => {
      confirmState?.resolve(ok);
      setConfirmState(null);
    },
    [confirmState]
  );

  const prompt = useCallback(
    (options: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        setPromptState({ options, resolve });
      }),
    []
  );

  const handlePromptResult = useCallback(
    (value: string | null) => {
      promptState?.resolve(value);
      setPromptState(null);
    },
    [promptState]
  );

  return (
    <ToastContext.Provider value={{ toast, confirm, prompt }}>
      {children}

      {/* Toast container */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-auto">
        {toasts.map((item) => (
          <ToastItemView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>

      {/* Confirm dialog */}
      {confirmState && (
        <ConfirmDialog options={confirmState.options} onResult={handleConfirmResult} />
      )}

      {/* Prompt dialog */}
      {promptState && (
        <PromptDialog options={promptState.options} onResult={handlePromptResult} />
      )}
    </ToastContext.Provider>
  );
}
