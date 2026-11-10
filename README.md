# 逐句朗读 (Auto TTS)

在每条回复的对话行后面加一个 ▶ 小按钮，点一下只念这一句，用该角色对应的音色。

不改动消息内容，不往上下文里塞标签，纯前端装饰。删掉文件夹即完全卸载。

---

## 一、装到哪

整个 `st-auto-tts` 文件夹必须放在这个目录下：

```
SillyTavern/public/scripts/extensions/third-party/st-auto-tts/
```

放完目录结构应该是：

```
SillyTavern/
└── public/
    └── scripts/
        └── extensions/
            └── third-party/
                └── st-auto-tts/
                    ├── manifest.json
                    ├── index.js
                    ├── style.css
                    └── README.md
```

### 情况 1：电脑上跑的酒馆

直接把文件夹拖进去，重启酒馆（关掉黑窗口重新 `node server.js`）。

### 情况 2：安卓 Termux 本机跑的酒馆

```bash
# 先解压到下载目录，再拷进去（路径按你自己的改）
cp -r ~/storage/downloads/st-auto-tts ~/SillyTavern/public/scripts/extensions/third-party/
```

如果提示找不到 `~/SillyTavern`，用 `find ~ -maxdepth 2 -name "SillyTavern" -type d` 找一下真实位置。

### 情况 3：网页版 / 云酒馆 / 套壳 App

这类没有文件系统权限，`third-party` 目录你碰不到。只有两条路：

- 套壳 App 若带「上传扩展」或「安装扩展（zip）」，直接传 `st-auto-tts.zip`
- 否则只能等我把它推到一个 GitHub 仓库，你在酒馆里「扩展 → 安装扩展」填仓库地址

---

## 二、装完看什么

1. 重启后打开酒馆，右上角「扩展」（积木图标）里应该出现 **逐句朗读 (Auto TTS)**。
2. 打开一条已有的 AI 回复，`【罗根】「……」` 这种行的末尾应该多出一个灰色小圆点。
3. 点它 → 出声。没配接口时会用浏览器自带语音（手机上是系统 TTS，音色难听但能证明链路通）。

如果按钮没出现：

- F12 / 手机调试看 Console 有没有 `[st-auto-tts] loaded`。没有 = 文件没放对位置。
- 有 loaded 但没按钮 = 你的正文不是 `【角色】「台词」` 格式，把一行原文发我，我改正则。

---

## 三、接真音色

扩展设置里填：

| 字段 | 说明 |
|---|---|
| TTS 接口地址 | OpenAI 兼容的 `/audio/speech`，如 `https://api.openai.com/v1/audio/speech` |
| API Key | 没有就留空 |
| 模型 | `tts-1` / `gpt-4o-mini-tts` / 网关自定义名 |
| 角色 → 音色 | 每行 `角色=音色ID`，例：`罗根=alloy` |

音色 ID 取决于你用的服务。想用克隆音色（比如某个特定嗓音），先在服务端克隆好，拿到 voice id 填进来即可。

用的不是 OpenAI 兼容接口（比如 GPT-SoVITS 原生 API、ElevenLabs 原生），告诉我服务名，我改 `playRemote()` 那一段。

---

## 四、卸载

删掉 `st-auto-tts` 文件夹，重启。没有残留。

---

## 五、已知限制

- 只识别 `【角色】「台词」` 和 `角色：「台词」` 两种写法。旁白不念。
- 消息被重新渲染（换 swipe、重新生成）时会重新扫描；同一条消息内不会重复加按钮。
- 长文本（>600 字）不识别，避免误吞整段旁白。
