/**
 * 方舟 API 全局配置
 * - 整个系统只使用一把 API Key, 从环境变量 ARK_API_KEY 读取
 * - 内网部署: 用户在 UI 中看不到 API Key, 由管理员通过 .env 配置
 */

export const ARK_API_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_DEFAULT_MODEL = 'doubao-seedance-2-0-260128';

/**
 * 读取 API Key。缺失时抛错 (调用点负责决定是 fail-fast 还是返回业务错误)。
 */
export function getArkApiKey() {
  const key = (process.env.ARK_API_KEY || '').trim();
  if (!key) {
    throw new Error(
      'ARK_API_KEY 未配置。请在服务端 .env 中设置方舟 API Key (https://console.volcengine.com/ark)。'
    );
  }
  return key;
}

/**
 * 启动时预检, 未配置则进程直接退出, 避免后续请求批量失败。
 */
export function assertArkApiKeyOrExit() {
  try {
    const key = getArkApiKey();
    return key;
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }
}
