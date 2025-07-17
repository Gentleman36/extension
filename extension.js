// ==UserScript==
// @name         TypingMind 對話分析器
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  分析、整合並驗證 TypingMind 對話中的多模型回應，並提供可自訂參數的懸浮視窗介面。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const SCRIPT_VERSION = '2.8';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';
    const TEMP_STORAGE_KEY = 'typingmind_analyzer_temperature';
    const TOPP_STORAGE_KEY = 'typingmind_analyzer_top_p';
    const REASONING_EFFORT_STORAGE_KEY = 'typingmind_analyzer_reasoning_effort'; // New key for v2.8

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
        reanalyzeButton.title = '重新分析與整合';
        reanalyzeButton.style.cssText = `background-color: #6c757d; color: white; border: none; border-radius: 50%; width: 38px; height: 38px; font-size: 18px; cursor: pointer; display: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1);`;
        reanalyzeButton.onclick = () => handleAnalysisRequest(true);
        const settingsButton = document.createElement('button');
        settingsButton.innerHTML = '⚙️';
        settingsButton.title = '設定';
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
            mainButton.innerHTML = '📄 查看總結報告';
            mainButton.onclick = () => showReportWindow(existingReport.report);
            reanalyzeButton.style.display = 'inline-block';
        } else {
            mainButton.innerHTML = '🤖 整合分析對話';
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

    // --- DATA RETRIEVAL ---
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
                                    allMessages.push(...response.messages.map(msg => ({ ...msg, model: response.model })));
                                }
                            }
                        } else if (turn.role === 'assistant') allMessages.push(turn);
                    }
                    resolve(allMessages);
                };
            };
        });
    }

    // --- LLM INTERACTION - [MODIFIED SECTION V2.8] ---
    async function analyzeConversation(apiKey, messages) {
        // Retrieve all settings from storage
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
        const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
        const reasoningEffort = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY); // Retrieve as string

        const stringifyContent = (content) => {
            if (content === null || content === undefined) return '';
            if (typeof content === 'string') return content;
            return JSON.stringify(content, null, 2);
        };
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const lastUserQuestion = lastUserMsg ? stringifyContent(lastUserMsg.content) : 'No user question found.';
        const transcript = messages.map(msg => `**${(msg.role ?? 'system_note').toUpperCase()} (Model: ${msg.model || 'N/A'})**: ${stringifyContent(msg.content)}`).join('\n\n---\n\n');
        const systemPrompt = `你是一位頂尖的專家級研究員與事實查核員... (Your detailed system prompt here)`;
        const userContentForAnalyzer = `--- 原始問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}`;
        
        // Build the request body dynamically
        const requestBody = {
            model: model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }],
            temperature: temperature,
            top_p: top_p
        };

        // Add reasoning_effort only if it has a value
        if (reasoningEffort) {
            requestBody.reasoning_effort = reasoningEffort;
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
        }
        const data = await response.json();
        return data.choices[0].message.content;
    }

    // --- UI (FLOATING WINDOW) ---
    function createFloatingWindow(title, contentNode) {
        hideWindow();
        const windowEl = document.createElement('div');
        windowEl.id = 'analyzer-window';
        windowEl.style.cssText = `position: fixed; top: 50px; left: 50px; width: 500px; height: 600px; z-index: 10001; background-color: #fff; border: 1px solid #ccc; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;`;
        const header = document.createElement('div');
        header.style.cssText = `background-color: #f0f0f0; padding: 8px 12px; cursor: move; border-bottom: 1px solid #ccc; display: flex; justify-content: space-between; align-items: center; user-select: none;`;
        const titleEl = document.createElement('span');
        titleEl.textContent = title;
        titleEl.style.fontWeight = 'bold';
        const closeButton = document.createElement('button');
        closeButton.innerHTML = '&times;';
        closeButton.style.cssText = `background: none; border: none; font-size: 20px; cursor: pointer;`;
        closeButton.onclick = hideWindow;
        header.appendChild(titleEl);
        header.appendChild(closeButton);
        const contentArea = document.createElement('div');
        contentArea.style.cssText = `padding: 15px; flex-grow: 1; overflow-y: auto;`;
        contentArea.appendChild(contentNode);
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = `position: absolute; bottom: 0; right: 0; width: 15px; height: 15px; cursor: se-resize; background: linear-gradient(135deg, transparent 50%, #aaa 50%);`;
        windowEl.appendChild(header);
        windowEl.appendChild(contentArea);
        windowEl.appendChild(resizeHandle);
        document.body.appendChild(windowEl);
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
        createFloatingWindow('整合分析報告', contentNode);
    }
    
    // --- [MODIFIED SECTION V2.8] ---
    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        
        const currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const currentTemp = localStorage.getItem(TEMP_STORAGE_KEY) || '1.0';
        const currentTopP = localStorage.getItem(TOPP_STORAGE_KEY) || '1.0';
        const currentReasoning = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY) || 'High'; // Default to 'High' as requested

        contentNode.innerHTML = `
            <div>
                <label for="model-input" style="display: block; margin-bottom: 8px;">分析模型名稱:</label>
                <input type="text" id="model-input" value="${currentModel}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">
            </div>
            <div style="margin-top: 15px;">
                <label for="reasoning-input" style="display: block; margin-bottom: 8px;">Reasoning Effort:</label>
                <input type="text" id="reasoning-input" value="${currentReasoning}" placeholder="例如: High, Medium, Low, Auto" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">
            </div>
            <div style="display: flex; gap: 20px; margin-top: 15px;">
                <div style="flex: 1;">
                    <label for="temp-input" style="display: block; margin-bottom: 8px;">Temperature (0-2):</label>
                    <input type="number" id="temp-input" value="${currentTemp}" step="0.1" min="0" max="2" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">
                </div>
                <div style="flex: 1;">
                    <label for="topp-input" style="display: block; margin-bottom: 8px;">Top P (0-1):</label>
                    <input type="number" id="topp-input" value="${currentTopP}" step="0.1" min="0" max="1" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">
                </div>
            </div>
        `;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 15px;`;
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999; margin-right: auto;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        
        const saveHandler = () => {
            const newModel = contentNode.querySelector('#model-input').value;
            const newReasoning = contentNode.querySelector('#reasoning-input').value;
            const newTemp = contentNode.querySelector('#temp-input').value;
            const newTopP = contentNode.querySelector('#topp-input').value;
            if (newModel) {
                localStorage.setItem(MODEL_STORAGE_KEY, newModel);
                localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, newReasoning);
                localStorage.setItem(TEMP_STORAGE_KEY, newTemp);
                localStorage.setItem(TOPP_STORAGE_KEY, newTopP);
                hideWindow();
                alert(`設定已儲存！`);
            } else {
                alert('模型名稱不可為空！');
            }
        };
        
        const saveButton = document.createElement('button');
        saveButton.innerText = '儲存';
        saveButton.style.cssText = `padding: 8px 16px; border-radius: 6px; border: none; background-color: #28a745; color: white; cursor: pointer;`;
        saveButton.onclick = saveHandler;

        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);

        createFloatingWindow('設定', contentNode);
    }

    function makeDraggable(element, handle) { /* ... (logic unchanged) ... */ }
    function makeResizable(element, handle) { /* ... (logic unchanged) ... */ }
    function formatMarkdownToHtml(markdownText) { /* ... (logic unchanged) ... */ }
    function getChatIdFromUrl() { /* ... (logic unchanged) ... */ }
    async function initialize() { /* ... (logic unchanged) ... */ }

    // (The unchanged helper functions are omitted here for brevity, but are included in the full script block)
    function makeDraggable(element, handle) { let p1=0,p2=0,p3=0,p4=0; handle.onmousedown=e=>{e.preventDefault();p3=e.clientX;p4=e.clientY;document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};document.onmousemove=e=>{e.preventDefault();p1=p3-e.clientX;p2=p4-e.clientY;p3=e.clientX;p4=e.clientY;element.style.top=(element.offsetTop-p2)+"px";element.style.left=(element.offsetLeft-p1)+"px";};};}
    function makeResizable(element, handle) { handle.onmousedown=e=>{e.preventDefault();const sX=e.clientX,sY=e.clientY,sW=parseInt(document.defaultView.getComputedStyle(element).width,10),sH=parseInt(document.defaultView.getComputedStyle(element).height,10);document.onmousemove=e=>{element.style.width=(sW+e.clientX-sX)+'px';element.style.height=(sH+e.clientY-sY)+'px';};document.onmouseup=()=>{document.onmousemove=null;document.onmouseup=null;};};}
    function formatMarkdownToHtml(markdownText) { if (!markdownText) return '無分析內容。'; let html = markdownText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); html = html.replace(/^### (.*$)/gim, '<h3 style="margin-bottom: 10px; margin-top: 20px;">$1</h3>').replace(/^## (.*$)/gim, '<h2 style="margin-bottom: 15px; margin-top: 25px; border-bottom: 1px solid #eee; padding-bottom: 5px;">$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/^\s*[-*] (.*$)/gim, '<li style="margin-bottom: 8px;">$1</li>'); html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>').replace(/(<li>.*?<\/li>)/g, '<ul style="padding-left: 20px;">$1</ul>').replace(/<\/ul>\s*<ul>/g, ''); return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;}
    function getChatIdFromUrl() { const hash = window.location.hash; return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null; }
    async function initialize() { console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`); await initDB(); const observer = new MutationObserver(() => { if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) { createUI(); } }); observer.observe(document.body, { childList: true, subtree: true }); window.addEventListener('hashchange', updateUIState, false); }

    initialize();

})();
