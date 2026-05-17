import { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import * as settingsService from '../services/settingsService';
import { fetchProviderStatus } from '../services/modelService';
import { RATIO_OPTIONS, DURATION_OPTIONS, RESOLUTION_OPTIONS } from '../types/index';
import { useVideoModels, getResolutionsForModel } from '../hooks/useVideoModels';
import { SparkleIcon } from '../components/Icons';
import { useToast } from '../components/Toast';

function settingBool(value: string | undefined, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

export default function SettingsPage() {
  const { toast } = useToast();
  const { state, updateSettingsAction, currentUser } = useApp();
  const { settings } = state;
  const { models: modelOptions, reload: reloadModels } = useVideoModels();
  const isAdmin = currentUser?.role === 'admin';

  const [localSettings, setLocalSettings] = useState({
    model: settings.model || 'luminia-2.0',
    ratio: settings.ratio || '16:9',
    duration: settings.duration || '5',
    resolution: settings.resolution || '720p',
    download_path: settings.download_path || '',
    max_concurrent: settings.max_concurrent || '5',
    min_interval: settings.min_interval || '30000',
    max_interval: settings.max_interval || '50000',
  });

  const [providerArkEnabled, setProviderArkEnabled] = useState(true);
  const [providerLuminiaEnabled, setProviderLuminiaEnabled] = useState(true);
  const [arkKeyConfigured, setArkKeyConfigured] = useState<boolean | null>(null);
  const [luminiaKeyConfigured, setLuminiaKeyConfigured] = useState<boolean | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  const resolutionChoices = useMemo(
    () => getResolutionsForModel(localSettings.model, modelOptions),
    [localSettings.model, modelOptions]
  );

  useEffect(() => {
    Promise.all([
      settingsService.getArkStatus(),
      settingsService.getLuminiaStatus(),
      fetchProviderStatus().catch(() => null),
    ])
      .then(([ark, lum, prov]) => {
        setArkKeyConfigured(Boolean(ark?.configured));
        setLuminiaKeyConfigured(Boolean(lum?.configured));
        if (prov) {
          setProviderArkEnabled(prov.provider_ark_enabled);
          setProviderLuminiaEnabled(prov.provider_luminia_enabled);
        } else {
          setProviderArkEnabled(settingBool(settings.provider_ark_enabled));
          setProviderLuminiaEnabled(settingBool(settings.provider_luminia_enabled));
        }
      })
      .catch(() => {
        setArkKeyConfigured(null);
        setLuminiaKeyConfigured(null);
      });
  }, [settings.provider_ark_enabled, settings.provider_luminia_enabled]);

  useEffect(() => {
    if (!modelOptions.some((m) => m.value === localSettings.model) && modelOptions[0]) {
      setLocalSettings((prev) => ({ ...prev, model: modelOptions[0].value }));
    }
  }, [modelOptions, localSettings.model]);

  useEffect(() => {
    if (!resolutionChoices.includes(localSettings.resolution as typeof RESOLUTION_OPTIONS[number])) {
      setLocalSettings((prev) => ({ ...prev, resolution: resolutionChoices[0] || '720p' }));
    }
  }, [resolutionChoices, localSettings.resolution]);

  const handleSave = async () => {
    try {
      const payload: Record<string, string> = { ...localSettings };
      if (isAdmin) {
        payload.provider_ark_enabled = providerArkEnabled ? '1' : '0';
        payload.provider_luminia_enabled = providerLuminiaEnabled ? '1' : '0';
      }
      await updateSettingsAction(payload);
      setHasChanges(false);
      await reloadModels();
      toast.success('设置已保存');
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : error}`);
    }
  };

  useEffect(() => {
    const changed =
      localSettings.model !== settings.model ||
      localSettings.ratio !== settings.ratio ||
      localSettings.duration !== settings.duration ||
      localSettings.resolution !== settings.resolution ||
      localSettings.download_path !== settings.download_path ||
      localSettings.max_concurrent !== settings.max_concurrent ||
      localSettings.min_interval !== settings.min_interval ||
      localSettings.max_interval !== settings.max_interval ||
      (isAdmin &&
        (providerArkEnabled !== settingBool(settings.provider_ark_enabled) ||
          providerLuminiaEnabled !== settingBool(settings.provider_luminia_enabled)));
    setHasChanges(changed);
  }, [localSettings, settings, isAdmin, providerArkEnabled, providerLuminiaEnabled]);

  return (
    <div className="h-screen overflow-y-auto bg-[#0f111a] text-white">
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">全局设置</h1>

        {/* 方舟 API Key 状态（只读，由管理员通过环境变量配置） */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <SparkleIcon className="w-5 h-5 text-purple-400" />
            视频 API 平台
          </h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-[#0f111a] border border-gray-700 rounded-lg">
              <div>
                <div className="text-sm font-medium text-gray-200">Luminia（主用）</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Key: {luminiaKeyConfigured === null ? '检测中…' : luminiaKeyConfigured ? '已配置' : '未配置'}
                </div>
              </div>
              {isAdmin && (
                <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={providerLuminiaEnabled}
                    disabled={!luminiaKeyConfigured}
                    onChange={(e) => setProviderLuminiaEnabled(e.target.checked)}
                    className="accent-purple-500"
                  />
                  启用
                </label>
              )}
            </div>
            <div className="flex items-center justify-between p-3 bg-[#0f111a] border border-gray-700 rounded-lg">
              <div>
                <div className="text-sm font-medium text-gray-200">火山方舟（应急）</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Key: {arkKeyConfigured === null ? '检测中…' : arkKeyConfigured ? '已配置' : '未配置'}
                </div>
              </div>
              {isAdmin && (
                <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={providerArkEnabled}
                    disabled={!arkKeyConfigured}
                    onChange={(e) => setProviderArkEnabled(e.target.checked)}
                    className="accent-purple-500"
                  />
                  启用
                </label>
              )}
            </div>
          </div>
          {!isAdmin && (
            <p className="mt-3 text-xs text-gray-500">
              平台开关由管理员控制；API Key 在服务端 <code>.env</code> 中配置。
            </p>
          )}
        </div>
        {/* 模型设置 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">批量模型设置</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                选择模型
              </label>
              <div className="space-y-2">
                {modelOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() =>
                      setLocalSettings((prev) => ({ ...prev, model: option.value }))
                    }
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                      localSettings.model === option.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div
                      className={`text-sm font-medium ${
                        localSettings.model === option.value
                          ? 'text-purple-400'
                          : 'text-gray-300'
                      }`}
                    >
                      {option.label}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {option.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>



            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                画面比例
              </label>
              <div className="grid grid-cols-6 gap-2">
                {RATIO_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() =>
                      setLocalSettings((prev) => ({ ...prev, ratio: opt.value }))
                    }
                    className={`flex flex-col items-center gap-1.5 py-2 rounded-lg border transition-all ${
                      localSettings.ratio === opt.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center justify-center w-8 h-8">
                      <div
                        className={`rounded-sm border ${
                          localSettings.ratio === opt.value
                            ? 'border-purple-400'
                            : 'border-gray-500'
                        }`}
                        style={{
                          width: `${(opt.widthRatio / Math.max(opt.widthRatio, opt.heightRatio)) * 24}px`,
                          height: `${(opt.heightRatio / Math.max(opt.widthRatio, opt.heightRatio)) * 24}px`,
                        }}
                      />
                    </div>
                    <span
                      className={`text-[11px] ${
                        localSettings.ratio === opt.value
                          ? 'text-purple-400'
                          : 'text-gray-400'
                      }`}
                    >
                      {opt.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                视频时长 (秒)
              </label>
              <div className="flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() =>
                      setLocalSettings((prev) => ({
                        ...prev,
                        duration: String(d),
                      }))
                    }
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                      localSettings.duration === String(d)
                        ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                        : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {d}秒
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                输出分辨率
              </label>
              <div className="flex flex-wrap gap-2">
                {resolutionChoices.map((r) => {
                  const is1080pDisabled = !resolutionChoices.includes('1080p') && r === '1080p';
                  return (
                    <button
                      key={r}
                      onClick={() => !is1080pDisabled && setLocalSettings((prev) => ({
                        ...prev,
                        resolution: r,
                      }))}
                      disabled={is1080pDisabled}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                        localSettings.resolution === r
                          ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                          : is1080pDisabled
                          ? 'border-gray-800 bg-gray-900 text-gray-600 cursor-not-allowed'
                          : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                当前统一仅支持 480p、720p（1080p 暂未开放）
              </p>
            </div>
          </div>
        </div>

        {/* 批量生成设置 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">批量生成设置</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                最大并发数
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={localSettings.max_concurrent}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    max_concurrent: e.target.value,
                  }))
                }
                className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                最小间隔 (毫秒)
              </label>
              <input
                type="number"
                min="10000"
                max="60000"
                step="1000"
                value={localSettings.min_interval}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    min_interval: e.target.value,
                  }))
                }
                className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                最大间隔 (毫秒)
              </label>
              <input
                type="number"
                min="30000"
                max="120000"
                step="1000"
                value={localSettings.max_interval}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    max_interval: e.target.value,
                  }))
                }
                className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>
        </div>

        {/* 下载路径设置 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">下载路径设置</h2>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">
              视频保存路径
            </label>
            <input
              type="text"
              value={localSettings.download_path}
              onChange={(e) =>
                setLocalSettings((prev) => ({
                  ...prev,
                  download_path: e.target.value,
                }))
              }
              placeholder="留空则使用默认路径：~/Videos/Seedance"
              className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
            />
            <p className="text-xs text-gray-500 mt-2">
              生成的视频将自动保存到此目录下的对应项目文件夹中
            </p>
          </div>
        </div>

        {/* 保存按钮 */}
        <div className="flex justify-end gap-3 sticky bottom-0 bg-[#0f111a] py-4 border-t border-gray-800 -mx-6 px-6">
          <button
            onClick={() =>
              setLocalSettings({
                model: settings.model || 'luminia-2.0',
                ratio: settings.ratio || '16:9',
                duration: settings.duration || '5',
                resolution: settings.resolution || '720p',
                download_path: settings.download_path || '',
                max_concurrent: settings.max_concurrent || '5',
                min_interval: settings.min_interval || '30000',
                max_interval: settings.max_interval || '50000',
              })
            }
            className="px-6 py-2.5 text-gray-400 hover:text-white transition-colors"
          >
            重置
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges}
            className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 rounded-lg transition-all font-medium shadow-lg shadow-purple-900/20"
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
