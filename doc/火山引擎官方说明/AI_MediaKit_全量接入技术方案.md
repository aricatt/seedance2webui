# AI MediaKit 全量接入技术方案

> 本文档面向 Cursor 等 AI 编程工具使用，基于火山引擎 AI MediaKit 官方文档与计费说明编写，覆盖所有原子能力的完整接入说明，供开发人员直接参考和实现。

---

## 一、产品概述

### 1.1 产品定位

AI MediaKit 是火山引擎面向 AI 视频应用场景的多媒体开发套件，围绕 MaaS（Model-as-a-Service）平台补全"生成 → 处理 → 交付"的全链路能力。**本质是一套 API / SDK 工具包**，不提供独立的 C 端产品界面。

核心定位：
- 不替代基础生成模型（如 Seedance），而是围绕模型补全周边能力
- 让 AI 生成的视频"能用、好看、成本低"

### 1.2 能力总览

MediaKit 提供两条链路：

**后处理链路（生成之后）**

| 能力 | 功能 | 典型场景 |
|------|------|---------|
| 画质增强 | 超分、插帧、去噪，专业版支持 4K/8K | AI 视频分辨率提升 |
| 字幕擦除 | 无痕擦除内嵌字幕 | 出海翻译、广告本地化 |
| 视频剪辑 | 拼接、裁剪、合成、配字幕 | AIGC 素材组装 |
| 音频分离 | 人声/背景音分离 | 配音替换、BGM 调整 |

**前处理链路（理解之前）**

| 能力 | 功能 | 典型场景 |
|------|------|---------|
| 视频理解扩展 | 支持 5GB 文件、ASR+OCR 辅助理解 | 方舟视频理解场景扩展 |
| 音频理解前处理 | 切片、降噪、分离 | 语音识别准确率提升 |

### 1.3 与方舟的关系

方舟（MaaS）负责生成，MediaKit 负责后处理。两者组合使用的典型链路：

```
方舟 API 生成 480P 视频
        ↓
MediaKit 画质增强 → 1080P / 50FPS
        ↓
MediaKit 字幕擦除（如需要）
        ↓
MediaKit 音频分离（如需要）
        ↓
MediaKit 视频剪辑（如需要）→ 最终交付
```

**成本优化案例**：Seedance 生成 480P + MediaKit 标准版增强，比直出 720P 成本降低 **52%**。

### 1.4 接入前提

- 已有火山引擎账号和项目
- 已有方舟 MaaS 平台的 API Key（MediaKit 和方舟是独立的 Key）
- 需要接入的视频 URL 公网可访问（MediaKit 从 URL 拉流处理）

---

## 二、前置准备

### 2.1 获取 MediaKit API Key

1. 登录 [火山引擎控制台](https://console.volcengine.com/imp/ai-mediakit/settings)
2. 在「API Key 管理」中创建 Key
3. 获取 `MediaKit_API_Key`

### 2.2 基础调用规范

- **Base URL**：`https://amk.cn-beijing.volces.com/api/v1`
- **认证**：所有请求携带 Header `Authorization: Bearer {MediaKit_API_Key}`
- **Content-Type**：`application/json`
- **工作模式**：全异步——提交任务 → 轮询状态 → 获取结果 URL

### 2.3 通用错误码

| 错误码 | 含义 |
|--------|------|
| 400 | 参数校验失败 |
| 401 | API Key 无效或未授权 |
| 403 | 无权限调用该工具 |
| 404 | 任务不存在 |
| 429 | 请求频率超限 |
| 500 | 服务端内部错误 |
| 任务 status=failed | 任务处理失败，详见 error_msg |

### 2.4 通用轮询函数（Python）

```python
import time, requests

AMK_API_KEY = "your_api_key"
ENDPOINT = "https://amk.cn-beijing.volces.com/api/v1"

def poll_task(task_id: str, interval: int = 5, timeout: int = 600) -> dict:
    """
    轮询任务状态直到完成或超时。
    返回 result 字段内容。
    """
    start = time.time()
    while True:
        if time.time() - start > timeout:
            raise TimeoutError(f"任务 {task_id} 轮询超时（{timeout}s）")
        resp = requests.get(
            f"{ENDPOINT}/tasks/{task_id}",
            headers={"Authorization": f"Bearer {AMK_API_KEY}"}
        )
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status")
        if status == "completed":
            return data.get("result", {})
        elif status == "failed":
            raise Exception(f"任务失败: {data.get('error_msg')}")
        time.sleep(interval)
```

---

## 三、画质增强（Video Enhance）

### 3.1 能力说明

MediaKit 的核心能力，解决 AI 生成视频分辨率低、帧率低的痛点。

| 痛点 | 解法 |
|------|------|
| AI 视频普遍 480P/720P | 智能超分，最高支持 4K/8K |
| 帧率低画面卡顿 | 智能插帧，最高 120FPS |
| 生成 720P 成本高 | Seedance 480P + 增强，成本降低 52% |

**标杆案例**：2026 春晚大屏，Seedance 2.0 生成 720P/24FPS → MediaKit 处理后输出 **8K/50FPS**，满足超高清播出标准。

### 3.2 提交增强任务

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/enhance-video' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/seedance_output.mp4",
    "scene": "aigc",
    "resolution": "1080p",
    "fps": 50
  }'
```

**参数说明**

| 参数 | 类型 | 必填 | 说明 | 建议值 |
|------|------|------|------|--------|
| `video_url` | string | 是 | Seedance 输出的视频公网地址 | 必填 |
| `scene` | string | 是 | 场景类型 | `aigc`（AI 生成视频）或 `general` |
| `resolution` | string | 是 | 目标分辨率 | `480p` / `720p` / `1080p` / `4k` |
| `fps` | integer | 否 | 目标帧率，不填则保持原帧率 | 要插帧时填 `50` / `60` / `120` |

**返回**

```json
{
  "success": true,
  "task_id": "amk-tool-enhance-video-1703200",
  "request_id": "20260415150000F6DE4C24A6A0D94B7FF1"
}
```

### 3.3 轮询获取结果

使用通用轮询函数，`result` 字段示例：

```json
{
  "duration": 5.967,
  "fps": 30.168,
  "resolution": "1080p",
  "tool_version": "standard",
  "video_url": "https://xxx.volcvideo.com/enhanced_video.mp4?auth_key=..."
}
```

**结果有效期**：结果 URL 有效期 **48 小时**，及时下载或转存。

### 3.4 完整 Python 示例

```python
def submit_enhance(video_url: str, resolution: str = "1080p",
                    fps: int = None, scene: str = "aigc") -> str:
    payload = {
        "video_url": video_url,
        "scene": scene,
        "resolution": resolution
    }
    if fps:
        payload["fps"] = fps
    resp = requests.post(
        f"{ENDPOINT}/tools/enhance-video",
        json=payload,
        headers={"Authorization": f"Bearer {AMK_API_KEY}"}
    )
    resp.raise_for_status()
    return resp.json()["task_id"]

# 端到端示例：方舟生成 → MediaKit 增强
方舟_output_url = "https://ark.cn-beijing.volcapi.com/seedance/xxx.mp4"
task_id = submit_enhance(
    video_url=方舟_output_url,
    resolution="1080p",
    fps=50
)
result = poll_task(task_id)
print("增强后视频:", result["video_url"])
print("输出分辨率:", result["resolution"])
print("输出帧率:", result["fps"])
```

### 3.5 版本说明

| 版本 | 适用场景 | 质量 | 费用 |
|------|---------|------|------|
| 标准版 | 大多数 AI 视频增强 | 高 | 标准费率 |
| 专业版 | 超高清播出、专业影视级 | 极高 | 10 倍标准费率 |

> 专业版适合春晚、院线等对画质有极端要求的场景，普通业务用标准版即可。

---

## 四、字幕擦除（Subtitle Erasure）

### 4.1 能力说明

高质量无痕擦除视频中的内嵌字幕，支持两种模式：

| 版本 | 效果 | 费用 |
|------|------|------|
| 标准版 | 通用字幕擦除 | 0.4 元/分钟 |
| 精细化版 | 边缘更精细，无痕迹 | 1.0 元/分钟 |

### 4.2 提交擦除任务

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/erase-subtitle' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/video_with_subtitle.mp4",
    "mode": "fine"
  }'
```

**参数说明**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `video_url` | string | 是 | 视频公网地址 |
| `mode` | string | 否 | `normal`（标准，默认）/ `fine`（精细化） |

**返回**

```json
{
  "success": true,
  "task_id": "amk-tool-erase-subtitle-1703201"
}
```

### 4.3 Python 示例

```python
def erase_subtitle(video_url: str, mode: str = "normal") -> str:
    resp = requests.post(
        f"{ENDPOINT}/tools/erase-subtitle",
        json={"video_url": video_url, "mode": mode},
        headers={"Authorization": f"Bearer {AMK_API_KEY}"}
    )
    resp.raise_for_status()
    return resp.json()["task_id"]

# 精细化擦除，适用于出海翻译场景
task_id = erase_subtitle(
    "https://your-cdn.com/short_drama_ep1.mp4",
    mode="fine"
)
result = poll_task(task_id)
print("擦除后视频:", result["video_url"])
```

---

## 五、人声背景音分离（Audio Separation）

### 5.1 能力说明

将混合音轨分离为独立的人声和背景音轨道，便于二次创作。

- **费用**：0.07 元/分钟（按输入音频时长）
- **输出**：人声音轨 URL + 背景音轨 URL

### 5.2 提交分离任务

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/separate-audio' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/mixed_audio.mp4",
    "task_type": "all"
  }'
```

**参数说明**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `video_url` | string | 是 | 视频公网地址 |
| `task_type` | string | 否 | `all`（人声+背景音，默认）/ `vocal`（仅人声）/ `background`（仅背景音） |

### 5.3 Python 示例

```python
def separate_audio(video_url: str, task_type: str = "all") -> str:
    resp = requests.post(
        f"{ENDPOINT}/tools/separate-audio",
        json={"video_url": video_url, "task_type": task_type},
        headers={"Authorization": f"Bearer {AMK_API_KEY}"}
    )
    resp.raise_for_status()
    return resp.json()["task_id"]

# 分离后人声和背景音可独立处理
task_id = separate_audio("https://your-cdn.com/seedance_with_music.mp4")
result = poll_task(task_id)
print("人声音轨:", result["vocal_url"])      # AAC 格式
print("背景音轨:", result["background_url"])  # AAC 格式

# 后续可对背景音轨做音量调整、替换 BGM 等操作
```

---

## 六、视频剪辑（Video Editing）

### 6.1 能力说明

MediaKit 提供剪辑工具集，适用于 AIGC 视频片段的组装、拼接、合成。

**适用工具**：视频拼接、音频拼接、视频裁剪、音频裁剪、音视频合成、图片转视频、音频提取

**Web 剪辑 SDK**：MediaKit 还提供一个可嵌入的 Web 剪辑 SDK，适合需要二次编辑界面的场景（生成 → 编辑 → 导出闭环）。

### 6.2 API 剪辑工具

完整剪辑 API 文档：[视频拼接](https://www.volcengine.com/docs/6448/2279956)

以下是需要重点关注的两个场景：

#### 6.2.1 视频拼接

将多个视频片段合并为一个：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/merge-video' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_list": [
      {"video_url": "https://cdn.com/clip1.mp4"},
      {"video_url": "https://cdn.com/clip2.mp4"},
      {"video_url": "https://cdn.com/clip3.mp4"}
    ],
    "output_resolution": "1080p"
  }'
```

#### 6.2.2 音频提取

从视频中提取独立音轨（用于后续配音替换）：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/extract-audio' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/seedance_output.mp4"
  }'
```

#### 6.2.3 音视频合成

将处理后的音频与视频合并：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/compose-av' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://cdn.com/video_enhanced.mp4",
    "audio_url": "https://cdn.com/new_bgm.aac",
    "audio_volume": 0.5,
    "video_volume": 0.0,
    "output_resolution": "1080p"
  }'
```

### 6.3 Web 剪辑 SDK

**适用场景**：想给用户一个编辑界面（生成 → 调整 → 导出），而非纯 API 调用。

**支持能力**：裁剪、拼接、分段、变速、画面翻转、音量调节、花字水印、字幕压制等。

**接入方式**：通过 MediaKit 控制台申请 SDK，集成到自有平台。

> 注意：SDK 底层调用的仍是 MediaKit API，费用按剪辑工具计费标准执行。

---

## 七、前处理链路（Video Understanding Extension）

### 7.1 能力说明

配合方舟视频理解能力，解决方舟原生的限制：

| 方舟限制 | MediaKit 解法 |
|---------|-------------|
| 视频文件上限 50MB/512MB | MediaKit 支持最高 **5GB** |
| 无法理解音频 | 内置 ASR + OCR 辅助多模态理解 |
| Token 消耗高 | 关键帧 + 场景检测抽帧，节省 **90%+ Token** |

### 7.2 场景切分（Scene Segmentation）

将长视频按场景切分为多个片段，便于方舟分批理解：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/scene-segment' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/long_video.mp4"
  }'
```

**费用**：0.02 元/分钟（按输入文件时长）

### 7.3 语音转字幕（ASR）

将视频音频转为字幕文件，辅助方舟理解：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/asr' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/video.mp4"
  }'
```

**费用**：0.03 元/分钟（按输入文件时长）

### 7.4 视频识别字幕（OCR）

识别视频中的内嵌文字（Logo、字幕、标题等）：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/ocr' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/video.mp4"
  }'
```

**费用**：0.25 元/分钟（按输入文件时长）

### 7.5 高光智剪（Highlight Clipping）

自动识别并提取视频高光片段，支持短剧和小游戏场景：

```bash
curl -X POST 'https://amk.cn-beijing.volces.com/api/v1/tools/highlight-clip' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {MediaKit_API_Key}' \
  -d '{
    "video_url": "https://your-cdn.com/short_drama.mp4",
    "scene_type": "short_drama"
  }'
```

**费用**：1 元/分钟（输入时长 + 所有输出时长之和）

---

## 八、大模型处理（Video Understanding）

### 8.1 能力说明

调用方舟大模型对视频进行多模态理解（如视频描述、内容分析、分类等）。

### 8.2 计费说明

- **费用来源**：由方舟大模型服务收取，MediaKit 本身不收媒体处理费
- **计费逻辑**：按输入+输出 Token 总数计费
- **参考价格**：详见 [方舟大模型服务计费说明](https://www.volcengine.com/docs/82379/1544681)

---

## 九、端到端组合链路

### 链路一：生成 → 增强 → 交付（最常用）

适用于大多数 AIGC 视频落地场景。

```
方舟 API 生成 480P/24fps 视频
        ↓
MediaKit 画质增强 → 1080P/50fps
        ↓
下载/转存 CDN → 最终交付
```

```python
def pipeline_generate_and_enhance(seedance_output_url: str) -> str:
    # Step 1: 画质增强
    task_id = submit_enhance(seedance_output_url, "1080p", fps=50)
    result = poll_task(task_id)
    return result["video_url"]
```

### 链路二：出海短剧翻译

适用于将国内短剧本地化出海。

```
方舟生成视频（含中文字幕）
        ↓
MediaKit 字幕擦除（精细化版）→ 干净视频
        ↓
MediaKit 画质增强 → 1080P
        ↓
MediaKit 语音转字幕（ASR）→ 字幕文件
        ↓
翻译字幕文件 → 目标语言
        ↓
MediaKit 音视频合成 → 添加目标语言字幕 → 最终交付
```

### 链路三：视频理解前处理

适用于方舟需要理解长视频的场景。

```
原始长视频（5GB+）
        ↓
MediaKit 场景切分 → 多个短片段
        ↓
MediaKit 语音转字幕（ASR）→ 每段字幕
        ↓
方舟视频理解（分批调用，每批附带 ASR 结果）→ 理解结果
```

### 链路四：AIGC 素材组装（生成 → 剪辑 → 交付）

适用于多个 AI 片段需要拼接合成的场景。

```
方舟生成 N 个视频片段
        ↓
MediaKit 画质增强（逐个）
        ↓
MediaKit 视频拼接 → 合成完整视频
        ↓
MediaKit 音频分离（如需替换 BGM）
        ↓
MediaKit 音视频合成 → 添加新音轨
        ↓
最终交付
```

---

## 十、计费说明

### 10.1 核心公式

所有工具按以下公式计算：

```
费用 = 时长（分钟）× 计费换算系数 × 基准单价
```

- **时长**：按实际处理时长（精确到毫秒）换算成分钟
- **结果有效期**：处理后结果 URL 有效期 **48 小时**

### 10.2 画质增强计费

| 版本 | 输出分辨率 | 帧率 | 单价（元/分钟） |
|------|-----------|------|----------------|
| 标准版 | 720P 及以下 | ≤30fps | **0.75** |
| 标准版 | 720P 及以下 | >30fps | 1.5 |
| 标准版 | 1080P 及以下 | ≤30fps | 1.5 |
| 标准版 | 1080P 及以下 | >30fps | 3 |
| 标准版 | 2K 及以下 | ≤30fps | 3 |
| 标准版 | 4K 及以下 | ≤30fps | 6 |
| 专业版 | 720P 及以下 | ≤30fps | 7.5 |
| 专业版 | 1080P 及以下 | ≤30fps | 15 |
| 专业版 | 4K 及以下 | ≤30fps | 60 |

### 10.3 其他工具计费

| 工具 | 计费方式 | 单价 |
|------|---------|------|
| 字幕擦除（标准版） | 元/分钟 | 0.4 |
| 字幕擦除（精细化版） | 元/分钟 | 1.0 |
| 人声背景音分离 | 元/分钟（输入时长） | 0.07 |
| 视频拼接（剪辑工具） | 元/分钟 × 分辨率系数 | 0.01 ~ 0.24 |
| 音频提取 | 元/分钟 | 0.01 |
| 场景切分 | 元/分钟（输入时长） | 0.02 |
| 语音转字幕（ASR） | 元/分钟（输入时长） | 0.03 |
| 视频识别字幕（OCR） | 元/分钟（输入时长） | 0.25 |
| 高光智剪 | 元/分钟（输入+输出总时长） | 1.0 |

### 10.4 剪辑工具分辨率系数

| 输出分辨率 | 系数 | 换算后单价 |
|-----------|------|-----------|
| 4K 及以下 | 24 | 0.24 元/分钟 |
| 2K 及以下 | 12 | 0.12 元/分钟 |
| 1080P 及以下 | 6 | 0.06 元/分钟 |
| 720P 及以下 | 3 | 0.03 元/分钟 |
| 480P 及以下 | 1.5 | 0.015 元/分钟 |
| 360P 及以下 | 1 | 0.01 元/分钟 |

### 10.5 算账示例

**示例 1：典型 AIGC 视频增强**
- Seedance 生成 5 秒 480P → MediaKit 标准版增强到 1080P/50fps
- 计费：0.083 分钟 × 4 × 0.75 ≈ **0.25 元**
- 对比直出 720P 约 4.97 元，节省 **47%**

**示例 2：出海短剧字幕擦除**
- 处理 1 部 10 分钟短剧，精细化版擦除 + 1080P 增强
- 字幕擦除：10 × 1 × 1 = 10 元
- 画质增强（标准版 1080P ≤30fps）：10 × 2 × 0.75 = 15 元
- 合计：**25 元/部**

**示例 3：视频拼接**
- 3 个片段拼接，输出 1080P，总时长 5 分钟
- 计费：5 × 6 × 0.01 = **0.3 元**

---

## 十一、欠费与资源管理

| 阶段 | 触发时间 | 影响 |
|------|---------|------|
| 欠费关停 | 欠费后 3 天 | 停止处理新任务，无法新建 API Key |
| 资源回收 | 关停后 15 天 | 系统销毁实例，配置清空，无法恢复 |

**充值后恢复**：
- 关停状态：充值后自动恢复
- 回收状态：需在控制台重新开通服务

---

## 十二、常见问题（FAQ）

**Q1：视频 URL 必须公网可访问吗？**
> 是，MediaKit 通过 URL 拉流处理，不支持内网地址。建议使用火山引擎 VOD 或阿里云 OSS 等公网 CDN。

**Q2：处理耗时多久？**
> 画质增强约 6~10 倍原片时长（标准版），专业版更慢。建议任务设置 600s 超时。

**Q3：增强后的视频有水印吗？**
> MediaKit 处理后的视频无 MediaKit 水印，但需遵守火山引擎使用协议。

**Q4：可以批量处理多个视频吗？**
> MediaKit 本身不提供批量接口，需要调用方自己实现并发提交和轮询管理。建议并发数控制在 10 以内避免限流。

**Q5：结果 URL 过期了怎么办？**
> 建议在结果 URL 有效期内（48 小时）下载或转存到自有 CDN。

**Q6：方舟和 MediaKit 是同一个 API Key 吗？**
> 不是。两套系统独立，需要分别获取方舟 API Key 和 MediaKit API Key。

**Q7：如何选择标准版和专业版？**
> 普通业务场景用标准版即可满足质量要求。专业版适合春晚、院线、4K/8K 超高清播出等极端画质要求场景。

---

## 附录 A：Python 完整封装

```python
import time, requests
from typing import Optional

class MediaKitClient:
    """AI MediaKit Python SDK 封装"""

    def __init__(self, api_key: str, region: str = "cn-beijing"):
        self.api_key = api_key
        self.endpoint = f"https://amk.{region}.volces.com/api/v1"
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        })

    def _submit(self, tool: str, payload: dict) -> str:
        resp = self.session.post(
            f"{self.endpoint}/tools/{tool}", json=payload
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise Exception(f"提交失败: {data}")
        return data["task_id"]

    def _poll(self, task_id: str, interval: int = 5, timeout: int = 600) -> dict:
        start = time.time()
        while True:
            if time.time() - start > timeout:
                raise TimeoutError(f"任务 {task_id} 轮询超时")
            resp = self.session.get(f"{self.endpoint}/tasks/{task_id}")
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status")
            if status == "completed":
                return data.get("result", {})
            elif status == "failed":
                raise Exception(f"任务失败: {data.get('error_msg')}")
            time.sleep(interval)

    # === 画质增强 ===
    def enhance_video(self, video_url: str, resolution: str = "1080p",
                       fps: int = None, scene: str = "aigc") -> dict:
        payload = {"video_url": video_url, "scene": scene, "resolution": resolution}
        if fps:
            payload["fps"] = fps
        task_id = self._submit("enhance-video", payload)
        return self._poll(task_id)

    # === 字幕擦除 ===
    def erase_subtitle(self, video_url: str, mode: str = "normal") -> dict:
        task_id = self._submit("erase-subtitle", {"video_url": video_url, "mode": mode})
        return self._poll(task_id)

    # === 音频分离 ===
    def separate_audio(self, video_url: str, task_type: str = "all") -> dict:
        task_id = self._submit("separate-audio",
            {"video_url": video_url, "task_type": task_type})
        return self._poll(task_id)

    # === 场景切分 ===
    def scene_segment(self, video_url: str) -> dict:
        task_id = self._submit("scene-segment", {"video_url": video_url})
        return self._poll(task_id)

    # === 语音转字幕 ===
    def asr(self, video_url: str) -> dict:
        task_id = self._submit("asr", {"video_url": video_url})
        return self._poll(task_id)

    # === 视频拼接 ===
    def merge_video(self, video_list: list, output_resolution: str = "1080p") -> dict:
        task_id = self._submit("merge-video", {
            "video_list": [{"video_url": v} for v in video_list],
            "output_resolution": output_resolution
        })
        return self._poll(task_id)

    # === 音视频合成 ===
    def compose_av(self, video_url: str, audio_url: str,
                   video_volume: float = 1.0,
                   audio_volume: float = 1.0,
                   output_resolution: str = "1080p") -> dict:
        task_id = self._submit("compose-av", {
            "video_url": video_url,
            "audio_url": audio_url,
            "video_volume": video_volume,
            "audio_volume": audio_volume,
            "output_resolution": output_resolution
        })
        return self._poll(task_id)

    # === 端到端：生成 → 增强 ===
    def pipeline_generate_enhance(self, seedance_url: str,
                                    target_resolution: str = "1080p",
                                    target_fps: int = 50) -> str:
        """方舟生成 → MediaKit 增强 一键调用"""
        result = self.enhance_video(
            video_url=seedance_url,
            resolution=target_resolution,
            fps=target_fps
        )
        return result["video_url"]

    # === 端到端：字幕擦除 → 增强 → 合成 ===
    def pipeline_localization(self, raw_video_url: str,
                               new_audio_url: str = None) -> str:
        """出海本地化：擦除 → 增强 → 合成"""
        # Step 1: 精细化擦除字幕
        erased = self.erase_subtitle(raw_video_url, mode="fine")
        erased_url = erased["video_url"]

        # Step 2: 画质增强
        enhanced = self.enhance_video(erased_url, resolution="1080p", fps=50)
        enhanced_url = enhanced["video_url"]

        # Step 3: 如果有新音轨则合成
        if new_audio_url:
            composed = self.compose_av(
                video_url=enhanced_url,
                audio_url=new_audio_url,
                audio_volume=1.0,
                video_volume=0.0  # 静音原声
            )
            return composed["video_url"]

        return enhanced_url
```

---

## 附录 B：术语表

| 术语 | 说明 |
|------|------|
| MaaS | Model-as-a-Service，模型即服务 |
| AIGC | AI Generated Content，AI 生成内容 |
| Seedance | 火山引擎视频生成模型 |
| 标准版 / 专业版 | MediaKit 画质增强的两档质量规格 |
| 场景切分 | 按镜头/场景边界将长视频切分为多个短片段 |
| ASR | Automatic Speech Recognition，自动语音识别 |
| OCR | Optical Character Recognition，光学字符识别 |
| VOD | Video on Demand，视频点播服务 |
| FPS | Frames Per Second，每秒帧数 |
| P99 | 99% 请求的响应时间上界 |

---

## 参考资料

- [方舟 MaaS & AI MediaKit Onepage](https://jcnocm8i9f5w.feishu.cn/wiki/AwW9wrlqbi8bfdkO5QtctBjZnmh)
- [AI MediaKit 计费说明](https://www.volcengine.com/docs/6448/2253924)
- [快速入门：视频生成后处理](https://www.volcengine.com/docs/6448/2298704)
- [音视频拼接 API](https://www.volcengine.com/docs/6448/2279956)
- [方舟大模型服务计费说明](https://www.volcengine.com/docs/82379/1544681)
- [AI MediaKit 控制台](https://console.volcengine.com/imp/ai-mediakit/settings)



---

## 附录 A'：Node.js / TypeScript 完整封装

```javascript
import axios from 'axios';

interface TaskResult {
  video_url: string;
  duration?: number;
  fps?: number;
  resolution?: string;
  vocal_url?: string;
  background_url?: string;
  [key: string]: any;
}

class MediaKitClient {
  private apiKey: string;
  private endpoint: string;
  private client;

  constructor(apiKey: string, region: string = 'cn-beijing') {
    this.apiKey = apiKey;
    this.endpoint = `https://amk.${region}.volces.com/api/v1`;
    this.client = axios.create({
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  private async submit(tool: string, payload: object): Promise<string> {
    const resp = await this.client.post(`${this.endpoint}/tools/${tool}`, payload);
    if (!resp.data.success) throw new Error(`提交失败: ${JSON.stringify(resp.data)}`);
    return resp.data.task_id;
  }

  private async poll(taskId: string, interval: number = 5, timeout: number = 600): Promise<TaskResult> {
    const start = Date.now();
    while (true) {
      if (Date.now() - start > timeout * 1000) throw new Error(`任务 ${taskId} 轮询超时`);
      const resp = await this.client.get(`${this.endpoint}/tasks/${taskId}`);
      const status = resp.data.status;
      if (status === 'completed') return resp.data.result ?? {};
      if (status === 'failed') throw new Error(`任务失败: ${resp.data.error_msg}`);
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    }
  }

  // === 画质增强 ===
  async enhanceVideo(videoUrl: string, resolution: string = '1080p', fps?: number): Promise<TaskResult> {
    const payload: any = { video_url: videoUrl, scene: 'aigc', resolution };
    if (fps) payload.fps = fps;
    const taskId = await this.submit('enhance-video', payload);
    return this.poll(taskId);
  }

  // === 字幕擦除 ===
  async eraseSubtitle(videoUrl: string, mode: 'normal' | 'fine' = 'normal'): Promise<TaskResult> {
    const taskId = await this.submit('erase-subtitle', { video_url: videoUrl, mode });
    return this.poll(taskId);
  }

  // === 音频分离 ===
  async separateAudio(videoUrl: string, taskType: 'all' | 'vocal' | 'background' = 'all'): Promise<TaskResult> {
    const taskId = await this.submit('separate-audio', { video_url: videoUrl, task_type: taskType });
    return this.poll(taskId);
  }

  // === 场景切分 ===
  async sceneSegment(videoUrl: string): Promise<TaskResult> {
    const taskId = await this.submit('scene-segment', { video_url: videoUrl });
    return this.poll(taskId);
  }

  // === 语音转字幕 ===
  async asr(videoUrl: string): Promise<TaskResult> {
    const taskId = await this.submit('asr', { video_url: videoUrl });
    return this.poll(taskId);
  }

  // === 视频拼接 ===
  async mergeVideo(videoList: string[], outputResolution: string = '1080p'): Promise<TaskResult> {
    const taskId = await this.submit('merge-video', {
      video_list: videoList.map(v => ({ video_url: v })),
      output_resolution: outputResolution,
    });
    return this.poll(taskId);
  }

  // === 音视频合成 ===
  async composeAV(
    videoUrl: string,
    audioUrl: string,
    videoVolume: number = 1.0,
    audioVolume: number = 1.0,
  ): Promise<TaskResult> {
    const taskId = await this.submit('compose-av', {
      video_url: videoUrl,
      audio_url: audioUrl,
      video_volume: videoVolume,
      audio_volume: audioVolume,
    });
    return this.poll(taskId);
  }

  // === 端到端：方舟生成 → MediaKit 增强 ===
  async pipelineGenerateEnhance(seedanceUrl: string, targetResolution: string = '1080p', targetFps: number = 50): Promise<string> {
    const result = await this.enhanceVideo(seedanceUrl, targetResolution, targetFps);
    return result.video_url;
  }

  // === 端到端：出海本地化（擦除 → 增强 → 合成） ===
  async pipelineLocalization(rawVideoUrl: string, newAudioUrl?: string): Promise<string> {
    const erasedResult = await this.eraseSubtitle(rawVideoUrl, 'fine');
    const erasedUrl = erasedResult.video_url;

    const enhancedResult = await this.enhanceVideo(erasedUrl, '1080p', 50);
    const enhancedUrl = enhancedResult.video_url;

    if (newAudioUrl) {
      const composedResult = await this.composeAV(enhancedUrl, newAudioUrl, 0, 1.0);
      return composedResult.video_url;
    }
    return enhancedUrl;
  }
}

// ==================== 使用示例 ====================

// 安装依赖: npm install axios

const mediakit = new MediaKitClient('your_api_key_here');

// 画质增强
const result1 = await mediakit.enhanceVideo('https://cdn.com/seedance_output.mp4', '1080p', 50);
console.log('增强后视频:', result1.video_url);

// 出海本地化：字幕擦除 + 增强 + 配音合成
const finalUrl = await mediakit.pipelineLocalization(
  'https://cdn.com/drama_ep1.mp4',
  'https://cdn.com/english_dubbed.aac'
);
console.log('本地化后视频:', finalUrl);

// 视频拼接
const merged = await mediakit.mergeVideo([
  'https://cdn.com/clip1.mp4',
  'https://cdn.com/clip2.mp4',
  'https://cdn.com/clip3.mp4',
]);
console.log('拼接后视频:', merged.video_url);

// 音频分离
const separated = await mediakit.separateAudio('https://cdn.com/seedance_with_music.mp4');
console.log('人声音轨:', separated.vocal_url);
console.log('背景音轨:', separated.background_url);

// ==================== 并发批量处理 ====================
// 并发增强多个视频片段（建议并发数 ≤ 10）
const urls = [
  'https://cdn.com/clip1.mp4',
  'https://cdn.com/clip2.mp4',
  'https://cdn.com/clip3.mp4',
];
const results = await Promise.all(
  urls.map(url => mediakit.enhanceVideo(url, '1080p', 50))
);
const enhancedUrls = results.map(r => r.video_url);
console.log('增强后片段:', enhancedUrls);

// ==================== 错误处理 ====================
try {
  const result = await mediakit.enhanceVideo('https://cdn.com/video.mp4', '1080p', 50);
  console.log(result.video_url);
} catch (err: any) {
  if (err.message.includes('任务失败')) {
    console.error('MediaKit 处理失败:', err.message);
  } else if (err.message.includes('超时')) {
    console.error('任务轮询超时，请检查网络或增加 timeout');
  } else {
    console.error('请求异常:', err.message);
  }
}
```
