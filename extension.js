// ==UserScript==
// @name         TypingMind 對話分析器
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  分析 TypingMind 對話中不同模型的回應，並提供可移動、可縮放的懸浮視窗介面。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const SCRIPT_VERSION = '2.6';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o-mini';
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 1;
    let db;

    // --- DATABASE HELPERS ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                if (!dbInstance.objectStoreNames.contains(REPORT_STORE_NAME)) {
                    dbInstance.createObjectStore(REPORT_STORE_NAME, { keyPath: 'chatId' });
                }
            };
            request.onerror = (event) => reject(`資料庫錯誤: ${event.target.errorCode}`);
            request.onsuccess = (event) => {
                db = event.target.result;
                resolve(db);
            };
        });
    }

    function saveReport(chatId, reportData) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction([REPORT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const request = store.put({ chatId, report: reportData, timestamp: new Date() });
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(`儲存報告失敗: ${event.target.error}`);
        });
    }

    function getReport(chatId) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction([REPORT_STORE_NAME], 'readonly');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const request = store.get(chatId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(`讀取報告失敗: ${event.target.error}`);
        });
    }

    // --- UI CREATION ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;
        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        container.style.cssText = `position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;
        const mainButton = document.createElement('button');
        mainButton.id = 'analyzer-main-button';
        mainButton.style.cssText = `background-color: #4A90E2; color: white; border: none; border-radius: 8px; padding: 10px 15px; font-size: 14px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: all 0.3s;`;
        const reanalyzeButton = document.createElement('button');
        reanalyzeButton.id = 'analyzer-reanalyze-button';
        reanalyzeButton.innerHTML = '🔄';
        reanalyzeButton.title = '重新分析';
        reanalyzeButton.style.cssText = `background-color: #6c757d; color: white; border: none; border-radius: 50%; width: 38px; height: 38px; font-size: 18px; cursor: pointer; display: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1);`;
        reanalyzeButton.onclick = () => handleAnalysisRequest(true);
        const settingsButton = document.createElement('button');
        settingsButton.innerHTML = '⚙️';
        settingsButton.title = '設定分析模型';
        settingsButton.style.cssText = `background-color: #f0f0f0; color: #333; border: 1px solid #ccc; border-radius: 50%; width: 38px; height: 38px; font-size: 20px; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.1);`;
        settingsButton.onclick = showSettingsWindow;
        container.appendChild(reanalyzeButton);
        container.appendChild(mainButton);
        container.appendChild(settingsButton);
        document.body.appendChild(container);
        updateUIState();
    }

    async function updateUIState() {
        const mainButton = document.getElementById('analyzer-main-button');
        if (!mainButton) return;
        const reanalyzeButton = document.getElementById('analyzer-reanalyze-button');
        const chatId = getChatIdFromUrl();
        if (!chatId) {
            mainButton.style.display = 'none';
            reanalyzeButton.style.display = 'none';
            return;
        }
        mainButton.style.display = 'inline-block';
        const existingReport = await getReport(chatId);
        if (existingReport) {
            mainButton.innerHTML = '📄 查看報告';
            mainButton.onclick = () => showReportWindow(existingReport.report);
            reanalyzeButton.style.display = 'inline-block';
        } else {
            mainButton.innerHTML = '🤖 分析對話';
            mainButton.onclick = () => handleAnalysisRequest(false);
            reanalyzeButton.style.display = 'none';
        }
    }

    // --- CORE LOGIC ---
    async function handleAnalysisRequest(isReanalysis = false) {
        const chatId = getChatIdFromUrl();
        if (!chatId) return;
        if (!isReanalysis) {
            const existingReport = await getReport(chatId);
            if (existingReport) {
                showReportWindow(existingReport.report);
                return;
            }
        }
        try {
            let apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
            if (!apiKey) {
                apiKey = window.prompt('請輸入您的 OpenAI API 金鑰：');
                if (!apiKey) return;
                localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
            }
            const messages = await getTypingMindChatHistory();
            if (messages.length < 2) {
                alert('當前對話訊息不足，無法進行分析。');
                return;
            }
            const analysisText = await analyzeConversation(apiKey, messages);
            await saveReport(chatId, analysisText);
            showReportWindow(analysisText);
            updateUIState();
        } catch (error) {
            console.error('分析擴充程式錯誤:', error);
            alert(`發生錯誤: ${error.message}`);
        }
    }

    // --- DATA RETRIEVAL (TypingMind's DB) ---
    function getTypingMindChatHistory() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('keyval-store');
            request.onerror = () => reject(new Error('無法開啟 TypingMind 資料庫。'));
            request.onsuccess = (event) => {
                const tmDb = event.target.result;
                const chatId = getChatIdFromUrl();
                if (!chatId) return reject(new Error('無法確定當前對話 ID。'));
                const currentChatKey = `CHAT_${chatId}`;
                const transaction = tmDb.transaction(['keyval'], 'readonly');
                const objectStore = transaction.objectStore('keyval');
                const getRequest = objectStore.get(currentChatKey);
                getRequest.onerror = () => reject(new Error('讀取聊天資料出錯。'));
                getRequest.onsuccess = () => {
                    const chatData = getRequest.result;
                    if (!chatData || !chatData.messages) return reject(new Error(`找不到對應的聊天資料。`));
                    const allMessages = [];
                    for (const turn of chatData.messages) {
                        if (turn.role === 'user') allMessages.push(turn);
                        else if (turn.type === 'tm_multi_responses' && turn.responses) {
                            for (const response of turn.responses) {
                                if (response.messages && response.model) {
                                    const messagesWithModel = response.messages.map(msg => ({ ...msg, model: response.model }));
                                    allMessages.push(...messagesWithModel);
                                }
                            }
                        } else if (turn.role === 'assistant') allMessages.push(turn);
                    }
                    resolve(allMessages);
                };
            };
        });
    }

    // --- LLM INTERACTION ---
    async function analyzeConversation(apiKey, messages) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const stringifyContent = (content) => {
            if (content === null || content === undefined) return '';
            if (typeof content === 'string') return content;
            return JSON.stringify(content, null, 2);
        };
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const lastUserQuestion = lastUserMsg ? stringifyContent(lastUserMsg.content) : 'No user question found.';
        const transcript = messages.map(msg => `**${(msg.role ?? 'system_note').toUpperCase()} (Model: ${msg.model || 'N/A'})**: ${stringifyContent(msg.content)}`).join('\n\n---\n\n');
        const systemPrompt = `你是一位專業、公正且嚴謹的 AI 模型評估員... (Your detailed system prompt here)`;
        const userContentForAnalyzer = `--- 原始問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}`;
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }],
            })
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
        }
        const data = await response.json();
        return data.choices[0].message.content;
    }

    // --- UI (FLOATING WINDOW) - [COMPLETELY REWRITTEN SECTION V2.6] ---
    
    function createFloatingWindow(title, contentNode) {
        hideWindow(); // Close any existing window first

        const windowEl = document.createElement('div');
        windowEl.id = 'analyzer-window';
        windowEl.style.cssText = `
            position: fixed;
            top: 50px;
            left: 50px;
            width: 500px;
            height: 600px;
            z-index: 10001;
            background-color: #fff;
            border: 1px solid #ccc;
            border-radius: 12px;
            box-shadow: 0 8px 25px rgba(0,0,0,0.2);
            display: flex;
            flex-direction: column;
            overflow: hidden; /* Important for resize */
        `;

        // --- Header / Drag Handle ---
        const header = document.createElement('div');
        header.style.cssText = `
            background-color: #f0f0f0;
            padding: 8px 12px;
            cursor: move;
            border-bottom: 1px solid #ccc;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
        `;
        const titleEl = document.createElement('span');
        titleEl.textContent = title;
        titleEl.style.fontWeight = 'bold';

        const closeButton = document.createElement('button');
        closeButton.innerHTML = '&times;';
        closeButton.style.cssText = `background: none; border: none; font-size: 20px; cursor: pointer;`;
        closeButton.onclick = hideWindow;

        header.appendChild(titleEl);
        header.appendChild(closeButton);

        // --- Content Area ---
        const contentArea = document.createElement('div');
        contentArea.style.cssText = `padding: 15px; flex-grow: 1; overflow-y: auto;`;
        contentArea.appendChild(contentNode);

        // --- Resize Handle ---
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = `
            position: absolute;
            bottom: 0;
            right: 0;
            width: 15px;
            height: 15px;
            cursor: se-resize;
            background: linear-gradient(135deg, transparent 50%, #aaa 50%);
        `;

        windowEl.appendChild(header);
        windowEl.appendChild(contentArea);
        windowEl.appendChild(resizeHandle);
        document.body.appendChild(windowEl);

        // --- Drag and Resize Logic ---
        makeDraggable(windowEl, header);
        makeResizable(windowEl, resizeHandle);
    }

    function hideWindow() {
        const windowEl = document.getElementById('analyzer-window');
        if (windowEl) windowEl.remove();
    }

    function showReportWindow(reportText) {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = formatMarkdownToHtml(reportText);
        createFloatingWindow('分析報告', contentNode);
    }

    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = `
            <div style="margin-top: 10px;">
                <label for="model-input" style="display: block; margin-bottom: 8px;">分析模型名稱:</label>
                <input type="text" id="model-input" value="${localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">
            </div>
            <div style="text-align: right; margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px;">
                <span style="font-size: 12px; color: #999; float: left; line-height: 38px;">Version: ${SCRIPT_VERSION}</span>
                <button id="analyzer-settings-save" style="padding: 8px 16px; border-radius: 6px; border: none; background-color: #28a745; color: white; cursor: pointer;">儲存</button>
            </div>
        `;
        // We need to attach the listener after the element is created
        const saveHandler = () => {
            const newModel = contentNode.querySelector('#model-input').value;
            if (newModel) {
                localStorage.setItem(MODEL_STORAGE_KEY, newModel);
                hideWindow();
                alert(`模型已更新為: ${newModel}`);
            } else alert('模型名稱不可為空！');
        };
        contentNode.querySelector('#analyzer-settings-save').onclick = saveHandler;
        createFloatingWindow('設定', contentNode);
    }

    function makeDraggable(element, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        handle.onmousedown = dragMouseDown;
        function dragMouseDown(e) {
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }
        function elementDrag(e) {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + "px";
            element.style.left = (element.offsetLeft - pos1) + "px";
        }
        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    function makeResizable(element, handle) {
        handle.onmousedown = function(e) {
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = parseInt(document.defaultView.getComputedStyle(element).width, 10);
            const startHeight = parseInt(document.defaultView.getComputedStyle(element).height, 10);
            document.onmousemove = function(e) {
                element.style.width = (startWidth + e.clientX - startX) + 'px';
                element.style.height = (startHeight + e.clientY - startY) + 'px';
            };
            document.onmouseup = function() {
                document.onmousemove = null;
                document.onmouseup = null;
            };
        };
    }

    function formatMarkdownToHtml(markdownText) {
        if (!markdownText) return '無分析內容。';
        let html = markdownText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>').replace(/^## (.*$)/gim, '<h2>$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/^\s*[-*] (.*$)/gim, '<li>$1</li>');
        html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>');
        html = html.replace(/(<li>.*?<\/li>)/g, '<ul>$1</ul>').replace(/<\/ul>\s*<ul>/g, '');
        return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;
    }
    
    function getChatIdFromUrl() {
        const hash = window.location.hash;
        return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null;
    }

    // --- INITIALIZATION ---
    async function initialize() {
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();
        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                createUI();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('hashchange', updateUIState, false);
    }

    initialize();

})();
