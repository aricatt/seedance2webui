# Luminia API 接入文档

> 本文档供 AI 编程助手（Vibe Coding Agent）直接读取，自动生成接入代码。
> 网页版文档：https://luapi.hagoot.com/docs/api
> API 基础地址：https://luapi.hagoot.com

## 鉴权方式

所有接口使用 Bearer Token 鉴权，在请求头中添加：

```
Authorization: Bearer sk-your-token
```

---

## 可用模型

### 视频生成

| 模型 | 说明 | 分辨率 | 时长 |
|------|------|--------|------|
| `luminia-2.0` | Luminia 高品质视频（Seedance 2.0），支持多模态参考/编辑/延长/联网搜索 | 480p / 720p | 4-15秒 |
| `luminia-2.0-fast` | Luminia 快速视频（Seedance 2.0 fast），同等能力，更快更便宜 | 480p / 720p | 4-15秒 |
| `mps-sora` | OpenAI Sora 2.0 视频生成 | 480p / 720p / 1080p | 5-20秒 |
| `mps-veo` | Google Veo 视频生成 | 720p / 1080p | 5-8秒 |
| `mps-kling` | 可灵视频生成 | 720p / 1080p | 5-10秒 |
| `mps-vidu` | Vidu 视频生成 | 720p / 1080p | 4-8秒 |
| `mps-hailuo` | 海螺视频生成（MiniMax） | 720p / 1080p | 5-6秒 |
| `mps-hunyuan` | 混元视频生成 | 720p / 1080p | 5秒 |
| `mps-jimeng` | 即梦视频生成 | 720p / 1080p | 5秒 |
| `mps-mingmou` | 明眸视频生成 | 720p / 1080p | 5秒 |
| `mps-pixverse` | PixVerse 视频生成 | 720p / 1080p | 5秒 |
| `happyhorse-1.0-i2v` | 通义万相 happyhorse 图生视频（首帧） | 720p / 1080p | 3-10秒 |
| `happyhorse-1.0-t2v` | 通义万相 happyhorse 文生视频 | 720p / 1080p | 3-10秒 |
| `happyhorse-1.0-r2v` | 通义万相 happyhorse 参考图生视频（多参考图） | 720p / 1080p | 3-10秒 |
| `happyhorse-1.0-video-edit` | 通义万相 happyhorse 视频编辑 | 720p / 1080p | 沿用源视频 |
| `kling/kling-v3-video-generation` | 可灵 v3 stable，dashscope 透传，`mode=std` 720P / `mode=pro` 1080P | 720p / 1080p | 5-10秒 |

### mps- 模型版本对照表

`mps-` 模型通过 `metadata.model_version` 指定版本：

| 模型 | 可选版本 | 说明 |
|------|----------|------|
| `mps-kling` | `1.6`, `2.0`, `2.1`, `2.5`, `2.6`, `O1`, `3.0`, `3.0-Omni` | **`3.0-Omni` 是 3.0 的全功能版本（含音效生成、分镜增强）；`3.0` 为基础档**。要让 `EnableAudio: true` 真正生成有声视频，必须用 `3.0-Omni`（或 `O1` 顶配） |
| `mps-vidu` | `q2`, `q2-pro`, `q2-turbo`, `q3`, `q3-pro`, `q3-turbo`, `q3-mix` | q3-pro 为最优版本 |
| `mps-hailuo` | `02`, `2.3`, `2.3-fast` | 2.3 为最新版本 |
| `mps-veo` | `3.1`, `3.1-fast` | 3.1 为标准版本 |
| `mps-sora` | `2.0` | — |
| `mps-hunyuan` | `1.5` | — |
| `mps-jimeng` | `3.0pro` | — |
| `mps-mingmou` | `1.0` | — |
| `mps-pixverse` | `v5.6`, `v6`, `c1` | — |

### mps- 模型场景类型（scene_type）

部分模型支持特殊场景模式，通过 `metadata.scene_type` 指定：

| 模型 | scene_type | 说明 |
|------|------------|------|
| `mps-kling` | `motion_control` | 动作控制 |
| `mps-kling` | `avatar_i2v` | 数字人 |
| `mps-kling` | `lip_sync` | 对口型 |
| `mps-vidu` | `template_effect` | 特效模板 |
| `mps-mingmou` | `land2port` | 横转竖 |

### mps- 高级参数（透传到腾讯 MPS）

`mps-*` 视频接口除常规参数外，还支持以下进阶字段，全部放在 `metadata` 顶层：

| metadata 字段 | 类型 | 说明 |
|---------------|------|------|
| `extra_parameters` | object | 上游 `AigcVideoExtraParam` 透传。常用键：`Resolution` (720P/1080P)、`AspectRatio` (16:9/9:16/...)、`EnableAudio` (bool，仅 Kling `3.0-Omni`/`O1` 有效)、`Mode` (std/pro)、`OffPeak` (bool 错峰) |
| `additional_parameters` | object 或 string | 上游 `AdditionalParameters`（JSON-string）。**自定义分镜 / camera_control 等特殊参数走这里**。例： `{"camera_control":{"type":"simple"}, "storyboard":{"shots":[...]}}`。本网关接受 object 形式自动序列化，也接受预编码的 string |
| `store_cos_param` | object | 让上游把结果存到客户自有 COS 桶。字段：`CosBucketName` / `CosBucketRegion` / `CosBucketPath`。需开通 COS 并授权 `MPS_QcsRole` |
| `operator` | string | 调用者标识，用于腾讯侧审计 |

> Kling 3.0 客户感受不一致的根因：基础 `3.0` 不含音效/分镜，必须用 `3.0-Omni`；自定义分镜要走 `additional_parameters` 而不是 `prompt`。

### 图片生成

| 模型 | 说明 | 分辨率 |
|------|------|--------|
| `mps-gem` | GEM 图片生成（支持 2.5/3.0/3.1） | 0.5K-4K |
| `mps-hunyuan-image` | 混元图片生成 | 1K-2K |
| `mps-qwen-image` | Qwen 图片生成 | 1K-2K |
| `mps-si` | SI 图片生成 | 1K-2K |
| `mps-og` | GPT image 2（low/medium/high 三档） | 1K / 2K / 4K |

> 带 `mps-` 前缀的模型通过统一网关调用，需指定 `model_version` 选择具体版本。

### 文本对话（Chat）

| 模型 | 说明 | 深度思考 |
|------|------|----------|
| `qwen3.6-flash` | 通义千问 Flash，低延迟通用对话 | ✅ 支持 `enable_thinking` |
| `qwen-turbo` / `qwen-plus` / `qwen-max` | 通义千问经典系列 | ❌ |
| `qwen3-235b-a22b` | 通义千问 3（235B MoE），高质量推理 | ✅ |
| `qwq-32b` | 通义 QwQ 推理模型 | ✅（默认开启） |
| `deepseek-v4-pro` | DeepSeek v4 Pro（dashscope 兼容模式） | ✅ 支持 `enable_thinking` |
| `deepseek-v4-flash` | DeepSeek v4 Flash（dashscope 兼容模式，低延迟） | ✅ 支持 `enable_thinking` |

> 文本对话走标准 OpenAI Chat Completions 协议（`POST /v1/chat/completions`），详见本文第 5 节。

---

## 重要：接口说明

视频/图片生成 API 有 3 个接口，文本对话是第 4 个独立接口：

| 步骤 | 方法 | 路径 | 用途 |
|------|------|------|------|
| 1 | `POST` | `/v1/video/generations` | 提交生成任务（视频/图片） |
| 2 | `GET` | `/v1/video/generations/{task_id}` | 轮询任务状态 |
| 3 | `GET` | `/v1/videos/{task_id}/content` | 获取视频下载链接（302 重定向） |
| 5 | `POST` | `/v1/chat/completions` | 文本对话（OpenAI 兼容） |

> **注意：步骤 2 的路径是 `/v1/video/generations/{task_id}`（单数 video），不是 `/v1/videos/`。**
> **步骤 3 的路径是 `/v1/videos/{task_id}/content`（复数 videos），和步骤 2 不同。**
> **不存在 `/v1/video/generation/` 或 `/v1/video/{task_id}` 这样的路径。**

---

## 1. 提交生成任务

```
POST https://luapi.hagoot.com/v1/video/generations
Content-Type: application/json
Authorization: Bearer sk-your-token
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称，如 `luminia-2.0`、`mps-kling`、`mps-sora` 等（见可用模型列表） |
| `prompt` | string | 是 | 视频描述文本，建议中文不超过500字，英文不超过1000词 |
| `image` | string | 否 | 单张参考图片（URL 或 Base64 data URI） |
| `images` | array | 否 | 多张参考图片数组，每项为 URL 或 Base64（图片生成模型如 `mps-gem` 最多 3 张） |
| `metadata` | object | 否 | 扩展参数（见下表） |

### metadata 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `resolution` | string | `"720p"` | 视频分辨率：`480p` / `720p` |
| `ratio` | string | `"adaptive"` | 宽高比：`16:9` / `9:16` / `1:1` / `4:3` / `3:4` / `21:9` / `adaptive` |
| `duration` | int | `5` | 视频时长（秒），范围 4-15，设为 `-1` 自动选择 |
| `generate_audio` | bool | `true` | 是否生成有声视频（含人声、音效、背景音乐） |
| `tools` | array | - | 工具列表，如 `[{"type":"web_search"}]` 开启联网搜索 |
| `content` | array | - | 多模态参考素材数组（高级用法，见下方 luminia 模型专用） |
| `image_infos` | array | - | 图片生成参考图数组（`mps-` 图片模型专用，见下方说明） |
| `model_version` | string | - | 模型版本号（`mps-` 模型专用，见版本对照表） |
| `negative_prompt` | string | - | 反向提示词，描述不希望出现的内容 |
| `enhance_prompt` | bool | - | 是否自动优化提示词，开启可提升生成质量 |
| `extra_parameters` | object | - | 额外参数（如 `{"Resolution":"1080P","AspectRatio":"16:9"}` ） |
| `scene_type` | string | - | 场景类型（`mps-kling` 支持 `motion_control`/`avatar_i2v`/`lip_sync`） |
| `last_image_url` | string | - | 尾帧图片 URL（需配合首帧使用） |
| `input_region` | string | `Mainland` | 输入文件区域（国外素材填 `Oversea`） |
| `ext_info` | string | - | 扩展信息（模型特殊参数、分镜 prompt 等） |
| `tasks_priority` | int | 0 | 任务优先级，-10 到 10，数值越大越优先 |

### 图片生成参考图（mps- 图片模型）

图片生成模型（如 `mps-gem`）支持上传参考图片，有两种方式：

**方式一：`images` 数组（简单，推荐）**

直接在请求体的 `images` 字段传入图片 URL 数组：

```json
{
  "model": "mps-gem",
  "prompt": "一只可爱的小猫",
  "images": ["https://example.com/ref1.jpg", "https://example.com/ref2.jpg"],
  "metadata": {
    "model_version": "3.0",
    "extra_parameters": {"Resolution": "1K", "AspectRatio": "1:1"}
  }
}
```

**方式二：`metadata.image_infos` 数组（高级）**

通过 metadata 传入，可以更精细地控制每张图的信息：

```json
{
  "model": "mps-gem",
  "prompt": "一幅油画风格的山水画",
  "metadata": {
    "model_version": "3.0",
    "image_infos": [
      {"ImageUrl": "https://example.com/ref1.jpg"},
      {"ImageUrl": "https://example.com/ref2.jpg"}
    ],
    "extra_parameters": {"Resolution": "1K", "AspectRatio": "16:9"}
  }
}
```

> **注意：**
> - `image_infos` 优先级高于 `images`。如果两者同时传入，以 `image_infos` 为准。
> - GEM 模型最多支持 3 张参考图片。图片格式支持 jpeg、png、webp，建议单张小于 7MB。
> - **支持 Base64**：`images` 数组和 `image_infos` 中的图片均可使用 `data:image/jpeg;base64,...` 格式，后端会自动上传到云存储并转为公网 URL，无需自行托管图片。

**方式三：Base64 上传参考图**

```json
{
  "model": "mps-gem",
  "prompt": "参考图片生成类似风格的画作",
  "images": [
    "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
    "https://example.com/ref2.jpg"
  ],
  "metadata": {
    "model_version": "3.0",
    "extra_parameters": {"Resolution": "1K", "AspectRatio": "1:1"}
  }
}
```

> URL 和 Base64 可以混用，后端会自动识别并处理。

### 图片/视频/音频输入格式

所有媒体输入（`image`、`images`、`metadata.content` 中的 `image_url`/`video_url`/`audio_url`）支持两种格式：

| 格式 | 说明 | 示例 |
|------|------|------|
| **URL** | 直接传公网链接 | `https://example.com/photo.jpg` |
| **Base64** | 传 data URI，后端自动上传到云存储转为 URL | `data:image/jpeg;base64,/9j/4AAQ...` |

### 宽高比对应像素值

| 分辨率 | 16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 21:9 |
|--------|------|------|-----|-----|-----|------|
| 480p | 864x496 | 496x864 | 640x640 | 752x560 | 560x752 | 992x432 |
| 720p | 1280x720 | 720x1280 | 960x960 | 1112x834 | 834x1112 | 1470x630 |

### 响应格式

```json
{
  "id": "task_xxxxxxxxxxxx",
  "task_id": "task_xxxxxxxxxxxx",
  "object": "video",
  "model": "luminia-2.0",
  "status": "queued",
  "progress": 0,
  "created_at": 1774531924
}
```

> **提取 task_id**：从响应 JSON 的顶层字段 `id` 或 `task_id` 获取（两者值相同）。

### 请求示例

#### 文生视频

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "luminia-2.0",
    "prompt": "一只可爱的橘猫在阳光下的草地上慢慢走动",
    "metadata": {
      "resolution": "720p",
      "ratio": "16:9",
      "duration": 5,
      "generate_audio": false
    }
  }'
```

#### 图生视频（传 URL）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "luminia-2.0",
    "prompt": "画面中的人物缓缓转身微笑",
    "image": "https://your-image-url.com/photo.jpg",
    "metadata": {
      "resolution": "720p",
      "duration": 5
    }
  }'
```

#### 图生视频（传 Base64）

```bash
IMAGE_BASE64=$(base64 -w0 your-photo.jpg)

curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d "{
    \"model\": \"luminia-2.0\",
    \"prompt\": \"画面中的人物缓缓转身微笑\",
    \"image\": \"data:image/jpeg;base64,${IMAGE_BASE64}\",
    \"metadata\": {
      \"resolution\": \"720p\",
      \"duration\": 5
    }
  }"
```

#### 多模态参考

通过 `metadata.content` 传入多种参考素材（URL 和 Base64 可混用）：

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "luminia-2.0",
    "prompt": "图片中的人物在街上走动",
    "metadata": {
      "content": [
        {
          "type": "image_url",
          "image_url": {"url": "https://your-image.jpg"},
          "role": "reference_image"
        },
        {
          "type": "video_url",
          "video_url": {"url": "https://your-video.mp4"},
          "role": "reference_video"
        },
        {
          "type": "audio_url",
          "audio_url": {"url": "https://your-audio.wav"},
          "role": "reference_audio"
        }
      ],
      "resolution": "720p",
      "duration": 10
    }
  }'
```

### 支持的 role 类型

| role | 说明 | 数量限制 |
|------|------|----------|
| `reference_image` | 参考图片 | 1-9 张 |
| `first_frame` | 首帧图片 | 1 张 |
| `last_frame` | 尾帧图片 | 1 张（需配合 first_frame） |
| `reference_video` | 参考视频 | 1-3 个，总时长不超过 15s |
| `reference_audio` | 参考音频 | 1-3 个，总时长不超过 15s |

> 注意：首帧/首尾帧模式和多模态参考模式不可混用。

### Luminia（Seedance 2.0）高级能力

`luminia-2.0` 和 `luminia-2.0-fast` 基于 Seedance 2.0，支持以下高级能力。两个模型能力相同，`luminia-2.0` 追求最高品质，`luminia-2.0-fast` 更快更便宜。

#### 能力总览

| 能力 | 说明 |
|------|------|
| 文生视频 | 纯文本描述生成视频 |
| 图生视频（首帧/首尾帧） | 指定首帧或首尾帧图片 |
| 多模态参考 | 图片(0-9) + 视频(0-3) + 音频(0-3) 任意组合 |
| 编辑视频 | 替换主体、增删改对象、局部重绘 |
| 延长视频 | 向前/向后延长，或多段视频串联 |
| 联网搜索 | 模型自主搜索互联网内容，提升时效性 |
| 生成有声视频 | 自动生成人声、音效、背景音乐 |
| 返回视频尾帧 | 获取生成视频的最后一帧，方便后续延长 |
| 素材库引用 | 通过 `asset://` 引用入库的虚拟人像素材 |

#### 编辑视频

提供待编辑的视频 + 参考图片/音频 + 提示词，完成视频编辑（替换主体、增删对象、局部重绘等）：

```json
{
  "model": "luminia-2.0",
  "prompt": "将视频1礼盒中的香水替换成图片1中的面霜，运镜不变",
  "metadata": {
    "ratio": "16:9",
    "duration": 5,
    "generate_audio": true,
    "content": [
      {
        "type": "image_url",
        "image_url": {"url": "https://example.com/cream.jpg"},
        "role": "reference_image"
      },
      {
        "type": "video_url",
        "video_url": {"url": "https://example.com/original-video.mp4"},
        "role": "reference_video"
      }
    ]
  }
}
```

**编辑视频提示词技巧：**
- 增加元素：描述「元素特征」+「出现时机」+「出现位置」
- 删除元素：点明要删除的元素，对保持不变的元素加以强调
- 修改元素：清晰描述需替换的元素即可

#### 延长视频

在原有视频基础上向前/向后延长，或多段视频（最多 3 段）串联为连贯视频：

```json
{
  "model": "luminia-2.0",
  "prompt": "视频1中的场景继续，镜头缓缓向前推进，画面逐渐展开",
  "metadata": {
    "ratio": "16:9",
    "duration": 8,
    "generate_audio": true,
    "content": [
      {
        "type": "video_url",
        "video_url": {"url": "https://example.com/clip1.mp4"},
        "role": "reference_video"
      }
    ]
  }
}
```

**多段视频串联：**

```json
{
  "model": "luminia-2.0",
  "prompt": "视频1中的窗户打开，进入室内，接视频2，之后镜头进入画内，接视频3",
  "metadata": {
    "duration": 10,
    "content": [
      {"type": "video_url", "video_url": {"url": "https://example.com/clip1.mp4"}, "role": "reference_video"},
      {"type": "video_url", "video_url": {"url": "https://example.com/clip2.mp4"}, "role": "reference_video"},
      {"type": "video_url", "video_url": {"url": "https://example.com/clip3.mp4"}, "role": "reference_video"}
    ]
  }
}
```

**延长视频提示词技巧：**
- 向后延长：`向后延长视频1 + [延长内容描述]`
- 向前延长：`向前延长视频1 + [延长内容描述]，最后接视频1`
- 多段串联：`视频1 + [过渡描述] + 接视频2 + [过渡描述] + 接视频3`

#### 联网搜索增强

纯文本输入时，可开启联网搜索让模型自主查询互联网内容（如商品外观、天气等），提升生成视频的时效性：

```json
{
  "model": "luminia-2.0",
  "prompt": "微距镜头对准叶片上翠绿的玻璃蛙，焦点逐渐从光滑的皮肤转移到透明腹部",
  "metadata": {
    "ratio": "16:9",
    "duration": 11,
    "tools": [{"type": "web_search"}]
  }
}
```

> 联网搜索仅适用于纯文本输入（不含图片/视频/音频参考时）。模型会自主判断是否需要搜索。

#### 返回视频尾帧

生成视频时可请求返回最后一帧图片，方便后续作为首帧继续延长：

```json
{
  "model": "luminia-2.0",
  "prompt": "一只猫在草地上走动",
  "metadata": {
    "return_last_frame": true
  }
}
```

#### 使用虚拟人像素材

通过素材库入库的虚拟人像，可使用 `asset://` 引用。详见本文档「素材资产管理」章节。

```json
{
  "model": "luminia-2.0",
  "prompt": "图片1中的美妆博主面带笑容，向镜头介绍图片2中的面霜",
  "metadata": {
    "generate_audio": true,
    "ratio": "adaptive",
    "duration": 11,
    "content": [
      {"type": "image_url", "image_url": {"url": "asset://asset-虚拟人像ID"}, "role": "reference_image"},
      {"type": "image_url", "image_url": {"url": "https://example.com/product.jpg"}, "role": "reference_image"}
    ]
  }
}
```

> **提示词中用"图片1""视频1""音频1"指代素材**，按 content 数组中同类型素材的出现顺序编号。不要在提示词中直接写 Asset ID 或 URL。

#### 多模态参考组合规则

| 组合 | 是否支持 |
|------|----------|
| 文本 | ✓ |
| 文本 + 图片 | ✓ |
| 文本 + 视频 | ✓ |
| 文本 + 图片 + 视频 | ✓ |
| 文本 + 图片 + 音频 | ✓ |
| 文本 + 视频 + 音频 | ✓ |
| 文本 + 图片 + 视频 + 音频 | ✓ |
| 文本 + 音频 | **不支持** |
| 纯音频 | **不支持** |

#### 完整 metadata 参数（luminia 模型）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `resolution` | string | `"720p"` | 输出分辨率：`480p` / `720p` |
| `ratio` | string | `"adaptive"` | 宽高比：`16:9`/`9:16`/`1:1`/`4:3`/`3:4`/`21:9`/`adaptive` |
| `duration` | int | `5` | 视频时长 4-15 秒，-1 自动选择 |
| `generate_audio` | bool | `true` | 是否生成有声视频 |
| `seed` | int | 随机 | 随机种子 -1 ~ 2³²-1，固定种子可复现结果 |
| `content` | array | - | 多模态内容数组（text/image_url/video_url/audio_url） |
| `tools` | array | - | 工具列表，如 `[{"type":"web_search"}]` |
| `return_last_frame` | bool | `false` | 是否返回视频尾帧图片 |
| `draft` | bool | `false` | 样片模式（快速预览，质量较低） |
| `watermark` | bool | `false` | 是否添加水印 |

---

## 2. 查询任务状态（轮询）

```
GET https://luapi.hagoot.com/v1/video/generations/{task_id}
Authorization: Bearer sk-your-token
```

> **路径是 `/v1/video/generations/{task_id}`，不是 `/v1/videos/{task_id}`。**
> 建议轮询间隔 10-15 秒，视频生成通常需要 2-5 分钟。

### 任务状态说明

| 状态 | 说明 | 是否终态 |
|------|------|----------|
| `NOT_START` | 未开始 | 否 |
| `SUBMITTED` | 已提交 | 否 |
| `QUEUED` | 排队中 | 否 |
| `IN_PROGRESS` | 生成中 | 否 |
| `SUCCESS` | 生成成功 | **是** |
| `FAILURE` | 生成失败 | **是** |

> 轮询时只需判断 `status` 是否为 `SUCCESS` 或 `FAILURE`，其他状态都表示还在处理中，继续轮询。

### 响应格式

**注意：查询接口的响应格式与提交接口不同，数据包裹在 `data` 字段中。**

```json
{
  "code": "success",
  "message": "",
  "data": {
    "task_id": "task_xxxxxxxxxxxx",
    "status": "SUCCESS",
    "progress": "100%",
    "result_url": "https://...",
    "fail_reason": "",
    "submit_time": 1774531924,
    "start_time": 1774531928,
    "finish_time": 1774532100,
    "data": {
      "duration": 5,
      "ratio": "16:9",
      "resolution": "720p",
      "seed": 79939,
      "usage": {
        "completion_tokens": 108900,
        "total_tokens": 108900
      }
    }
  }
}
```

### 关键字段提取

```
任务状态：response.data.status
任务进度：response.data.progress
视频链接：response.data.result_url    （status 为 SUCCESS 时存在）
失败原因：response.data.fail_reason   （status 为 FAILURE 时存在）
```

### 失败任务响应示例

当任务失败时，`fail_reason` 会包含具体的上游错误信息：

```json
{
  "code": "success",
  "data": {
    "task_id": "task_xxxxxxxxxxxx",
    "status": "FAILURE",
    "progress": "100%",
    "fail_reason": "[OutputVideoSensitiveContentDetected] The request failed because the output video may contain sensitive information.",
    "result_url": ""
  }
}
```

### 常见失败原因

| fail_reason 中的错误码 | 说明 | 建议 |
|------------------------|------|------|
| `OutputVideoSensitiveContentDetected` | AI 生成的视频内容触发了安全审核 | 修改 prompt 描述后重试 |
| `InvalidParameter.BodyFormat` | 上传的参考素材格式无效 | 检查图片/视频格式是否符合要求 |
| `令牌额度不足` | Token 余额不足以支付本次生成费用 | 充值后重试 |
| `账户额度不足` | 账户总余额不足 | 联系管理员充值 |

---

## 3. 获取视频文件（可选）

```
GET https://luapi.hagoot.com/v1/videos/{task_id}/content
Authorization: Bearer sk-your-token
```

> **注意：这个路径是 `/v1/videos/{task_id}/content`（复数 videos），和步骤 2 的路径不同。**

返回 **302 重定向** 到视频永久链接（COS 持久化存储），可直接在浏览器打开或下载。

> 此接口为可选步骤。步骤 2 查询结果中的 `result_url` 已包含视频链接，但该链接可能有过期时间。
> 如需永久链接，使用此接口获取。

---

## 完整调用流程

```
步骤 1: POST /v1/video/generations           → 提交任务，获取 task_id
步骤 2: GET  /v1/video/generations/{task_id} → 轮询状态（间隔 10-15 秒）
步骤 3: 当 status == "SUCCESS" 时：
        - 直接使用 result_url 获取视频
        - 或 GET /v1/videos/{task_id}/content → 302 跳转到永久链接
```

> 视频生成通常需要 2-5 分钟，请耐心等待。

---

## 输入素材要求

### 图片
- 格式：jpeg、png、webp、bmp、tiff、gif
- 宽高比：0.4 ~ 2.5
- 宽高像素：300 ~ 6000 px
- 大小：单张 < 30MB

### 视频（参考视频）
- 格式：mp4、mov
- 时长：2-15 秒，所有视频总时长不超过 15s
- 大小：单个 < 50MB
- 帧率：24-60 FPS

### 音频（参考音频）
- 格式：wav、mp3
- 时长：2-15 秒，所有音频总时长不超过 15s
- 大小：单个 < 15MB

---

## 更多模型请求示例

#### Sora 视频生成

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-sora",
    "prompt": "一只金毛犬在海滩上奔跑，浪花四溅",
    "metadata": {
      "extra_parameters": {"Resolution": "1080P", "AspectRatio": "16:9"}
    }
  }'
```

#### 可灵视频生成（基础）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-kling",
    "prompt": "城市夜景延时摄影，灯火辉煌",
    "metadata": {
      "model_version": "3.0",
      "extra_parameters": {"Resolution": "1080P", "AspectRatio": "16:9"}
    }
  }'
```

#### 可灵数字人（avatar_i2v）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-kling",
    "prompt": "人物面带微笑对着镜头说话",
    "image": "https://example.com/person.jpg",
    "metadata": {
      "model_version": "2.5",
      "scene_type": "avatar_i2v",
      "extra_parameters": {"Resolution": "1080P", "AspectRatio": "9:16"}
    }
  }'
```

#### 可灵对口型（lip_sync）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-kling",
    "prompt": "人物说话",
    "image": "https://example.com/person.jpg",
    "metadata": {
      "model_version": "2.5",
      "scene_type": "lip_sync",
      "extra_parameters": {"Resolution": "1080P"}
    }
  }'
```

#### Vidu 视频生成

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-vidu",
    "prompt": "樱花树下，花瓣随风飘落",
    "metadata": {
      "model_version": "q3-pro",
      "extra_parameters": {"Resolution": "720P"}
    }
  }'
```

#### GEM 图片生成（纯文生图）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-gem",
    "prompt": "一幅水彩风格的山水画",
    "metadata": {
      "model_version": "3.0",
      "extra_parameters": {"Resolution": "2K", "AspectRatio": "1:1"}
    }
  }'
```

#### GEM 图片生成（带多张参考图）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-gem",
    "prompt": "参考这些图片的风格，生成一幅类似的风景画",
    "images": [
      "https://example.com/reference1.jpg",
      "https://example.com/reference2.jpg"
    ],
    "metadata": {
      "model_version": "3.0",
      "extra_parameters": {"Resolution": "1K", "AspectRatio": "16:9"}
    }
  }'
```

> `mps-` 前缀的模型通过 `metadata.model_version` 指定版本，通过 `metadata.extra_parameters` 设置分辨率和宽高比。
> 图片生成模型（`mps-gem`）支持通过 `images` 数组或 `metadata.image_infos` 传入最多 3 张参考图片。
> 参考图支持 URL 和 Base64 data URI 两种格式，Base64 会自动上传到云存储转为公网链接。

#### GPT image 2 (mps-og)

GPT image 2 提供 low / medium / high 三档质量，每档支持 1K / 2K / 4K 三种分辨率。

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-og",
    "prompt": "一只在草地上奔跑的小金毛犬，电影感光线",
    "metadata": {
      "model_version": "image2_low",
      "extra_parameters": {
        "Resolution": "1K",
        "AspectRatio": "1:1"
      }
    }
  }'
```

带参考图（最多 3 张）：

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "mps-og",
    "prompt": "把参考人物变成宇航员造型",
    "metadata": {
      "model_version": "image2_high",
      "extra_parameters": {
        "Resolution": "4K",
        "AspectRatio": "21:9"
      },
      "image_infos": [
        {"image_url": "https://example.com/face.jpg"}
      ]
    }
  }'
```

**参数说明**

| 字段 | 取值 | 说明 |
|---|---|---|
| `model_version` | `image2_low` / `image2_medium` / `image2_high` | 质量档位（影响价格） |
| `extra_parameters.Resolution` | `1K` / `2K` / `4K` | 输出分辨率 |
| `extra_parameters.AspectRatio` | `1:1` / `3:2` / `2:3` / `3:4` / `4:3` / `16:9` / `9:16` / `21:9` / `9:21` | 宽高比 |
| `image_infos` | 数组，最多 3 项 | 参考图（如需更多张请联系技术配置） |

#### Happyhorse 图生视频（i2v，首帧）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "happyhorse-1.0-i2v",
    "prompt": "一只猫在草地上奔跑",
    "image": "https://cdn.translate.alibaba.com/r/wanx-demo-1.png",
    "metadata": {
      "parameters": {
        "resolution": "720P",
        "duration": 5
      }
    }
  }'
```

> 网关会把 `image`（或 `input_reference`）自动包装为 `input.media[0]={type:first_frame, url:...}`。
> 也可以直接通过 `metadata.input.media` 传完整数组，覆盖自动包装。

#### Happyhorse 文生视频（t2v）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "happyhorse-1.0-t2v",
    "prompt": "一座由硬纸板和瓶盖搭建的微型城市，在夜晚焕发出生机。一列硬纸板火车缓缓驶过，小灯点缀其间，照亮前路。",
    "metadata": {
      "parameters": {
        "resolution": "720P",
        "ratio": "16:9",
        "duration": 5
      }
    }
  }'
```

> `ratio` 默认 `16:9`，可改 `9:16` / `1:1` 等。`duration` 范围 3-10 秒。

#### Happyhorse 参考图生视频（r2v，多参考图）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "happyhorse-1.0-r2v",
    "prompt": "身着红色旗袍的女性 图1，镜头先以侧面中景勾勒旗袍修身剪裁与S型曲线，随即切换至低角度仰拍，捕捉她轻抬玉手展开折扇 图2 时流苏耳坠 图3 随头部转动轻盈摆动的细节...",
    "metadata": {
      "input": {
        "media": [
          {"type": "reference_image", "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260424/mvzfud/hh-v2v-girl.jpg"},
          {"type": "reference_image", "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260424/fvuihk/hh-v2v2-folding-fan.jpg"},
          {"type": "reference_image", "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260424/imerii/hh-v2v-earrings.jpg"}
        ]
      },
      "parameters": {
        "resolution": "720P",
        "ratio": "16:9",
        "duration": 5
      }
    }
  }'
```

> r2v 通过 `metadata.input.media` 透传 1-多张 `reference_image`。提示词中可用 `图1` / `图2` 按 media 数组顺序指代。

#### Happyhorse 视频编辑（video-edit）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "happyhorse-1.0-video-edit",
    "prompt": "让视频中的马头人身角色穿上图片中的条纹毛衣",
    "metadata": {
      "input": {
        "media": [
          {"type": "video", "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260409/dozxak/Wan_Video_Edit_33_1.mp4"},
          {"type": "reference_image", "url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260415/hynnff/wan-video-edit-clothes.webp"}
        ]
      },
      "parameters": {
        "resolution": "720P"
      }
    }
  }'
```

> video-edit 不需要 `duration`，会沿用源视频时长；`media` 必须包含一个 `type=video` 和一或多个 `type=reference_image`。

> happyhorse 系列共用 dashscope 异步视频合成接口（`/api/v1/services/aigc/video-generation/video-synthesis`），返回的 task 走本网关标准的 `GET /v1/video/generations/{task_id}` 轮询。

#### Kling-v3 stable（dashscope 透传）

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{
    "model": "kling/kling-v3-video-generation",
    "prompt": "一只小猫在月光下奔跑",
    "metadata": {
      "parameters": {
        "mode": "std",
        "aspect_ratio": "16:9",
        "duration": 5,
        "audio": false,
        "watermark": true
      }
    }
  }'
```

> `mode`：`std` (720P) / `pro` (1080P)，决定计费档位。`audio`：`false` 走无声档（更便宜），`true` 走有声档。
> 计费 4 档：720P 无声 0.6 元/秒、720P 有声 0.9、1080P 无声 0.8、1080P 有声 1.2。

---

## Python 完整示例

```python
import requests
import time

BASE_URL = "https://luapi.hagoot.com"
API_KEY = "sk-your-token"

headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {API_KEY}"
}

# 步骤 1: 提交视频生成任务
# POST /v1/video/generations
resp = requests.post(f"{BASE_URL}/v1/video/generations", headers=headers, json={
    "model": "luminia-2.0",
    "prompt": "一只可爱的橘猫在草地上走动",
    "metadata": {
        "resolution": "720p",
        "ratio": "16:9",
        "duration": 5,
        "generate_audio": False
    }
})
result = resp.json()
task_id = result["id"]  # 或 result["task_id"]，两者相同
print(f"任务已提交: {task_id}")

# 步骤 2: 轮询任务状态（间隔 15 秒）
# GET /v1/video/generations/{task_id}
# 注意：路径是 /v1/video/generations/，不是 /v1/videos/
while True:
    time.sleep(15)
    resp = requests.get(f"{BASE_URL}/v1/video/generations/{task_id}", headers=headers)
    query_result = resp.json()
    # 注意：查询响应的数据在 data 字段中，和提交响应格式不同
    data = query_result["data"]
    status = data["status"]
    progress = data["progress"]
    print(f"状态: {status}  进度: {progress}")
    if status in ("SUCCESS", "FAILURE"):
        break

# 步骤 3: 获取视频
if status == "SUCCESS":
    # 方式一：直接使用查询结果中的 result_url
    video_url = data["result_url"]
    print(f"视频链接: {video_url}")

    # 方式二（可选）：通过 /v1/videos/{task_id}/content 获取永久链接
    # resp = requests.get(f"{BASE_URL}/v1/videos/{task_id}/content", headers=headers, allow_redirects=False)
    # permanent_url = resp.headers["Location"]
    # print(f"永久链接: {permanent_url}")
else:
    print(f"生成失败: {data['fail_reason']}")
```

## JavaScript/Node.js 完整示例

```javascript
const BASE_URL = "https://luapi.hagoot.com";
const API_KEY = "sk-your-token";

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`
};

// 步骤 1: 提交视频生成任务
// POST /v1/video/generations
const submitResp = await fetch(`${BASE_URL}/v1/video/generations`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: "luminia-2.0",
    prompt: "一只可爱的橘猫在草地上走动",
    metadata: { resolution: "720p", ratio: "16:9", duration: 5, generate_audio: false }
  })
});
const submitResult = await submitResp.json();
const taskId = submitResult.id; // 或 submitResult.task_id，两者相同
console.log(`任务已提交: ${taskId}`);

// 步骤 2: 轮询任务状态（间隔 15 秒）
// GET /v1/video/generations/{task_id}
// 注意：路径是 /v1/video/generations/，不是 /v1/videos/
let status, queryData;
do {
  await new Promise(r => setTimeout(r, 15000));
  const pollResp = await fetch(`${BASE_URL}/v1/video/generations/${taskId}`, { headers });
  const pollResult = await pollResp.json();
  // 注意：查询响应的数据在 data 字段中，和提交响应格式不同
  queryData = pollResult.data;
  status = queryData.status;
  console.log(`状态: ${status}  进度: ${queryData.progress}`);
} while (status !== "SUCCESS" && status !== "FAILURE");

// 步骤 3: 获取视频
if (status === "SUCCESS") {
  // 方式一：直接使用查询结果中的 result_url
  console.log(`视频链接: ${queryData.result_url}`);

  // 方式二（可选）：通过 /v1/videos/{task_id}/content 获取永久链接
  // const videoResp = await fetch(`${BASE_URL}/v1/videos/${taskId}/content`, { headers, redirect: "manual" });
  // const permanentUrl = videoResp.headers.get("Location");
  // console.log(`永久链接: ${permanentUrl}`);
} else {
  console.log(`生成失败: ${queryData.fail_reason}`);
}
```

---

## 4. 素材资产管理（虚拟人像）

素材资产（Assets）用于管理虚拟人像素材（图片/视频/音频），入库后的素材可通过 `asset://<asset_id>` 在视频生成中引用，实现人物形象一致性。

### 素材隔离机制

> **素材自动隔离**，不同 Token 之间、同一 Token 下的不同用户之间，互相看不到、也无法删除或修改对方的素材。

**两级隔离：**

| 级别 | 触发方式 | 隔离范围 | 适用场景 |
|------|---------|---------|---------|
| **Token 级** | 默认（不传 `X-Credential-Id`） | 每个 Token 独立素材空间 | 自用、一个 Token 对应一个用户 |
| **子用户级** | 请求头传 `X-Credential-Id` | 同一 Token 下按子用户标识隔离 | **多个用户共用一个 Token** |

```
Token A（用户甲）
  └── 素材空间 A ── 只有 Token A 能看到

Token B（用户乙）
  └── 素材空间 B ── 只有 Token B 能看到，看不到 A 的

Token C（下游平台，多人共用）
  ├── X-Credential-Id: user-001  ── 用户001的素材空间
  ├── X-Credential-Id: user-002  ── 用户002的素材空间（互相看不到）
  └── X-Credential-Id: user-003  ── 用户003的素材空间
  └── 不传 X-Credential-Id        ── Token C 的默认素材空间（和上面三个也互相独立）
```

---

#### 场景一：一个 Token 对应一个用户（自用）

**不需要做任何额外操作**，每个 Token 自动拥有独立的素材空间：

```bash
# Token A 上传素材
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-token-A" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/face.jpg", "name": "我的人脸"}'

# Token B 查素材 —— 看不到 Token A 的素材
curl -X POST https://luapi.hagoot.com/v1/assets/list \
  -H "Authorization: Bearer sk-token-B" \
  -H "Content-Type: application/json" \
  -d '{"PageNumber": 1, "PageSize": 20}'
# 返回: 空（Token B 没有上传过素材）
```

#### 场景二：多个用户共用一个 Token（下游平台）

> **重要**：如果多个终端用户共用同一个 Token，**必须**在所有素材请求中传入 `X-Credential-Id` 头来区分用户，否则所有人会共享同一份素材（能看到、删除对方的素材）。

`X-Credential-Id` 规则：
- 值由下游平台自行定义（用户 ID、手机号哈希、UUID 等），最长 128 字符
- 系统不做格式校验，首次使用自动创建独立素材空间
- **同一个 `X-Credential-Id` = 同一个素材空间**
- **不同的 `X-Credential-Id` = 完全隔离**

**完整示例：同一 Token，两个用户互相隔离**

```bash
# ========== 用户 A 的操作 ==========

# 用户 A 上传人脸
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-platform-token" \
  -H "X-Credential-Id: user-A-12345" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/user-a-face.jpg", "name": "用户A人脸"}'
# 返回: {"Result": {"Id": "asset-20260413-aaa"}}

# 用户 A 查素材 —— 只看到自己的
curl -X POST https://luapi.hagoot.com/v1/assets/list \
  -H "Authorization: Bearer sk-platform-token" \
  -H "X-Credential-Id: user-A-12345" \
  -H "Content-Type: application/json" \
  -d '{"PageNumber": 1, "PageSize": 20}'
# 返回: 只有 asset-20260413-aaa

# 用户 A 用素材生成视频（视频接口不需要传 X-Credential-Id）
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Authorization: Bearer sk-platform-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "luminia-2.0-fast",
    "prompt": "图片1里的人物微笑着走在街道上",
    "metadata": {
      "content": [{"type": "image_url", "image_url": {"url": "asset://asset-20260413-aaa"}}]
    }
  }'

# ========== 用户 B 的操作 ==========

# 用户 B 上传人脸
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-platform-token" \
  -H "X-Credential-Id: user-B-67890" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/user-b-face.jpg", "name": "用户B人脸"}'
# 返回: {"Result": {"Id": "asset-20260413-bbb"}}

# 用户 B 查素材 —— 看不到用户 A 的
curl -X POST https://luapi.hagoot.com/v1/assets/list \
  -H "Authorization: Bearer sk-platform-token" \
  -H "X-Credential-Id: user-B-67890" \
  -H "Content-Type: application/json" \
  -d '{"PageNumber": 1, "PageSize": 20}'
# 返回: 只有 asset-20260413-bbb
```

#### 隔离 FAQ

| 问题 | 答案 |
|------|------|
| 不传 `X-Credential-Id` 会怎样？ | 按 Token 隔离，每个 Token 有自己的默认素材空间 |
| 不同 Token 之间素材共享吗？ | **不共享**，每个 Token 完全独立 |
| 同一 Token 多人用，不传 `X-Credential-Id`？ | 所有人共享该 Token 的默认空间（互相能看到），所以多人共用时必须传 |
| 用户 A 能删除用户 B 的素材吗？ | 不能，ListAssets 只返回自己空间的素材 |
| `X-Credential-Id` 能随意填吗？ | 可以，系统不验证格式，但同一个值 = 同一个素材空间 |
| 首次使用新的 `X-Credential-Id` 需要初始化吗？ | 不需要，系统自动创建素材空间 |
| `X-Credential-Id` 只在素材接口用吗？ | 是的，只在 `/v1/assets/*` 接口使用。视频生成只需传 `asset://` 引用 |
| 下游平台想管理所有用户的素材？ | 需要分别使用各用户的 `X-Credential-Id` 查询 |

### 重要：素材入库 ≠ 自动使用

> **常见误解：把图片上传到素材库后，生成视频就会自动使用该人脸。这是错误的。**
>
> 素材入库只是"注册"——让系统对图片做人脸特征提取和预处理。**生成视频时仍然需要在请求中通过 `asset://` 主动引用该素材**，系统不会自动关联。

**正确流程（两步缺一不可）：**

```
第一步：上传素材入库（只需做一次）
  POST /v1/assets/create → 获得 asset_id → 等待状态变为 Active

第二步：生成视频时引用素材（每次生成都要传）
  POST /v1/video/generations → 在 content 中传入 asset://<asset_id>
```

**对比：直接传图片 vs 素材库引用**

| | 直接传图片 URL | 素材库 `asset://` 引用 |
|---|---|---|
| 请求方式 | `"image_url": {"url": "https://xxx.jpg"}` | `"image_url": {"url": "asset://asset-xxx"}` |
| 是否需要入库 | 不需要 | 需要先上传入库并等待 Active |
| 人物还原度 | 一般（当作普通参考图） | **高**（经过人脸特征提取预处理） |
| 适用场景 | 普通图生视频、背景参考 | 需要人物形象一致性的场景 |
| 是否可复用 | 每次都要传图片 | asset_id 永久有效，多次复用 |

### 核心概念

```
素材组 (Asset Group)          素材 (Asset)                    视频生成
┌─────────────────┐     ┌─────────────────┐
│ 虚拟人物A        │     │ 人脸特写.jpg     │ ──→ asset://asset-xxx ──┐
│ group-xxx        │ ──→ │ 三视图.jpg       │ ──→ asset://asset-yyy ──┼──→ 生成视频
│                  │     │ 服装参考.jpg     │ ──→ asset://asset-zzz ──┘
└─────────────────┘     └─────────────────┘
```

- **素材组 (Group)**：类似文件夹，用于分组管理。建议一个人物角色对应一个组。
- **素材 (Asset)**：单个文件（一张图片 / 一段视频 / 一段音频），**每次上传一个文件**。
- **生成视频时**：可从素材库中**同时引用 1~9 个素材**，在 prompt 中用"图片1""图片2"指代。
- **素材可复用**：入库后的素材 ID 永久有效，生成视频时直接引用，无需重复上传。

> **一个人物通常需要上传多个素材**：建议分别上传「人脸无表情特写」「妆造三视图」「服装细节」等，各自作为独立素材入库，生成时按需组合引用。

### 完整流程

```
步骤 1: POST /v1/assets/groups          → 创建素材组（可选，不传 group_id 时自动使用默认组）
步骤 2: POST /v1/assets/create          → 上传素材到指定组（每次一个文件，需多次调用上传多个）
步骤 3: POST /v1/assets/get             → 轮询素材状态，等待 Active（通常 10-30 秒）
步骤 4: 在视频生成的 content 数组中传入多个 asset://<asset_id> 引用
```

> 每个用户自动拥有一个默认素材组。也可以手动创建自定义素材组来分类管理（如"角色A"、"场景素材"等）。

### 素材接口列表

所有素材接口均为 `POST` 方法，请求体为 JSON。所有接口对已认证的 Token 开放，无需额外授权。

```
Authorization: Bearer sk-your-token
Content-Type: application/json
```

| 接口 | 路径 | 说明 |
|------|------|------|
| 创建素材组 | `POST /v1/assets/groups` | 创建自定义素材组（可选，用于分类管理） |
| 上传素材 | `POST /v1/assets/create` | 上传图片/视频/音频到指定组（不指定则用默认组） |
| 查询素材 | `POST /v1/assets/get` | 查询单个素材状态（轮询用） |
| 列出素材 | `POST /v1/assets/list` | 列出当前空间的所有素材 |
| 更新素材 | `POST /v1/assets/update` | 更新素材名称 |
| 删除素材 | `POST /v1/assets/delete` | 删除单个素材 |
| 列出素材组 | `POST /v1/assets/groups/list` | 列出当前空间的所有素材组 |
| 查询素材组 | `POST /v1/assets/groups/get` | 查询素材组信息 |
| 更新素材组 | `POST /v1/assets/groups/update` | 更新素材组名称 |

> 每个用户自动拥有一个默认素材组，也可以手动创建自定义组。所有接口只能操作自己空间内的素材和组，跨空间操作会返回 403。

### 快速上手：最简上传（只需一个 URL）

```bash
# 最简调用：只需传素材 URL，其他全部自动填充
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-image.com/face.jpg"}'
```

系统自动处理：
- **没传 group_id** → 自动分配到当前空间的默认素材组
- **没传 AssetType** → 默认为 `Image`
- **没传 ProjectName** → 使用默认项目
- **字段名大小写** → `url`/`URL`、`group_id`/`GroupId`/`groupId` 都支持

响应：
```json
{"Result": {"Id": "asset-20260411-xxxxx"}}
```

然后查询状态直到 `Active`，再用 `asset://asset-20260411-xxxxx` 生成视频。

---

### 4.1 创建素材组（可选）

每个用户自动拥有一个**默认素材组**，上传素材时不传 `group_id` 就会进入默认组。如果需要分类管理（如不同角色、不同项目），可以手动创建自定义素材组：

```bash
curl -X POST https://luapi.hagoot.com/v1/assets/groups \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "角色A-人物素材", "description": "角色A相关的所有素材"}'
```

**下游平台（隔离子用户）：**
```bash
curl -X POST https://luapi.hagoot.com/v1/assets/groups \
  -H "Authorization: Bearer sk-your-token" \
  -H "X-Credential-Id: end-user-12345" \
  -H "Content-Type: application/json" \
  -d '{"name": "我的角色", "description": "用户12345的角色素材"}'
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 素材组名称，最多 64 字符 |
| `description` | string | 否 | 描述，最多 300 字符 |

响应：`{"Result": {"Id": "group-20260414-xxxxx"}}`

> 创建的素材组只对当前空间可见。不同 Token / 不同 `X-Credential-Id` 之间的素材组互相不可见。

### 4.2 上传素材

**上传到默认组（最简）：**
```bash
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/my-character.jpg", "name": "人物正面照"}'
```

**上传到指定素材组：**
```bash
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/my-character.jpg",
    "name": "人物正面照",
    "group_id": "group-20260414-xxxxx"
  }'
```

**下游平台（隔离终端用户）：**
```bash
curl -X POST https://luapi.hagoot.com/v1/assets/create \
  -H "Authorization: Bearer sk-your-token" \
  -H "X-Credential-Id: end-user-12345" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/my-character.jpg", "name": "人物正面照"}'
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | **是** | - | 素材文件地址（公网 URL 或 `data:image/jpeg;base64,...`） |
| `name` | string | 否 | - | 素材名称，仅用于搜索，不影响推理 |
| `asset_type` | string | 否 | `Image` | 素材类型：`Image` / `Video` / `Audio` |
| `group_id` | string | 否 | 默认组 | 目标素材组 ID（必须是自己空间内的组，否则返回 403） |

| 请求头 | 必填 | 说明 |
|--------|------|------|
| `Authorization` | **是** | `Bearer sk-your-token` |
| `X-Credential-Id` | 否 | 子用户标识，用于下游平台隔离终端用户素材（不传则按 Token 隔离） |

> **字段名兼容**：所有字段同时支持三种写法：`asset_type` = `assetType` = `AssetType`，系统自动转换。
>
> **支持 Base64**：`url` 可传 `data:image/jpeg;base64,...`，系统自动上传到云存储转公网链接。
>
> **分组规则**：不传 `group_id` 则自动放入默认组；传了 `group_id` 则放入指定组（必须是自己空间内的组）。

**素材文件要求：**

| 类型 | 格式 | 大小 | 其他限制 |
|------|------|------|----------|
| Image | jpeg, png, webp, bmp, tiff, gif | < 30 MB | 宽高 300-6000px，宽高比 0.4-2.5 |
| Video | mp4, mov | < 50 MB | 时长 2-15s，帧率 24-60fps |
| Audio | wav, mp3 | < 15 MB | 时长 2-15s |

### 4.3 查询素材状态

素材上传后需预处理（通常 10-30 秒），轮询直到 `Active`：

```bash
curl -X POST https://luapi.hagoot.com/v1/assets/get \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{"id": "asset-20260411-xxxxx"}'
```

| 状态 | 说明 | 操作 |
|------|------|------|
| `Processing` | 预处理中 | 等 5 秒再查 |
| `Active` | 就绪 | 可用 `asset://<id>` 生成视频 |
| `Failed` | 失败 | 检查素材格式是否合规 |

### 4.4 使用素材生成视频

素材 `Active` 后，在视频生成请求中通过 `asset://<asset_id>` 引用：

```bash
curl -X POST https://luapi.hagoot.com/v1/video/generations \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "luminia-2.0-fast",
    "prompt": "图片1里的人物微笑着走在阳光明媚的街道上",
    "metadata": {
      "resolution": "720p",
      "ratio": "16:9",
      "duration": 5,
      "content": [
        {"type": "image_url", "image_url": {"url": "asset://asset-20260411-xxxxx"}}
      ]
    }
  }'
```

> **prompt 中用"图片1"、"图片2"指代素材**（按 content 数组顺序），不要在 prompt 中写 asset ID。

**多素材示例：**

```json
{
  "model": "luminia-2.0",
  "prompt": "图片1里的女孩身着图片2中的服装，在图片3的场景中走动",
  "metadata": {
    "content": [
      {"type": "image_url", "image_url": {"url": "asset://asset-人脸特写"}},
      {"type": "image_url", "image_url": {"url": "asset://asset-服装参考"}},
      {"type": "image_url", "image_url": {"url": "asset://asset-背景参考"}}
    ]
  }
}
```

### 4.5 列出素材 / 删除素材

> 列表接口自动过滤，只返回当前账号（或 `X-Credential-Id` 对应子用户）拥有的素材。

**自用：**
```bash
# 列出当前账号的素材
curl -X POST https://luapi.hagoot.com/v1/assets/list \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{"PageNumber": 1, "PageSize": 20}'
```

**下游平台（查某个终端用户的素材）：**
```bash
# 列出特定终端用户的素材
curl -X POST https://luapi.hagoot.com/v1/assets/list \
  -H "Authorization: Bearer sk-your-token" \
  -H "X-Credential-Id: end-user-12345" \
  -H "Content-Type: application/json" \
  -d '{"PageNumber": 1, "PageSize": 20}'
```

**删除素材（只能删除自己空间内的）：**
```bash
curl -X POST https://luapi.hagoot.com/v1/assets/delete \
  -H "Authorization: Bearer sk-your-token" \
  -H "X-Credential-Id: end-user-12345" \
  -H "Content-Type: application/json" \
  -d '{"id": "asset-20260413-xxxxx"}'
```

---

### Python 工程化示例：LuminiaAssetManager 类

```python
import requests
import time

class LuminiaAssetManager:
    """
    素材资产管理器 —— 封装素材上传、状态查询、视频生成全流程

    隔离机制：
    - 自用：不传 credential_id，素材按账号隔离
    - 下游平台：传 credential_id（终端用户标识），素材按子用户隔离
    """

    def __init__(self, api_key, base_url="https://luapi.hagoot.com", credential_id=None):
        """
        Args:
            api_key: API Token（sk-xxx）
            base_url: API 地址
            credential_id: 子用户标识（下游平台隔离终端用户时必传）
                           不传则按账号隔离，同一账号下所有 Token 共享素材
        """
        self.base_url = base_url
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        if credential_id:
            self.headers["X-Credential-Id"] = credential_id

    # ========== 素材管理 ==========
    # 素材组由系统自动管理，无需手动创建
    # 素材按 credential_id 隔离（不传则按账号隔离）

    def upload_asset(self, url, name="", asset_type="Image"):
        """
        上传素材（图片/视频/音频）
        素材自动归入当前凭证的专属素材空间

        Args:
            url: 素材文件地址（公网URL 或 Base64 data URI）
            name: 素材名称（可选，仅用于搜索）
            asset_type: Image / Video / Audio（默认 Image）

        Returns:
            asset_id: 素材ID，格式如 asset-20260413-xxxxx
        """
        body = {"url": url, "asset_type": asset_type}
        if name:
            body["name"] = name
        resp = requests.post(f"{self.base_url}/v1/assets/create",
            headers=self.headers, json=body)
        resp.raise_for_status()
        return resp.json()["Result"]["Id"]

    def wait_active(self, asset_id, timeout=120, interval=5):
        """轮询等待素材预处理完成，返回 True/False"""
        start = time.time()
        while time.time() - start < timeout:
            resp = requests.post(f"{self.base_url}/v1/assets/get",
                headers=self.headers, json={"id": asset_id})
            status = resp.json()["Result"]["Status"]
            print(f"  素材 {asset_id}: {status}")
            if status == "Active":
                return True
            if status == "Failed":
                print(f"  失败: {resp.json()['Result'].get('Error', {})}")
                return False
            time.sleep(interval)
        print("  超时")
        return False

    def list_assets(self, page=1, size=20):
        """列出当前凭证空间的素材（自动隔离，只返回自己的）"""
        body = {"PageNumber": page, "PageSize": size}
        resp = requests.post(f"{self.base_url}/v1/assets/list",
            headers=self.headers, json=body)
        return resp.json()["Result"]

    def delete_asset(self, asset_id):
        """删除素材（只能删除自己空间内的）"""
        resp = requests.post(f"{self.base_url}/v1/assets/delete",
            headers=self.headers, json={"id": asset_id})
        return resp.status_code == 200

    # ========== 视频生成 ==========

    def generate_video(self, prompt, asset_ids, model="luminia-2.0-fast",
                       resolution="720p", ratio="16:9", duration=5):
        """
        使用素材生成视频

        Args:
            prompt: 视频描述（用"图片1"、"图片2"指代素材）
            asset_ids: 素材ID列表，如 ["asset-xxx", "asset-yyy"]
            model: 模型名称
            resolution: 分辨率 480p/720p
            ratio: 宽高比 16:9/9:16/1:1 等
            duration: 时长 4-15 秒

        Returns:
            task_id: 视频任务ID
        """
        content = []
        for aid in asset_ids:
            url = aid if aid.startswith("asset://") else f"asset://{aid}"
            content.append({"type": "image_url", "image_url": {"url": url}})

        resp = requests.post(f"{self.base_url}/v1/video/generations",
            headers=self.headers, json={
                "model": model,
                "prompt": prompt,
                "metadata": {
                    "resolution": resolution, "ratio": ratio,
                    "duration": duration, "content": content
                }
            })
        resp.raise_for_status()
        return resp.json()["id"]

    def wait_video(self, task_id, timeout=600, interval=15):
        """轮询等待视频生成完成，返回视频URL或None"""
        start = time.time()
        while time.time() - start < timeout:
            resp = requests.get(
                f"{self.base_url}/v1/video/generations/{task_id}",
                headers=self.headers)
            data = resp.json()["data"]
            print(f"  视频 {task_id}: {data['status']} {data['progress']}")
            if data["status"] == "SUCCESS":
                return data["result_url"]
            if data["status"] == "FAILURE":
                print(f"  失败: {data.get('fail_reason', '')}")
                return None
            time.sleep(interval)
        print("  超时")
        return None

    # ========== 一键生成（上传 + 等待 + 生成） ==========

    def upload_and_generate(self, image_urls, prompt, **kwargs):
        """
        一键完成：上传多张素材 → 等待就绪 → 生成视频

        Args:
            image_urls: 素材URL列表（公网URL 或 Base64）
            prompt: 视频描述（用"图片1"指代第一张素材，以此类推）
            **kwargs: generate_video 的其他参数

        Returns:
            video_url: 生成的视频链接
        """
        asset_ids = []
        for i, url in enumerate(image_urls):
            print(f"上传素材 {i+1}/{len(image_urls)}...")
            aid = self.upload_asset(url, name=f"素材{i+1}")
            asset_ids.append(aid)

        print("等待素材处理...")
        for aid in asset_ids:
            if not self.wait_active(aid):
                raise Exception(f"素材 {aid} 处理失败")

        print("提交视频生成...")
        task_id = self.generate_video(prompt, asset_ids, **kwargs)
        print(f"任务ID: {task_id}")

        print("等待视频生成...")
        return self.wait_video(task_id)


# ==================== 使用示例 ====================

if __name__ == "__main__":

    # ==================== 场景 1：自用 ====================
    # 不传 credential_id，素材按账号隔离
    mgr = LuminiaAssetManager(api_key="sk-your-token")

    # 上传一张图就能生成视频
    video_url = mgr.upload_and_generate(
        image_urls=["https://your-image.com/face.jpg"],
        prompt="图片1里的人物微笑着走在阳光明媚的街道上，镜头缓缓推近"
    )
    print(f"视频: {video_url}")

    # 复用已入库的素材（不需要重复上传）
    # task_id = mgr.generate_video(
    #     prompt="图片1里的人物在咖啡厅看书",
    #     asset_ids=["asset-20260413-xxxxx"],
    #     model="luminia-2.0-fast"
    # )
    # video_url = mgr.wait_video(task_id)


    # ==================== 场景 2：下游平台（隔离终端用户） ====================
    # 传 credential_id，每个终端用户的素材互相独立

    # 为用户 A 创建管理器
    # mgr_a = LuminiaAssetManager(
    #     api_key="sk-platform-token",
    #     credential_id="user-A-12345"    # 用户 A 的标识
    # )
    # aid = mgr_a.upload_asset("https://xxx/user-a-face.jpg", name="用户A人脸")
    # mgr_a.wait_active(aid)
    # print(f"用户A素材: {mgr_a.list_assets()}")  # 只看到用户 A 的

    # 为用户 B 创建管理器
    # mgr_b = LuminiaAssetManager(
    #     api_key="sk-platform-token",    # 同一个平台 Token
    #     credential_id="user-B-67890"    # 用户 B 的标识
    # )
    # aid = mgr_b.upload_asset("https://xxx/user-b-face.jpg", name="用户B人脸")
    # mgr_b.wait_active(aid)
    # print(f"用户B素材: {mgr_b.list_assets()}")  # 只看到用户 B 的，看不到 A 的
```

### JavaScript/Node.js 工程化示例

```javascript
class LuminiaAssetManager {
  /**
   * @param {string} apiKey - API Token (sk-xxx)
   * @param {string} [baseUrl] - API 地址
   * @param {string} [credentialId] - 子用户标识（下游平台隔离终端用户时传入）
   */
  constructor(apiKey, baseUrl = "https://luapi.hagoot.com", credentialId = null) {
    this.baseUrl = baseUrl;
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
    if (credentialId) {
      this.headers["X-Credential-Id"] = credentialId;
    }
  }

  async uploadAsset(url, name = "", assetType = "Image") {
    const body = { url, asset_type: assetType };
    if (name) body.name = name;
    const resp = await fetch(`${this.baseUrl}/v1/assets/create`, {
      method: "POST", headers: this.headers, body: JSON.stringify(body)
    });
    const data = await resp.json();
    return data.Result.Id;
  }

  async waitActive(assetId, timeout = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const resp = await fetch(`${this.baseUrl}/v1/assets/get`, {
        method: "POST", headers: this.headers, body: JSON.stringify({ id: assetId })
      });
      const { Result } = await resp.json();
      if (Result.Status === "Active") return true;
      if (Result.Status === "Failed") return false;
      await new Promise(r => setTimeout(r, 5000));
    }
    return false;
  }

  async generateVideo(prompt, assetIds, model = "luminia-2.0-fast") {
    const content = assetIds.map(id => ({
      type: "image_url",
      image_url: { url: id.startsWith("asset://") ? id : `asset://${id}` }
    }));
    const resp = await fetch(`${this.baseUrl}/v1/video/generations`, {
      method: "POST", headers: this.headers,
      body: JSON.stringify({
        model, prompt,
        metadata: { resolution: "720p", ratio: "16:9", duration: 5, content }
      })
    });
    return (await resp.json()).id;
  }

  async waitVideo(taskId, timeout = 600000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const resp = await fetch(`${this.baseUrl}/v1/video/generations/${taskId}`,
        { headers: this.headers });
      const { data } = await resp.json();
      if (data.status === "SUCCESS") return data.result_url;
      if (data.status === "FAILURE") return null;
      await new Promise(r => setTimeout(r, 15000));
    }
    return null;
  }

  // 一键：上传素材 → 等就绪 → 生成视频
  async uploadAndGenerate(imageUrls, prompt, model) {
    const assetIds = [];
    for (const url of imageUrls) {
      assetIds.push(await this.uploadAsset(url));
    }
    for (const id of assetIds) {
      if (!(await this.waitActive(id))) throw new Error(`素材 ${id} 处理失败`);
    }
    const taskId = await this.generateVideo(prompt, assetIds, model);
    return await this.waitVideo(taskId);
  }
}

// 自用
const mgr = new LuminiaAssetManager("sk-your-token");
const videoUrl = await mgr.uploadAndGenerate(
  ["https://your-image.com/face.jpg"],
  "图片1里的人物微笑着走在街道上"
);

// 下游平台：为不同终端用户创建隔离的管理器
// const mgrUserA = new LuminiaAssetManager("sk-platform-token", undefined, "user-A");
// const mgrUserB = new LuminiaAssetManager("sk-platform-token", undefined, "user-B");
// await mgrUserA.uploadAsset("https://xxx/face-a.jpg");  // 用户A的素材
// await mgrUserB.uploadAsset("https://xxx/face-b.jpg");  // 用户B的素材，和A互相看不到
```

### 素材上传最佳实践

| 做法 | 效果 |
|------|------|
| 人脸特写单独上传一张素材 | 人物面部还原度最高 |
| 三视图（正面/侧面/背面）单独上传 | 妆造和体型更准确 |
| 背景/场景图单独上传 | 场景风格更可控 |
| 每种参考素材独立一张图 | 模型识别更准确 |
| 同一人物素材放同一素材组 | 方便管理和复用 |
| 素材 Active 后保存 ID 复用 | 不需要每次重新上传 |

**不建议：**
- 把人脸、服装、背景合并到一张图 → 各元素占比太小，识别不准
- 素材使用真人照片 → 必须是虚拟人像，不得与真实自然人肖像雷同

---

## 5. 文本对话（Chat Completions）

兼容 **OpenAI Chat Completions 协议**，可直接使用 `openai` Python/Node SDK，把 `base_url` 指到本服务即可。

```
POST https://luapi.hagoot.com/v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-your-token
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名，如 `qwen3.6-flash`、`qwen-plus`、`qwq-32b` |
| `messages` | array | 是 | OpenAI 标准消息数组，每项含 `role`（`system`/`user`/`assistant`）+ `content` |
| `stream` | bool | 否 | 是否使用 SSE 流式返回，默认 `false` |
| `max_tokens` | int | 否 | 最大输出 tokens 数 |
| `temperature` | float | 否 | 采样温度，0-2，默认随模型 |
| `top_p` | float | 否 | 核采样参数 |
| `extra_body.enable_thinking` | bool | 否 | 是否开启"深度思考"。支持该能力的模型会额外返回思考过程（`reasoning_content`） |

### 响应字段

流式和非流式都支持 `content` + `reasoning_content` 两个字段并存：

- `choices[].message.content`（非流式）/ `delta.content`（流式）— 最终回复文本
- `choices[].message.reasoning_content`（非流式）/ `delta.reasoning_content`（流式）— 模型的思考过程，**仅深度思考模型返回**

### Python 示例（`openai` SDK + 流式 + 深度思考）

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-token",
    base_url="https://luapi.hagoot.com/v1",
)

messages = [{"role": "user", "content": "你是谁"}]
completion = client.chat.completions.create(
    model="qwen3.6-flash",
    messages=messages,
    extra_body={"enable_thinking": True},
    stream=True,
)

is_answering = False
print("\n" + "=" * 20 + "思考过程" + "=" * 20)
for chunk in completion:
    delta = chunk.choices[0].delta
    if getattr(delta, "reasoning_content", None):
        print(delta.reasoning_content, end="", flush=True)
    if getattr(delta, "content", None):
        if not is_answering:
            print("\n" + "=" * 20 + "完整回复" + "=" * 20)
            is_answering = True
        print(delta.content, end="", flush=True)
```

### 非流式调用（curl）

```bash
curl -X POST https://luapi.hagoot.com/v1/chat/completions \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.6-flash",
    "messages": [{"role": "user", "content": "你是谁"}],
    "extra_body": {"enable_thinking": true}
  }'
```

### 深度思考兼容性

| 模型 | 深度思考 | `enable_thinking` 默认 |
|------|----------|------------------------|
| `qwen3.6-flash` | ✅ 可切换 | `false` |
| `qwen3-235b-a22b` | ✅ 可切换 | `false` |
| `qwq-32b` | ✅ 始终开启 | — |
| `qwen-turbo` / `qwen-plus` / `qwen-max` | ❌ 不支持 | — |

> `qwen-turbo`/`qwen-plus`/`qwen-max` 传 `enable_thinking: true` 不会报错，但响应里不会有 `reasoning_content` 字段。

---

## 常见错误

### HTTP 状态码错误

| HTTP 状态码 | 错误信息 | 原因 | 解决 |
|-------------|----------|------|------|
| 404 | Not Found | 路径拼写错误，如用了 `/v1/videos/` 查询状态 | 查询状态用 `/v1/video/generations/{task_id}` |
| 401 | Unauthorized | Token 无效或过期 | 检查 Authorization 头格式和 Token 有效性 |
| 403 | 令牌额度不足 | Token 余额不足以支付本次生成费用 | 充值后重试，错误信息中包含剩余额度和所需额度 |
| 403 | 账户额度不足 | 账户总余额不足 | 联系管理员充值 |
| 403 | This token has no access to model | Token 未被授权访问该模型 | 联系管理员开通模型权限 |
| 400 | prompt is required | 缺少 prompt 参数 | 请求体必须包含 prompt 字段 |

### 任务失败错误（通过 fail_reason 返回）

任务提交成功但生成失败时，通过轮询接口的 `fail_reason` 字段查看具体原因：

| 错误码 | 说明 | 建议 |
|--------|------|------|
| `OutputVideoSensitiveContentDetected` | AI 生成的视频内容触发了安全审核 | 修改 prompt 描述，避免涉及敏感内容 |
| `InvalidParameter.BodyFormat` | 上传的参考素材（图片/视频）格式无效 | 检查文件格式是否符合输入素材要求 |
| `InvalidParameter` | 请求参数不合法 | 检查参数格式和取值范围 |
| `任务超时` | 任务处理超过 24 小时未完成 | 重新提交任务 |
