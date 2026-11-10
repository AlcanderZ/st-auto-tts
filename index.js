/**
 * 逐句朗读 (Auto TTS) — 第三方扩展
 *
 * 作用：在每条 AI 回复里，找出 `【角色】「台词」` 或 `角色：「台词」` 形式的对话行，
 *      在行尾插入一个小喇叭按钮。点一下，用「该角色对应的音色」只念这一句。
 *
 * 两种后端：
 *   1) 远程 TTS（推荐）：任意 OpenAI 兼容的 /audio/speech 接口
 *      填 API 地址 + Key + 音色映射即可（OpenAI、Fish Audio、GPT-SoVITS 网关、中转站都行）
 *   2) 本地 fallback：浏览器自带 speechSynthesis，未填 API 时用它出声，先验证交互
 *
 * 不改动消息内容、不往上下文塞任何标签，纯前端装饰。
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'st_auto_tts';

const DEFAULT_SETTINGS = {
    enabled: true,
    apiUrl: '',
    apiKey: '',
    model: 'tts-1',
    responseFormat: 'mp3',
    defaultVoice: 'alloy',
    voiceMap: '罗根=alloy\n伊芙=shimmer',
    speed: 1.0,
    browserFallback: true,
};

/* ------------------------------------------------------------------ */
/* 台词识别                                                            */
/* ------------------------------------------------------------------ */

// 组1：【角色】   组2：角色：   组3：台词
const DIALOGUE_SOURCE =
    '(?:【([^】\\n]{1,16})】|([\\u4e00-\\u9fa5A-Za-z·]{1,8})[：:])\\s*[「“]([^」”\\n]{1,600})[」”]';

/* ------------------------------------------------------------------ */
/* 状态                                                               */
/* ------------------------------------------------------------------ */

let settings = { ...DEFAULT_SETTINGS };
let currentAudio = null;
let currentBtn = null;
let currentUtter = null;

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    // 回写一份，保证新字段落盘
    Object.assign(extension_settings[MODULE_NAME], settings);
}

function persist() {
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* 音色解析                                                            */
/* ------------------------------------------------------------------ */

function resolveVoice(charName) {
    const map = String(settings.voiceMap || '');
    const lines = map.split(/\r?\n/);
    for (const line of lines) {
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

function markPlaying(btn) {
    stopPlayback();
    btn.classList.add('sttts-playing');
    currentBtn = btn;
}

async function playText(btn) {
    if (currentBtn === btn) {
        stopPlayback();
        return;
    }

    const charName = btn.dataset.char || '';
    const text = btn.dataset.text || '';
    if (!text) return;

    markPlaying(btn);

    const voice = resolveVoice(charName);

    try {
        if (settings.apiUrl) {
            await playRemote(text, voice);
        } else if (settings.browserFallback) {
            playBrowser(text);
        } else {
            stopPlayback();
            notify('warn', '还没填 TTS 接口地址，也没开浏览器兜底');
        }
    } catch (err) {
        console.error('[st-auto-tts]', err);
        stopPlayback();
        notify('error', '朗读失败：' + (err && err.message ? err.message : err));
    }
}

async function playRemote(text, voice) {
    const url = settings.apiUrl.trim();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey.trim()) {
        headers['Authorization'] = 'Bearer ' + settings.apiKey.trim();
    }

    const body = {
        model: settings.model || 'tts-1',
        input: text,
        voice: voice,
        response_format: settings.responseFormat || 'mp3',
        speed: Number(settings.speed) || 1.0,
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
        throw new Error(`HTTP ${res.status} ${detail}`);
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();

    let audioUrl;
    if (type.includes('application/json')) {
        // 有些网关返回 { audio: "<base64>" } 或 { url: "..." }
        const data = await res.json();
        if (data && typeof data.audio === 'string') {
            audioUrl = 'data:audio/mpeg;base64,' + data.audio;
        } else if (data && typeof data.url === 'string') {
            audioUrl = data.url;
        } else if (data && data.data && typeof data.data.audio === 'string') {
            audioUrl = 'data:audio/mpeg;base64,' + data.data.audio;
        } else {
            throw new Error('返回了 JSON，但没找到 audio 字段');
        }
    } else {
        const blob = await res.blob();
        audioUrl = URL.createObjectURL(blob);
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
            console.log('[st-auto-tts]', msg);
        }
    } catch (e) {
        console.log('[st-auto-tts]', msg);
    }
}

/* ------------------------------------------------------------------ */
/* DOM 注入                                                           */
/* ------------------------------------------------------------------ */

function makeButton(charName, line) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sttts-btn';
    btn.title = '朗读：' + charName;
    btn.textContent = '▶';
    btn.dataset.char = charName;
    btn.dataset.text = line;
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        playText(btn);
    });
    return btn;
}

/**
 * 把一个文本节点里的台词切开，行尾塞按钮。
 * 返回是否发生了改动。
 */
function splitTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return false;

    const re = new RegExp(DIALOGUE_SOURCE, 'g');
    let match;
    let last = 0;
    let frag = null;

    while ((match = re.exec(raw)) !== null) {
        const charName = (match[1] || match[2] || '').trim();
        const line = (match[3] || '').trim();
        if (!charName || !line) continue;

        const end = match.index + match[0].length;
        if (!frag) frag = document.createDocumentFragment();

        if (match.index > last) {
            frag.appendChild(document.createTextNode(raw.slice(last, match.index)));
        }
        frag.appendChild(document.createTextNode(match[0]));
        frag.appendChild(makeButton(charName, line));
        last = end;
    }

    if (!frag) return false;
    if (last < raw.length) {
        frag.appendChild(document.createTextNode(raw.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
    return true;
}

function decorateMessage(mesEl) {
    if (!settings.enabled) return;
    if (!mesEl || mesEl.dataset.stttsDone === '1') return;

    const root = mesEl.querySelector('.mes_text');
    if (!root) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const p = n.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('button, script, style, code, pre, .sttts-btn')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    let touched = false;
    for (const n of nodes) {
        try {
            if (splitTextNode(n)) touched = true;
        } catch (e) {
            console.warn('[st-auto-tts] 跳过节点', e);
        }
    }

    if (touched) mesEl.dataset.stttsDone = '1';
}

function decorateById(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (el) decorateMessage(el);
}

function decorateAll() {
    if (!settings.enabled) return;
    document.querySelectorAll('#chat .mes').forEach(decorateMessage);
}

function clearAll() {
    stopPlayback();
    document.querySelectorAll('.sttts-btn').forEach(b => b.remove());
    document.querySelectorAll('#chat .mes[data-sttts-done="1"]').forEach(el => {
        delete el.dataset.stttsDone;
    });
}

/* ------------------------------------------------------------------ */
/* 设置界面                                                           */
/* ------------------------------------------------------------------ */

function buildSettingsUI() {
    const html = `
    <div class="sttts-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>逐句朗读 (Auto TTS)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display:none;">
                <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                    <input type="checkbox" id="sttts_enabled">
                    <span>启用（在每句台词后加朗读按钮）</span>
                </label>

                <label>TTS 接口地址（OpenAI 兼容 /audio/speech，留空则用浏览器念）</label>
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

                <div style="display:flex;gap:8px;margin-top:10px;">
                    <button id="sttts_refresh" class="menu_button">重新扫描本页</button>
                    <button id="sttts_stop" class="menu_button">停止播放</button>
                </div>
            </div>
        </div>
    </div>`;

    const holder = document.getElementById('extensions_settings');
    if (!holder) return;
    if (document.getElementById('sttts_settings_root')) return;

    const wrap = document.createElement('div');
    wrap.id = 'sttts_settings_root';
    wrap.innerHTML = html;
    holder.appendChild(wrap);

    // 折叠交互
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

    const $ = (id) => document.getElementById(id);

    const bind = (id, key, type) => {
        const el = $(id);
        if (!el) return;
        if (type === 'checkbox') {
            el.checked = !!settings[key];
            el.addEventListener('change', () => {
                settings[key] = el.checked;
                persist();
                if (key === 'enabled') {
                    if (settings.enabled) decorateAll();
                    else clearAll();
                }
            });
        } else {
            el.value = settings[key] ?? '';
            el.addEventListener('input', () => {
                settings[key] = type === 'number' ? Number(el.value) : el.value;
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

    $('sttts_refresh')?.addEventListener('click', () => {
        clearAll();
        decorateAll();
        notify('success', '已重新扫描');
    });
    $('sttts_stop')?.addEventListener('click', stopPlayback);
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

jQuery(async () => {
    loadSettings();

    eventSource.on(event_types.APP_READY, () => {
        buildSettingsUI();
        setTimeout(decorateAll, 500);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => decorateById(id));
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => decorateById(id));
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => {
        const el = document.querySelector(`#chat .mes[mesid="${id}"]`);
        if (el) delete el.dataset.stttsDone;
        decorateById(id);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        stopPlayback();
        setTimeout(decorateAll, 600);
    });

    // 兜底：APP_READY 万一没触发
    setTimeout(() => {
        buildSettingsUI();
        decorateAll();
    }, 2000);

    console.log('[st-auto-tts] loaded');
});
