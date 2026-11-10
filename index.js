/**
 * 逐句朗读 (Auto TTS) — 第三方扩展 v1.4
 *
 * v1.4：新增「本地 GPT-SoVITS」服务商（api_v2.py）。用 <audio> 直连拼好的 GET URL，
 *       绕开本地服务不返回 CORS 头的问题，手机跨域也能播。
 *       音色映射格式：参考音频路径|参考文本|语言
 *
 * v1.3：新增服务商下拉（OpenAI 兼容 / ElevenLabs / Fish Audio），各带默认地址与模型
 * v1.2：注入改为整块 HTML 替换，可跨标签匹配（角色名被 <font> 上色也能识别）
 * v1.1：容器自动探测 + MutationObserver 盯梢 + 诊断按钮
 */


import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'st_auto_tts';
const TAG = '[st-auto-tts]';

const DEFAULT_SETTINGS = {
    enabled: true,
    provider: 'openai',      // openai | elevenlabs | fish
    apiUrl: '',
    apiKey: '',
    model: 'tts-1',
    responseFormat: 'mp3',
    defaultVoice: 'alloy',
    voiceMap: '罗根=alloy\n伊芙=shimmer',
    speed: 1.0,
    browserFallback: true,
};

// 各家的默认地址与模型，切换服务时自动填
const PROVIDER_PRESETS = {
    openai: {
        url: 'https://api.openai.com/v1/audio/speech',
        model: 'gpt-4o-mini-tts',
        hint: 'OpenAI 或任何 OpenAI 兼容的 /audio/speech 接口',
    },
    elevenlabs: {
        url: 'https://api.elevenlabs.io/v1/text-to-speech',
        model: 'eleven_multilingual_v2',
        hint: 'ElevenLabs：地址填到 /v1/text-to-speech 为止，音色填 voice_id',
    },
    fish: {
        url: 'https://api.fish.audio/v1/tts',
        model: 'speech-1.1',
        hint: 'Fish Audio：音色填 reference_id（克隆后拿到的 ID）',
    },
    sovits: {
        url: 'http://192.168.1.100:9880',
        model: '',
        hint: '本地 GPT-SoVITS：地址填电脑的 局域网IP:9880；音色填 参考音频路径|参考文字|语言',
    },
};

/* ------------------------------------------------------------------ */
/* 台词识别                                                            */
/* ------------------------------------------------------------------ */

/*
 * HTML 级匹配：角色名与台词之间允许出现任意标签（上色 span/font 等），
 * 台词内部也允许被标签打断。
 *   组1：【角色】      组2：角色：      组3：台词（可能含标签）
 */
const LINE_HTML_SOURCE =
    '(?:【([^】\\n]{1,16})】|([\\u4e00-\\u9fa5A-Za-z·]{1,8})[：:])' +
    '\\s*(?:<[^>]+>\\s*)*' +
    '[「“]((?:[^」”\\n]|<[^>]+>){1,600})[」”]';

// 纯文本快速预检用（有没有台词）
const DIALOGUE_TEST = new RegExp(
    '(?:【[^】\\n]{1,16}】|[\\u4e00-\\u9fa5A-Za-z·]{1,8}[：:])\\s*[「“][^」”\\n]{1,600}[」”]'
);

/* ------------------------------------------------------------------ */
/* 状态                                                               */
/* ------------------------------------------------------------------ */

let settings = { ...DEFAULT_SETTINGS };
let currentAudio = null;
let currentBtn = null;
let currentUtter = null;
let lastStats = null;

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    Object.assign(extension_settings[MODULE_NAME], settings);
}

function persist() {
    Object.assign(extension_settings[MODULE_NAME], settings);
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* 音色                                                               */
/* ------------------------------------------------------------------ */

function resolveVoice(charName) {
    const map = String(settings.voiceMap || '');
    for (const line of map.split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw || !raw.includes('=')) continue;
        const idx = raw.indexOf('=');
        const key = raw.slice(0, idx).trim();
        const val = raw.slice(idx + 1).trim();
        if (!key || !val) continue;
        if (charName.includes(key) || key.includes(charName)) return val;
    }
    return settings.defaultVoice || 'alloy';
}

/* ------------------------------------------------------------------ */
/* 播放                                                               */
/* ------------------------------------------------------------------ */

function stopPlayback() {
    if (currentAudio) {
        try { currentAudio.pause(); } catch (e) { /* ignore */ }
        currentAudio.src = '';
        currentAudio = null;
    }
    if (currentUtter) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
        currentUtter = null;
    }
    if (currentBtn) {
        currentBtn.classList.remove('sttts-playing');
        currentBtn = null;
    }
}

async function playText(btn) {
    if (currentBtn === btn) {
        stopPlayback();
        return;
    }

    const charName = btn.dataset.char || '';
    const text = btn.dataset.text || '';
    if (!text) return;

    stopPlayback();
    btn.classList.add('sttts-playing');
    currentBtn = btn;

    try {
        if (settings.apiUrl) {
            await playRemote(text, resolveVoice(charName));
        } else if (settings.browserFallback) {
            playBrowser(text);
        } else {
            stopPlayback();
            notify('warn', '还没填 TTS 接口地址，也没开浏览器兜底');
        }
    } catch (err) {
        console.error(TAG, err);
        stopPlayback();
        notify('error', '朗读失败：' + (err && err.message ? err.message : err));
    }
}

async function playRemote(text, voice) {
    const provider = settings.provider || 'openai';
    let audioUrl;

    if (provider === 'elevenlabs') {
        audioUrl = await ttsElevenLabs(text, voice);
    } else if (provider === 'fish') {
        audioUrl = await ttsFish(text, voice);
    } else if (provider === 'sovits') {
        // 本地 GPT-SoVITS：直接用 <audio src> 拉取，绕开 CORS（本地服务默认不发 CORS 头）
        audioUrl = buildSovitsUrl(text, voice);
    } else {
        audioUrl = await ttsOpenAI(text, voice);
    }

    const audio = new Audio(audioUrl);
    currentAudio = audio;
    audio.onended = () => {
        if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
        stopPlayback();
    };
    audio.onerror = () => {
        if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
        stopPlayback();
    };
    await audio.play();
}

/**
 * 本地 GPT-SoVITS（api_v2.py）：拼一个 GET URL 交给 <audio>，不经过 fetch。
 * 这样手机上的酒馆跨域访问电脑的 9880 端口也不会被 CORS 拦住。
 * 音色映射值格式：参考音频路径|参考文字|语言（语言可省，默认 zh）
 */
function buildSovitsUrl(text, voice) {
    const base = (settings.apiUrl || PROVIDER_PRESETS.sovits.url).trim().replace(/\/+$/, '');
    const parts = String(voice || '').split('|');
    const refPath = (parts[0] || '').trim();
    const promptText = (parts[1] || '').trim();
    const promptLang = (parts[2] || 'zh').trim();

    if (!refPath || refPath === 'alloy') {
        throw new Error('这个角色还没有配参考音频，去「角色 → 音色」里填：路径|参考文字|语言');
    }

    const textLang = /[\u4e00-\u9fa5]/.test(text) ? 'zh' : 'en';

    const q = new URLSearchParams({
        text: text,
        text_lang: textLang,
        ref_audio_path: refPath,
        prompt_text: promptText,
        prompt_lang: promptLang,
        text_split_method: 'cut5',
        batch_size: '1',
        media_type: 'wav',
        streaming_mode: 'false',
    });

    return `${base}/tts?${q.toString()}`;
}

/** 把响应变成可播放的 URL：二进制走 blob，JSON 里找 audio/url 字段 */
async function responseToAudioUrl(res) {
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('application/json')) {
        const data = await res.json();
        if (data && typeof data.audio === 'string') return 'data:audio/mpeg;base64,' + data.audio;
        if (data && typeof data.url === 'string') return data.url;
        if (data && data.data && typeof data.data.audio === 'string') {
            return 'data:audio/mpeg;base64,' + data.data.audio;
        }
        throw new Error('返回了 JSON，但没找到音频字段：' + JSON.stringify(data).slice(0, 120));
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
}

async function readError(res) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
    return `HTTP ${res.status} ${detail}`;
}

/** OpenAI 兼容：POST {url}  body: {model,input,voice,response_format,speed} */
async function ttsOpenAI(text, voice) {
    const url = (settings.apiUrl || PROVIDER_PRESETS.openai.url).trim();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey.trim()) headers['Authorization'] = 'Bearer ' + settings.apiKey.trim();

    const body = {
        model: settings.model || 'tts-1',
        input: text,
        voice: voice,
        response_format: settings.responseFormat || 'mp3',
        speed: Number(settings.speed) || 1.0,
    };

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await readError(res));
    return responseToAudioUrl(res);
}

/** ElevenLabs：POST {base}/{voice_id}?output_format=mp3_44100_128  header: xi-api-key */
async function ttsElevenLabs(text, voice) {
    const base = (settings.apiUrl || PROVIDER_PRESETS.elevenlabs.url).trim().replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;

    const body = {
        text: text,
        model_id: settings.model || 'eleven_multilingual_v2',
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': settings.apiKey.trim(),
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res));
    return responseToAudioUrl(res);
}

/** Fish Audio：POST {base}  header: Authorization + model  body: {text, reference_id, format} */
async function ttsFish(text, voice) {
    const url = (settings.apiUrl || PROVIDER_PRESETS.fish.url).trim();

    const body = {
        text: text,
        reference_id: voice,
        format: settings.responseFormat || 'mp3',
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.apiKey.trim(),
            'model': settings.model || 'speech-1.1',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res));
    return responseToAudioUrl(res);
}

function playBrowser(text) {
    if (!('speechSynthesis' in window)) {
        throw new Error('当前浏览器不支持 speechSynthesis');
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    utter.rate = Number(settings.speed) || 1.0;

    const voices = window.speechSynthesis.getVoices();
    const zh = voices.find(v => /zh[-_]CN|Chinese|中文|普通话/i.test(v.lang + ' ' + v.name));
    if (zh) utter.voice = zh;

    currentUtter = utter;
    utter.onend = () => stopPlayback();
    utter.onerror = () => stopPlayback();
    window.speechSynthesis.speak(utter);
}

function notify(kind, msg) {
    try {
        if (window.toastr && typeof window.toastr[kind] === 'function') {
            window.toastr[kind](msg);
        } else {
            console.log(TAG, msg);
        }
    } catch (e) {
        console.log(TAG, msg);
    }
}

/* ------------------------------------------------------------------ */
/* HTML 工具                                                          */
/* ------------------------------------------------------------------ */

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function stripTags(s) {
    return String(s)
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function buildBtnHtml(charName, line) {
    return `<button type="button" class="sttts-btn" title="朗读：${escapeAttr(charName)}" `
        + `data-char="${escapeAttr(charName)}" data-text="${escapeAttr(line)}">▶</button>`;
}

/* ------------------------------------------------------------------ */
/* 注入（HTML 级，幂等）                                               */
/* ------------------------------------------------------------------ */

function textRootOf(el) {
    if (!el) return null;
    if (el.classList && el.classList.contains('mes_text')) return el;
    const inner = el.querySelector ? el.querySelector('.mes_text') : null;
    return inner || el;
}

function decorateMessage(el) {
    if (!settings.enabled || !el) return 0;

    const root = textRootOf(el);
    if (!root || !root.innerHTML) return 0;

    // 已有按钮就跳过（被外部重写后按钮消失，这里会自动补）
    if (root.querySelector('.sttts-btn')) return 0;

    const html = root.innerHTML;
    if (html.length > 400000) return 0; // 超长文本保护

    const plain = stripTags(html);
    if (!plain.trim() || !DIALOGUE_TEST.test(plain)) return 0;

    const re = new RegExp(LINE_HTML_SOURCE, 'g');
    let count = 0;

    const out = html.replace(re, (m, c1, c2, inner) => {
        const charName = (c1 || c2 || '').trim();
        const line = stripTags(inner).trim();
        if (!charName || !line) return m;
        count++;
        return m + buildBtnHtml(charName, line);
    });

    if (!count) return 0;

    root.innerHTML = out;
    bindButtons(root);
    return count;
}

/** 给 root 下所有未绑定的按钮挂事件 */
function bindButtons(root) {
    root.querySelectorAll('.sttts-btn').forEach(btn => {
        if (btn.dataset.stttsBound === '1') return;
        btn.dataset.stttsBound = '1';
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            playText(btn);
        });
    });
}

/** 消息元素列表：优先 #chat .mes，退到全页 .mes_text，再退到全页 .mes */
function getMessageEls() {
    const chat = document.getElementById('chat');
    if (chat) {
        const mes = chat.querySelectorAll('.mes');
        if (mes.length) return Array.from(mes);
    }
    const texts = document.querySelectorAll('.mes_text');
    if (texts.length) return Array.from(texts);
    return Array.from(document.querySelectorAll('.mes'));
}

function scanAll() {
    if (!settings.enabled) return;
    const els = getMessageEls();
    let inserted = 0;
    for (const el of els) {
        try {
            inserted += decorateMessage(el);
        } catch (e) {
            console.warn(TAG, '扫描单条消息失败', e);
        }
    }
    lastStats = {
        messages: els.length,
        inserted,
        buttons: document.querySelectorAll('.sttts-btn').length,
    };
    updateStatusLine();
    if (inserted > 0) {
        console.log(TAG, `扫描 ${els.length} 条消息，插入 ${inserted} 个按钮`);
    }
}

let rescanTimer = null;
function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(scanAll, 300);
}

/** 盯住聊天区变动 */
function installObserver() {
    const chat = document.getElementById('chat');
    if (!chat) {
        setTimeout(installObserver, 800);
        return;
    }
    const obs = new MutationObserver(scheduleRescan);
    obs.observe(chat, { childList: true, subtree: true, characterData: true });
    console.log(TAG, 'MutationObserver 已装上');
    scanAll();
}

function clearAll() {
    stopPlayback();
    document.querySelectorAll('.sttts-btn').forEach(b => b.remove());
}

/* ------------------------------------------------------------------ */
/* 诊断                                                               */
/* ------------------------------------------------------------------ */

function runDiagnostics() {
    const chat = document.getElementById('chat');
    const mesAll = document.querySelectorAll('.mes');
    const mesTextAll = document.querySelectorAll('.mes_text');

    const re = new RegExp(
        '(?:【[^】\\n]{1,16}】|[\\u4e00-\\u9fa5A-Za-z·]{1,8}[：:])\\s*(?:<[^>]+>\\s*)*[「“][^」”\\n]{1,600}[」”]'
    );
    let hitBlocks = 0;
    let firstMatch = '';
    document.querySelectorAll('.mes_text, .mes').forEach(el => {
        const t = (el.textContent || '').trim();
        if (!t) return;
        const m = t.match(re);
        if (m) {
            hitBlocks++;
            if (!firstMatch) firstMatch = m[0].replace(/\s+/g, ' ').slice(0, 60);
        }
    });

    const firstTextEl = document.querySelector('.mes_text');
    const firstText = firstTextEl
        ? (firstTextEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100)
        : '（页面上没有 .mes_text 元素）';

    const lines = [
        '【st-auto-tts 诊断】',
        '',
        '#chat 容器: ' + (chat ? '存在' : '不存在'),
        '.mes 消息数: ' + mesAll.length,
        '.mes_text 正文数: ' + mesTextAll.length,
        '含台词的消息块: ' + hitBlocks,
        '已插入按钮: ' + document.querySelectorAll('.sttts-btn').length,
        '',
        '第一条匹配: ' + (firstMatch || '（没匹配到）'),
        '',
        '第一条消息正文开头:',
        firstText,
        '',
        '扩展版本: v1.4（含本地 GPT-SoVITS）',
    ];
    alert(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* 设置界面                                                           */
/* ------------------------------------------------------------------ */

function updateStatusLine() {
    const el = document.getElementById('sttts_status');
    if (!el || !lastStats) return;
    el.textContent = `上次扫描：${lastStats.messages} 条消息，本次插入 ${lastStats.inserted} 个按钮，当前共 ${lastStats.buttons} 个。`;
}

function buildSettingsUI() {
    const holder =
        document.getElementById('extensions_settings') ||
        document.getElementById('extensions_settings2');
    if (!holder) return false;
    if (document.getElementById('sttts_settings_root')) return true;

    const wrap = document.createElement('div');
    wrap.id = 'sttts_settings_root';
    wrap.innerHTML = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>逐句朗读 (Auto TTS)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display:none;">
            <div id="sttts_status" style="font-size:0.85em;opacity:.7;margin-bottom:6px;">还没扫描过。</div>

            <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                <input type="checkbox" id="sttts_enabled">
                <span>启用（在每句台词后加朗读按钮）</span>
            </label>

            <label>服务商</label>
            <select id="sttts_provider" class="text_pole">
                <option value="openai">OpenAI 兼容接口</option>
                <option value="elevenlabs">ElevenLabs（英文克隆最像）</option>
                <option value="fish">Fish Audio（克隆便宜）</option>
                <option value="sovits">本地 GPT-SoVITS（免费·无审核）</option>
            </select>
            <div id="sttts_provider_hint" style="font-size:0.8em;opacity:.65;margin-top:3px;"></div>

            <label>接口地址（留空则用浏览器语音）</label>
            <input type="text" id="sttts_apiurl" class="text_pole"
                   placeholder="https://api.openai.com/v1/audio/speech">

            <label>API Key</label>
            <input type="password" id="sttts_apikey" class="text_pole" placeholder="sk-...">

            <div style="display:flex;gap:8px;">
                <div style="flex:1;">
                    <label>模型</label>
                    <input type="text" id="sttts_model" class="text_pole" placeholder="tts-1">
                </div>
                <div style="flex:1;">
                    <label>格式</label>
                    <input type="text" id="sttts_format" class="text_pole" placeholder="mp3">
                </div>
            </div>

            <label>角色 → 音色（每行一条，格式：角色=音色ID）</label>
            <textarea id="sttts_voicemap" class="text_pole" rows="4"
                      placeholder="罗根=alloy&#10;伊芙=shimmer"></textarea>

            <label>兜底音色（表里没有的角色用这个）</label>
            <input type="text" id="sttts_defaultvoice" class="text_pole" placeholder="alloy">

            <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;margin-top:8px;">
                <input type="checkbox" id="sttts_browser">
                <span>没填接口时用浏览器自带语音（仅用于验证按钮是否正常）</span>
            </label>

            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                <button id="sttts_refresh" class="menu_button">重新扫描</button>
                <button id="sttts_diag" class="menu_button">诊断</button>
                <button id="sttts_stop" class="menu_button">停止播放</button>
            </div>
        </div>
    </div>`;

    holder.appendChild(wrap);

    const toggle = wrap.querySelector('.inline-drawer-toggle');
    const content = wrap.querySelector('.inline-drawer-content');
    const icon = wrap.querySelector('.inline-drawer-icon');
    if (toggle && content) {
        toggle.addEventListener('click', () => {
            const open = content.style.display !== 'none';
            content.style.display = open ? 'none' : 'block';
            if (icon) {
                icon.classList.toggle('down', open);
                icon.classList.toggle('up', !open);
            }
        });
    }

    const $id = (s) => document.getElementById(s);

    const bind = (id, key, type) => {
        const el = $id(id);
        if (!el) return;
        if (type === 'checkbox') {
            el.checked = !!settings[key];
            el.addEventListener('change', () => {
                settings[key] = el.checked;
                persist();
                if (key === 'enabled') {
                    if (settings.enabled) scanAll();
                    else clearAll();
                }
            });
        } else {
            el.value = settings[key] ?? '';
            el.addEventListener('input', () => {
                settings[key] = el.value;
                persist();
            });
        }
    };

    bind('sttts_enabled', 'enabled', 'checkbox');
    bind('sttts_browser', 'browserFallback', 'checkbox');
    bind('sttts_apiurl', 'apiUrl', 'text');
    bind('sttts_apikey', 'apiKey', 'text');
    bind('sttts_model', 'model', 'text');
    bind('sttts_format', 'responseFormat', 'text');
    bind('sttts_voicemap', 'voiceMap', 'text');
    bind('sttts_defaultvoice', 'defaultVoice', 'text');

    // 服务商切换：更新提示与占位符，不覆盖已填内容
    const providerSel = $id('sttts_provider');
    const hintEl = $id('sttts_provider_hint');
    const urlEl = $id('sttts_apiurl');
    const modelEl = $id('sttts_model');

    const refreshProviderHint = () => {
        const p = PROVIDER_PRESETS[settings.provider] || PROVIDER_PRESETS.openai;
        if (hintEl) hintEl.textContent = p.hint;
        if (urlEl) urlEl.placeholder = p.url;
        if (modelEl) modelEl.placeholder = p.model;
    };

    if (providerSel) {
        providerSel.value = settings.provider || 'openai';
        providerSel.addEventListener('change', () => {
            settings.provider = providerSel.value;
            persist();
            refreshProviderHint();
        });
    }
    refreshProviderHint();

    $id('sttts_refresh')?.addEventListener('click', () => {
        clearAll();
        scanAll();
        notify('success', '已重新扫描');
    });
    $id('sttts_diag')?.addEventListener('click', runDiagnostics);
    $id('sttts_stop')?.addEventListener('click', stopPlayback);

    updateStatusLine();
    console.log(TAG, '设置面板已创建');
    return true;
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

function bindEvents() {
    try {
        if (event_types && event_types.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleRescan);
        }
        if (event_types && event_types.USER_MESSAGE_RENDERED) {
            eventSource.on(event_types.USER_MESSAGE_RENDERED, scheduleRescan);
        }
        if (event_types && event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, scheduleRescan);
        }
        if (event_types && event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, () => {
                stopPlayback();
                setTimeout(scanAll, 600);
            });
        }
        if (event_types && event_types.APP_READY) {
            eventSource.on(event_types.APP_READY, () => setTimeout(scanAll, 500));
        }
    } catch (e) {
        console.warn(TAG, '事件绑定失败（不影响手动扫描）', e);
    }
}

jQuery(async () => {
    loadSettings();

    let tries = 0;
    const tryBuild = () => {
        if (buildSettingsUI()) return;
        if (++tries < 40) setTimeout(tryBuild, 500);
    };
    tryBuild();

    bindEvents();
    installObserver();

    setTimeout(scanAll, 2000);
    setTimeout(scanAll, 6000);

    console.log(TAG, 'loaded v1.4');
});
