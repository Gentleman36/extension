// ==UserScript==
// @name         TypingMind 對話分析與整合器 (穩定版)
// @namespace    http://tampermonkey.net/
// @version      4.4
// @description  終極穩定版：支援多API平台(OpenAI, Gemini, Grok)、自訂提示詞庫、自動分析、增量統整、版本化歷史報告、桌面通知、效能數據及可自訂參數的懸浮視窗介面。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION V4.4 ---
    const SCRIPT_VERSION = '4.4';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';
    const API_PROVIDER_KEY = 'typingmind_analyzer_api_provider';
    const API_KEY_OPENAI_KEY = 'typingmind_analyzer_api_key_openai';
    const API_KEY_GEMINI_KEY = 'typingmind_analyzer_api_key_gemini';
    const API_KEY_XAI_KEY = 'typingmind_analyzer_api_key_xai';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';
    const TEMP_STORAGE_KEY = 'typingmind_analyzer_temperature';
    const TOPP_STORAGE_KEY = 'typingmind_analyzer_top_p';
    const REASONING_EFFORT_STORAGE_KEY = 'typingmind_analyzer_reasoning_effort';
    const PROMPT_STORAGE_KEY = 'typingmind_analyzer_prompt_title';
    const CUSTOM_PROMPTS_STORAGE_KEY = 'typingmind_analyzer_custom_prompts';
    const AUTO_ANALYZE_KEY = 'typingmind_analyzer_auto_analyze';

    // --- DEFAULT PROMPT LIBRARY ---
    const DEFAULT_PROMPTS = [
        {
            title: "整合與驗證 (預設)",
            prompt: `你是一位頂尖的專家級研究員與事實查核員。你的任務是基於使用者提出的「原始問題」，對提供的「多個AI模型的回答文字稿」進行分析與整合。文字稿中的模型可能以長串ID標示，我會提供一個已知ID與其對應官方名稱的列表。\n\n請嚴格遵循以下三段式結構，使用清晰的 Markdown 格式輸出你的最終報告。在報告中，請優先使用模型官方名稱，對於未知ID，請使用「模型A」、「模型B」等代號。\n\n### 1. 原始問題\n(在此處簡潔地重述使用者提出的原始問題。)\n\n### 2. AI模型比較\n(在此處用一兩句話簡要總結哪個模型的回答總體上更佳，並陳述最核心的理由。)\n\n### 3. 權威性統整回答 (最重要)\n(這是報告的核心。請將所有模型回答中的正確、互補的資訊，進行嚴格的事實查核與交叉驗證後，融合成一份單一、全面、且權威性的最終答案。這份答案應該要超越任何單一模型的回答，成為使用者唯一需要閱讀的完整內容。如果不同模型存在無法調和的矛盾，請在此處明確指出。)`,
            isDefault: true
        },
        {
            title: "優劣比較",
            prompt: `你是一位專業、公正且嚴謹的 AI 模型評估員。你的任務是基於使用者提出的「原始問題」，對提供的「對話文字稿」中多個 AI 模型的回答進行深入的比較分析。你的分析必須客觀、有理有據。\n\n請使用清晰的 Markdown 格式來組織你的回答，應包含以下部分：\n- ### 總體評價\n  (簡要說明哪個模型的回答更好，為什麼？)\n- ### 各模型優點\n  (使用列表分別陳述每個模型回答的優點。)\n- ### 各模型缺點\n  (使用列表分別陳述每個模型回答的缺點。)\n- ### 結論與建議\n  (提供最終的裁決總結或改進建議。)`,
            isDefault: true
        }
    ];

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 2;
    let db;

    // --- DATABASE HELPERS ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                if (event.oldVersion < 2) {
                    if (dbInstance.objectStoreNames.contains(REPORT_STORE_NAME)) {
                        dbInstance.deleteObjectStore(REPORT_STORE_NAME);
                    }
                    const store = dbInstance.createObjectStore(REPORT_STORE_NAME, { keyPath: 'uuid' });
                    store.createIndex('chatIdIndex', 'chatId', { unique: false });
                }
            };
            request.onerror = (event) => reject(`資料庫錯誤: ${event.target.errorCode}`);
            request.onsuccess = (event) => {
                db = event.target.result;
                resolve(db);
            };
        });
    }

    function saveReport(chatId, reportData, title) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction([REPORT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const report = { uuid: self.crypto.randomUUID(), chatId, title, report: reportData, timestamp: new Date() };
            const request = store.add(report);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(`儲存報告失敗: ${event.target.error}`);
        });
    }

    function getReportsForChat(chatId) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction([REPORT_STORE_NAME], 'readonly');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const index = store.index('chatIdIndex');
            const request = index.getAll(chatId);
            request.onsuccess = () => resolve(request.result.sort((a, b) => b.timestamp - a.timestamp));
            request.onerror = (event) => reject(`讀取報告失敗: ${event.target.error}`);
        });
    }

    // --- UTILITY HELPERS ---
    function stringifyContent(content) {
        if (content === null || content === undefined) return '';
        if (typeof content === 'string') return content;
        return JSON.stringify(content, null, 2);
    }
    
    function getChatIdFromUrl() {
        const hash = window.location.hash;
        return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null;
    }

    function getPrompts() {
        const customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]');
        return [...DEFAULT_PROMPTS, ...customPrompts];
    }
    
    function savePrompts(prompts) {
        const customPrompts = prompts.filter(p => !p.isDefault);
        localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(customPrompts));
    }
    
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // --- UI CREATION & STATE MANAGEMENT ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;
        console.log("Analyzer: Creating UI...");
        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        container.style.cssText = "position:fixed;bottom:70px;right:20px;z-index:9999;display:flex;gap:10px;align-items:center;";
        const mainButton = document.createElement('button');
        mainButton.id = 'analyzer-main-button';
        mainButton.style.cssText = "background-color:#4A90E2;color:white;border:none;border-radius:8px;padding:10px 15px;font-size:14px;cursor:pointer;box-shadow:0 4px 6px rgba(0,0,0,0.1);transition:all .3s;min-width:120px;text-align:center;";
        const reanalyzeButton = document.createElement('button');
        reanalyzeButton.id = 'analyzer-reanalyze-button';
        reanalyzeButton.innerHTML = '🔄';
        reanalyzeButton.title = '重新分析與整合';
        reanalyzeButton.style.cssText = "background-color:#6c757d;color:white;border:none;border-radius:50%;width:38px;height:38px;font-size:18px;cursor:pointer;display:none;box-shadow:0 2px 4px rgba(0,0,0,0.1);";
        reanalyzeButton.onclick = () => handleAnalysisRequest(true);
        const settingsButton = document.createElement('button');
        settingsButton.innerHTML = '⚙️';
        settingsButton.title = '設定';
        settingsButton.style.cssText = "background-color:#f0f0f0;color:#333;border:1px solid #ccc;border-radius:50%;width:38px;height:38px;font-size:20px;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.1);";
        settingsButton.onclick = showSettingsWindow;
        container.appendChild(reanalyzeButton);
        container.appendChild(mainButton);
        container.appendChild(settingsButton);
        document.body.appendChild(container);
        updateUIState();
        setupAutoAnalyzerObserver();
    }

    function destroyUI() {
        const ui = document.getElementById('analyzer-controls-container');
        if (ui) {
            console.log("Analyzer: Destroying UI...");
            ui.remove();
        }
    }

    async function updateUIState() {
        const mainButton = document.getElementById('analyzer-main-button');
        if (!mainButton || mainButton.disabled) return;
        const reanalyzeButton = document.getElementById('analyzer-reanalyze-button');
        const chatId = getChatIdFromUrl();
        if (!chatId) return;
        const reports = await getReportsForChat(chatId);
        if (reports.length > 0) {
            mainButton.innerHTML = '📄 查看報告';
            mainButton.onclick = () => showReportListWindow(reports);
            if (reanalyzeButton) reanalyzeButton.style.display = 'inline-block';
        } else {
            mainButton.innerHTML = '🤖 整合分析';
            mainButton.onclick = () => handleAnalysisRequest(false);
            if (reanalyzeButton) reanalyzeButton.style.display = 'none';
        }
    }

    // --- CORE LOGIC ---
    async function handleAnalysisRequest(isReanalysis = false) {
        const mainButton = document.getElementById('analyzer-main-button');
        const reanalyzeButton = document.getElementById('analyzer-reanalyze-button');
        const analysisTimestamp = new Date();
        let reportTitle = '';
        try {
            if (mainButton) {
                mainButton.innerHTML = '準備中...';
                mainButton.disabled = true;
                if(reanalyzeButton) reanalyzeButton.style.display = 'none';
            }
            const chatId = getChatIdFromUrl();
            if (!chatId) throw new Error('無法獲取對話 ID。');
            let reports = await getReportsForChat(chatId);
            if (!isReanalysis && reports.length > 0) {
                showReportListWindow(reports);
                return;
            }
            let apiKey;
            const provider = localStorage.getItem(API_PROVIDER_KEY) || 'openai';
            const apiKeyStorageKey = `typingmind_analyzer_api_key_${provider}`;
            apiKey = localStorage.getItem(apiKeyStorageKey);
             if (!apiKey) {
                apiKey = window.prompt(`請輸入您的 ${provider.toUpperCase()} API 金鑰：`);
                if (!apiKey) throw new Error('未提供 API 金鑰。');
                localStorage.setItem(apiKeyStorageKey, apiKey);
             }
            if (mainButton) mainButton.innerHTML = '讀取中...';
            const { messages, modelMap } = await getTypingMindChatHistory();
            if (messages.length < 2) throw new Error('當前對話訊息不足，無法進行分析。');
            const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
            const lastTurnMessages = messages.slice(lastUserIndex);
            const previousSummary = reports.length > 0 ? reports[0].report.split('\n\n---')[0] : null;
            const userQuestion = stringifyContent(lastTurnMessages.find(m => m.role === 'user')?.content) || '新對話';
            reportTitle = `${userQuestion.substring(0, 15)}... (${analysisTimestamp.getHours()}:${String(analysisTimestamp.getMinutes()).padStart(2, '0')})`;
            if (mainButton) mainButton.innerHTML = '分析中... 🤖';
            const startTime = Date.now();
            const analysisResult = await analyzeConversation(lastTurnMessages, modelMap, previousSummary);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            let footer = `\n\n---\n*報告生成耗時：${duration} 秒*`;
            if (analysisResult.usage && analysisResult.usage.total_tokens) {
                footer += `\n\n*Token 消耗：輸入 ${analysisResult.usage.prompt_tokens}, 輸出 ${analysisResult.usage.completion_tokens}, 總計 ${analysisResult.usage.total_tokens}*`;
            }
            const finalReportText = analysisResult.content + footer;
            await saveReport(chatId, finalReportText, reportTitle);
            showToast('總結已完成！');
            requestAndShowDesktopNotification('TypingMind 總結報告已完成！', `點擊查看關於「${userQuestion.substring(0, 20)}...」的報告。`);
            showReportWindow(finalReportText);
        } catch (error) {
            console.error('分析擴充程式錯誤:', error);
            alert(`發生錯誤: ${error.message}`);
        } finally {
            if (mainButton) {
                mainButton.disabled = false;
                updateUIState();
            }
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
                    const modelMap = {};
                    if (chatData.model && chatData.modelInfo) modelMap[chatData.model] = chatData.modelInfo.title || chatData.model;
                    for (const turn of chatData.messages) {
                        if (turn.role === 'user') allMessages.push(turn);
                        else if (turn.type === 'tm_multi_responses' && turn.responses) {
                            for (const response of turn.responses) {
                                if (response.model && response.modelInfo) modelMap[response.model] = response.modelInfo.title || response.model;
                                if (response.messages && response.model) allMessages.push(...response.messages.map(msg => ({ ...msg, model: response.model })));
                            }
                        } else if (turn.role === 'assistant') allMessages.push(turn);
                    }
                    resolve({ messages: allMessages, modelMap: modelMap });
                };
            };
        });
    }

    // --- LLM INTERACTION ---
    async function analyzeConversation(messages, modelMap, previousSummary) {
        const provider = localStorage.getItem(API_PROVIDER_KEY) || 'openai';
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
        const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
        const reasoningEffort = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY);
        const allPrompts = getPrompts();
        const selectedPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || allPrompts[0].title;
        let systemPrompt = allPrompts.find(p => p.title === selectedPromptTitle)?.prompt || allPrompts[0].prompt;
        if (previousSummary) {
            systemPrompt = `你是一位頂尖的專家級研究員。你的任務是「更新」一份已有的總結報告。\n\n你將收到三份資訊：\n1. 【過往的總結】：這是基於更早之前的對話得出的結論。\n2. 【最新的問題】：這是使用者剛剛提出的新問題。\n3. 【最新的AI回答】：這是多個AI模型對「最新的問題」的回答。\n\n你的任務是，在【過往的總結】的基礎上，吸收【最新的AI回答】中的新資訊，來對其進行「擴充」、「修正」或「重寫」，以回答【最新的問題】。最終產出一份更新後、更完善的「權威性統整回答」。請保持報告的連貫性與完整性，並遵循以下的格式要求：\n\n` + systemPrompt;
        }
        const lastUserQuestion = stringifyContent(messages.find(m => m.role === 'user')?.content) || '未找到原始問題。';
        const transcript = messages.filter(msg => msg.role !== 'user').map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');
        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) { modelMapInfo += `- ${id}: ${modelMap[id]}\n`; }
        const userContentForAnalyzer = `${modelMapInfo}\n--- ${previousSummary ? '最新的問題' : '原始問題'} ---\n${lastUserQuestion}\n\n--- ${previousSummary ? '最新的AI回答' : '對話文字稿'} ---\n${transcript}${previousSummary ? `\n\n--- 過往的總結 ---\n${previousSummary}` : ''}`;
        const commonPayload = { model, temperature, top_p };
        if (reasoningEffort) commonPayload.reasoning_effort = reasoningEffort;
        let endpoint, headers, body, apiKey;
        if (provider === 'google') {
            apiKey = localStorage.getItem(API_KEY_GEMINI_KEY);
            if (!apiKey) throw new Error('尚未設定 Google AI (Gemini) 的 API 金鑰。');
            endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
            body = { contents: [ { role: 'user', parts: [{ text: systemPrompt + "\n\n" + userContentForAnalyzer }] } ], generationConfig: { temperature: commonPayload.temperature, topP: commonPayload.top_p } };
        } else {
            let baseUrl;
            const apiKeyMap = { openai: API_KEY_OPENAI_KEY, xai: API_KEY_XAI_KEY };
            apiKey = localStorage.getItem(apiKeyMap[provider]);
            if (provider === 'xai') { baseUrl = 'https://api.x.ai/v1'; }
            else { baseUrl = 'https://api.openai.com/v1'; }
            if (!apiKey) throw new Error(`尚未設定 ${provider} 的 API 金鑰。`);
            endpoint = `${baseUrl}/chat/completions`;
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            body = { ...commonPayload, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }] };
        }
        const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) { const errorData = await response.json(); throw new Error(`API 錯誤 (${provider}/${model}): ${response.status} - ${errorData.error?.message ?? JSON.stringify(errorData)}`); }
        const data = await response.json();
        let content = '', usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        if (provider === 'google') { content = data.candidates[0].content.parts[0].text; }
        else { content = data.choices[0].message.content; if (data.usage) usage = data.usage; }
        return { content, usage };
    }

    // --- UI (FLOATING WINDOW, TOAST, NOTIFICATIONS, etc.) ---
    function createFloatingWindow(title, contentNode, options = {}) {
        hideWindow();
        const windowEl = document.createElement('div');
        windowEl.id = 'analyzer-window';
        windowEl.style.cssText = `position: fixed; top: ${options.top || '50px'}; left: ${options.left || '50px'}; width: ${options.width || '500px'}; height: ${options.height || '600px'}; z-index: 10001; background-color: #fff; border: 1px solid #ccc; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;`;
        const header = document.createElement('div');
        header.style.cssText = "background-color:#f0f0f0;padding:8px 12px;cursor:move;border-bottom:1px solid #ccc;display:flex;justify-content:space-between;align-items:center;user-select:none;gap:10px";
        const titleEl = document.createElement('span');
        titleEl.textContent = title;
        titleEl.style.fontWeight = 'bold';
        titleEl.style.whiteSpace = 'nowrap';
        titleEl.style.overflow = 'hidden';
        titleEl.style.textOverflow = 'ellipsis';
        const controlsContainer = document.createElement('div');
        controlsContainer.style.display = "flex";
        controlsContainer.style.alignItems = "center";
        controlsContainer.style.gap = "10px";
        if (options.showCopyButton) {
            const copyButton = createButton('複製總結', () => {}, 'grey');
            copyButton.style.padding = '4px 8px';
            copyButton.style.fontSize = '12px';
            copyButton.onclick = (e) => {
                e.stopPropagation();
                const reportText = options.fullReportText || '';
                const parts = reportText.split(/### 3\.\s*權威性統整回答\s*\(最重要\)/i);
                if (parts.length > 1) {
                    const coreAnswer = parts[1].split('\n\n---')[0].trim();
                    navigator.clipboard.writeText(coreAnswer).then(() => {
                        copyButton.innerText = '已複製!';
                        setTimeout(() => { copyButton.innerText = '複製總結'; }, 2000);
                    });
                } else {
                    copyButton.innerText = '無內容';
                }
            };
            controlsContainer.appendChild(copyButton);
        }
        const closeButton = document.createElement('button');
        closeButton.innerHTML = '&times;';
        closeButton.style.cssText = "background:none;border:none;font-size:20px;cursor:pointer";
        closeButton.onclick = hideWindow;
        controlsContainer.appendChild(closeButton);
        header.appendChild(titleEl);
        header.appendChild(controlsContainer);
        const contentArea = document.createElement('div');
        contentArea.style.cssText = "padding:15px;flex-grow:1;overflow-y:auto";
        contentArea.appendChild(contentNode);
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = "position:absolute;bottom:0;right:0;width:15px;height:15px;cursor:se-resize;background:linear-gradient(135deg,transparent 50%,#aaa 50%)";
        windowEl.appendChild(header);
        windowEl.appendChild(contentArea);
        windowEl.appendChild(resizeHandle);
        document.body.appendChild(windowEl);
        makeDraggable(windowEl, header);
        makeResizable(windowEl, resizeHandle);
    }
    
    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        const currentProvider = localStorage.getItem(API_PROVIDER_KEY) || 'openai';
        const apiKeyMap = {
            openai: localStorage.getItem(API_KEY_OPENAI_KEY) || '',
            google: localStorage.getItem(API_KEY_GEMINI_KEY) || '',
            xai: localStorage.getItem(API_KEY_XAI_KEY) || '',
        };
        const currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const currentTemp = localStorage.getItem(TEMP_STORAGE_KEY) || '1.0';
        const currentTopP = localStorage.getItem(TOPP_STORAGE_KEY) || '1.0';
        const currentReasoning = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY) || 'High';
        const allPrompts = getPrompts();
        const currentPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || allPrompts[0].title;
        const isAutoAnalyze = localStorage.getItem(AUTO_ANALYZE_KEY) === 'true';

        let promptOptions = allPrompts.map(p => `<option value="${p.title}" ${p.title === currentPromptTitle ? 'selected' : ''}>${p.title}</option>`).join('');
        
        // This is a simplified innerHTML for brevity. Full styles are applied via code.
        contentNode.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;background-color:#f7f7f7;padding:10px;border-radius:6px;margin-bottom:15px">
                <label for="auto-analyze-toggle" style="cursor:pointer;user-select:none;">自動進行統整</label>
                <input type="checkbox" id="auto-analyze-toggle" ${isAutoAnalyze ? 'checked' : ''}>
            </div>
            <div style="margin-top:15px"><label>API 服務商:</label><select id="provider-select">${["openai","google","xai"].map(p=>`<option value="${p}" ${p===currentProvider?"selected":""}>${p.toUpperCase()}</option>`).join('')}</select></div>
            <div style="margin-top:15px"><label>API 金鑰:</label><input type="password" id="api-key-input" value="${apiKeyMap[currentProvider]}"></div>
            <div style="margin-top:15px"><label>分析模型名稱:</label><input type="text" id="model-input" value="${currentModel}"></div>
            <div style="margin-top:15px;display:flex;align-items:center;gap:10px">
                <div style="flex-grow:1"><label>分析模式 (提示詞):</label><select id="prompt-select">${promptOptions}</select></div>
                <button id="manage-prompts-btn">管理...</button>
            </div>
            <div style="margin-top:15px"><label>Reasoning Effort:</label><input type="text" id="reasoning-input" value="${currentReasoning}"></div>
            <div style="display:flex;gap:20px;margin-top:15px">
                <div style="flex:1"><label>Temperature:</label><input type="number" id="temp-input" value="${currentTemp}" step="0.1" min="0" max="2"></div>
                <div style="flex:1"><label>Top P:</label><input type="number" id="topp-input" value="${currentTopP}" step="0.1" min="0" max="1"></div>
            </div>
        `;
        // Apply common styles to all inputs/selects
        contentNode.querySelectorAll('input, select').forEach(el => {
            el.style.cssText += 'width:100%;box-sizing:border-box;padding:10px;border-radius:4px;border:1px solid #ccc;';
        });
        contentNode.querySelector('#manage-prompts-btn').style.cssText = 'padding:8px 12px;border-radius:6px;border:1px solid #ccc;background-color:#fff;cursor:pointer';

        const providerSelect = contentNode.querySelector('#provider-select');
        const apiKeyInput = contentNode.querySelector('#api-key-input');
        providerSelect.onchange = () => {
            const oldProvider = Object.keys(apiKeyMap).find(k => apiKeyMap[k] === apiKeyInput.value) || localStorage.getItem(API_PROVIDER_KEY) || 'openai';
            apiKeyMap[oldProvider] = apiKeyInput.value;
            const newProvider = providerSelect.value;
            apiKeyInput.value = apiKeyMap[newProvider] || '';
            localStorage.setItem(API_PROVIDER_KEY, newProvider);
        };
        contentNode.querySelector('#manage-prompts-btn').onclick = showPromptManagerWindow;

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = "display:flex;gap:10px;justify-content:flex-end;margin-top:25px;align-items:center;border-top:1px solid #eee;padding-top:15px";
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = "font-size:12px;color:#999;margin-right:auto";
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        const saveHandler = () => {
            const provider = providerSelect.value;
            apiKeyMap[provider] = apiKeyInput.value;
            localStorage.setItem(API_KEY_OPENAI_KEY, apiKeyMap.openai);
            localStorage.setItem(API_KEY_GEMINI_KEY, apiKeyMap.google);
            localStorage.setItem(API_KEY_XAI_KEY, apiKeyMap.xai);
            const newModel = contentNode.querySelector('#model-input').value;
            if (!newModel) return alert('模型名稱不可為空！');
            localStorage.setItem(AUTO_ANALYZE_KEY, contentNode.querySelector('#auto-analyze-toggle').checked);
            localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
            localStorage.setItem(MODEL_STORAGE_KEY, newModel);
            localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, contentNode.querySelector('#reasoning-input').value);
            localStorage.setItem(TEMP_STORAGE_KEY, contentNode.querySelector('#temp-input').value);
            localStorage.setItem(TOPP_STORAGE_KEY, contentNode.querySelector('#topp-input').value);
            hideWindow();
            alert('設定已儲存！');
        };
        const saveButton = createButton('儲存', saveHandler, 'green');
        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);
        createFloatingWindow('設定', contentNode);
    }
    
    // Other functions (showPromptManagerWindow, createButton, showToast, notifications, draggable, etc.) are complex and included in minified form for brevity
    function showPromptManagerWindow(){const t=document.createElement("div");t.style.cssText="font-size:14px;";const e=()=>{const n=getPrompts();let o='<ul style="list-style:none;padding:0;margin:0;max-height:200px;overflow-y:auto;border:1px solid #ccc;border-radius:4px;">';n.forEach((t,e)=>{o+=`<li style="padding:8px 12px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;"><span>${t.title}${t.isDefault?" (預設)":""}</span>`+(!t.isDefault?`<span><button data-index="${e}" class="edit-prompt" style="margin-right:5px;cursor:pointer;">編輯</button><button data-index="${e}" class="delete-prompt" style="cursor:pointer;">刪除</button></span>`:"")+"</li>"}),o+="</ul>",t.querySelector("#prompt-list-container").innerHTML=o},n=()=>{const e=getPrompts(),n=t.querySelector("#prompt-title-input").value,o=t.querySelector("#prompt-content-textarea").value,i=t.querySelector("#prompt-edit-index").value;if(!n||!o)return void alert("標題和內容不能為空！");const s={title:n,prompt:o};""!==i?e[DEFAULT_PROMPTS.length + Number(i)]=s:e.push(s),savePrompts(e),a()};t.innerHTML=`<h4 style="margin-top:0;margin-bottom:10px;">提示詞管理員</h4><div id="prompt-list-container"></div><div id="prompt-editor-container" style="display:none;margin-top:15px;border-top:1px solid #eee;padding-top:15px"><input type="hidden" id="prompt-edit-index" value=""><label>標題:</label><input type="text" id="prompt-title-input" style="width:100%;box-sizing:border-box;padding:8px;border-radius:4px;"><label style="margin-top:10px;display:block;">內容:</label><textarea id="prompt-content-textarea" rows="8" style="width:100%;box-sizing:border-box;padding:8px;border-radius:4px;"></textarea><div style="text-align:right;margin-top:10px;"><button id="save-prompt-btn">儲存</button><button id="cancel-edit-btn" style="margin-left:5px;">取消</button></div></div><div style="text-align:right;margin-top:15px;"><button id="add-new-prompt-btn">新增提示詞</button></div>`;const o=()=>{t.querySelector("#prompt-editor-container").style.display="none",t.querySelector("#prompt-list-container").style.display="block",t.querySelector("#add-new-prompt-btn").style.display="block",e()},i=()=>{t.querySelector("#prompt-editor-container").style.display="block",t.querySelector("#prompt-list-container").style.display="none",t.querySelector("#add-new-prompt-btn").style.display="none"},s=t.querySelector("#prompt-list-container");s.addEventListener("click",t=>{const e=t.target;if(e.classList.contains("edit-prompt")){const n=getPrompts()[e.dataset.index];i(),document.querySelector("#prompt-edit-index").value=Number(e.dataset.index)-DEFAULT_PROMPTS.length,document.querySelector("#prompt-title-input").value=n.title,document.querySelector("#prompt-content-textarea").value=n.prompt}else if(e.classList.contains("delete-prompt")&&confirm("確定要刪除這個提示詞嗎？")){const t=getPrompts();t.splice(e.dataset.index,1),savePrompts(t),a()}});const a=()=>{o(),updateSettingsPromptList()};t.querySelector("#add-new-prompt-btn").onclick=()=>{i(),document.querySelector("#prompt-edit-index").value="",document.querySelector("#prompt-title-input").value="",document.querySelector("#prompt-content-textarea").value=""},t.querySelector("#save-prompt-btn").onclick=n,t.querySelector("#cancel-edit-btn").onclick=o,createFloatingWindow("管理提示詞",t,{width:"600px"}),e()}
    function updateSettingsPromptList(){const t=document.getElementById("prompt-select");if(!t)return;const e=getPrompts(),n=localStorage.getItem(PROMPT_STORAGE_KEY)||e[0].title;let o="";e.forEach(e=>{o+=`<option value="${e.title}" ${e.title===n?"selected":""}>${e.title}</option>`}),t.innerHTML=o}
    function createButton(t,e,o="grey"){const n=document.createElement("button");n.innerText=t;const i={grey:{bg:"#6c757d",hover:"#5a6268"},blue:{bg:"#007bff",hover:"#0069d9"},green:{bg:"#28a745",hover:"#218838"}},s=i[o]||i.grey;return n.style.cssText="padding:8px 16px;border-radius:6px;border:none;cursor:pointer;color:white;font-size:14px;font-weight:500;transition:background-color .2s",n.style.backgroundColor=s.bg,n.onmouseover=()=>n.style.backgroundColor=s.hover,n.onmouseout=()=>n.style.backgroundColor=s.bg,n.onclick=e,n}
    function showToast(t){let e=document.getElementById("analyzer-toast");e&&e.remove(),e=document.createElement("div"),e.id="analyzer-toast",e.textContent=t,e.style.cssText="position:fixed;bottom:30px;right:200px;background-color:#28a745;color:white;padding:12px 20px;border-radius:8px;z-index:10002;font-size:14px;opacity:0;transition:opacity .5s,transform .5s;transform:translateY(20px)",document.body.appendChild(e),setTimeout(()=>{e.style.opacity="1",e.style.transform="translateY(0)"},10),setTimeout(()=>{e.style.opacity="0",e.style.transform="translateY(20px)",setTimeout(()=>e.remove(),500)},3e3)}
    function requestAndShowDesktopNotification(t,e){if(!("Notification"in window))return;const n=()=>{new Notification(t,{body:e,icon:"https://www.typingmind.com/favicon.ico"})};"granted"===Notification.permission?n():"denied"!==Notification.permission&&Notification.requestPermission().then(t=>{"granted"===t&&n()})}
    function makeDraggable(t,e){let n,o,s,i;e.onmousedown=a=>{a.preventDefault(),s=a.clientX,i=a.clientY,document.onmouseup=()=>{document.onmouseup=null,document.onmousemove=null},document.onmousemove=a=>{a.preventDefault(),n=s-a.clientX,o=i-a.clientY,s=a.clientX,i=a.clientY,t.style.top=t.offsetTop-o+"px",t.style.left=t.offsetLeft-n+"px"}}}
    function makeResizable(t,e){e.onmousedown=n=>{n.preventDefault();const o=n.clientX,s=n.clientY,i=parseInt(document.defaultView.getComputedStyle(t).width,10),a=parseInt(document.defaultView.getComputedStyle(t).height,10);document.onmousemove=n=>{t.style.width=i+n.clientX-o+"px",t.style.height=a+n.clientY-s+"px"},document.onmouseup=()=>{document.onmousemove=null,document.onmouseup=null}}}
    function formatMarkdownToHtml(t){if(!t)return"";let e=t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");return e=e.replace(/^### (.*$)/gim,'<h3 style="margin-bottom:10px;margin-top:20px;color:#333;">$1</h3>').replace(/^## (.*$)/gim,'<h2 style="margin-bottom:15px;margin-top:25px;border-bottom:1px solid #eee;padding-bottom:5px;color:#111;">$1</h2>').replace(/^# (.*$)/gim,"<h1>$1</h1>").replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>").replace(/\*(.*?)\*/g,"<em>$1</em>").replace(/^\s*[-*] (.*$)/gim,'<li style="margin-bottom:8px;">$1</li>'),e=e.replace(/<li>(.*?)<\/li>\s*(?=<li)/g,"<li>$1</li>").replace(/(<li>.*?<\/li>)/g,'<ul style="padding-left:20px;margin-top:10px;">$1</ul>').replace(/<\/ul>\s*<ul>/g,""),`<div class="markdown-body" style="line-height:1.7;font-size:15px;">${e.replace(/\n/g,"<br>")}</div>`}
    
    // --- INITIALIZATION ---
    async function initialize() {
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();

        // Revert to the most stable UI creation logic
        const uiCreationObserver = new MutationObserver(() => {
            // Use a simple, reliable selector
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                console.log("Analyzer: Textarea found. Creating UI.");
                createUI();
                uiCreationObserver.disconnect(); // Important: Stop observing after success
            }
        });
        uiCreationObserver.observe(document.body, { childList: true, subtree: true });

        // Robust state update polling can stay
        let lastSeenChatId = null;
        setInterval(() => {
            const currentChatId = getChatIdFromUrl();
            if (currentChatId !== lastSeenChatId) {
                lastSeenChatId = currentChatId;
                updateUIState();
            }
        }, 500);
    }
    
    initialize();
})();
