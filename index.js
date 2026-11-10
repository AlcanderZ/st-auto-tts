/**
 * 逐句朗读 (Auto TTS) — 第三方扩展 v1.1
 *
 * v1.1 改动：
 *  - 消息容器自动探测：优先 #chat .mes，找不到就退到全页 .mes_text，再不行扫全页
 *  - MutationObserver：任何聊天区变动（新消息 / 重渲染 / 切聊天）都会自动重扫
 *  - 幂等注入：有按钮就跳过，被重写了就补回来，不会重复加
 *  - 设置面板新增「诊断」按钮：点一下弹窗告诉你扫描到了什么
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'st_auto_tts';
const TAG = '[st-auto-tts]';

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

// 用于"有没有台词"的快速检测（不带 g 标志，避免 lastIndex 陷阱）
const DIALOGUE_TEST = new RegExp(DIALOGUE_SOURCE);

/* ------------------------------------------------------------------ */
/* 状态                                                               */
/* ------------------------------------------------------------------ */

let settings = { ...DEFAULT_SETTINGS };
let currentAudio = null;
let currentBtn = null;
let currentUtter = null;
let lastStats = null;

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
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
/* 音色解析                                                            */
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

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
        throw new Error(`HTTP ${res.status} ${detail}`);
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    let audioUrl;
    if (type.includes('application/json')) {
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
            console.log(TAG, msg);
        }
    } catch (e) {
        console.log(TAG, msg);
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

/** 把一个文本节点里的台词切开、行尾塞按钮。返回插入数量。 */
function splitTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return 0;

    const re = new RegExp(DIALOGUE_SOURCE, 'g');
    let match;
    let last = 0;
    let frag = null;
    let count = 0;

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
        count++;
    }

    if (!frag) return 0;
    if (last < raw.length) {
        frag.appendChild(document.createTextNode(raw.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
    return count;
}

/** 找出该消息元素里应该扫的正文的根节点 */
function textRootOf(el) {
    if (!el) return null;
    if (el.classList && el.classList.contains('mes_text')) return el;
    const inner = el.querySelector ? el.querySelector('.mes_text') : null;
    return inner || el;
}

/**
 * 幂等注入：有按钮就跳过；没按钮但有台词就注入。
 * 目标元素可以是 .mes（整条消息）或 .mes_text 本身。
 */
function decorateMessage(el) {
    if (!settings.enabled || !el) return 0;

    const root = textRootOf(el);
    if (!root) return 0;

    // 已有按钮就不动（被外部重写后按钮会消失，这里会自动补）
    if (root.querySelector('.sttts-btn')) return 0;

    // 快速预检：整块文本里到底有没有台词
    const whole = root.textContent || '';
    if (!whole.trim() || !DIALOGUE_TEST.test(whole)) return 0;

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

    let total = 0;
    for (const n of nodes) {
        try {
            total += splitTextNode(n);
        } catch (e) {
            console.warn(TAG, '跳过节点', e);
        }
    }
    return total;
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

/** 盯住整个文档的聊天区变动 */
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

    const re = new RegExp(DIALOGUE_SOURCE);
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
        : '（页面上根本没有 .mes_text 元素）';

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
        '扩展已加载: 是',
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

    // 面板可能比扩展加载得晚，轮询直到塞进去为止
    let tries = 0;
    const tryBuild = () => {
        if (buildSettingsUI()) return;
        if (++tries < 40) setTimeout(tryBuild, 500);
    };
    tryBuild();

    bindEvents();

    // 聊天容器晚于扩展出现时，installObserver 自己会等
    installObserver();

    // 双保险：几秒后再扫一次（防止事件都没触发的情况）
    setTimeout(scanAll, 2000);
    setTimeout(scanAll, 6000);

    console.log(TAG, 'loaded');
});
