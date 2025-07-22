// ==UserScript==
// @name         TypingMind 對話分析與整合器
// @namespace    http://tampermonkey.net/
// @version      4.6
// @description  分析、整合並驗證 TypingMind 對話中的多模型回應，提供多提示詞切換、版本化歷史報告、效能數據及可自訂參數的懸浮視窗介面。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const SCRIPT_VERSION = '4.6';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';
    const GROQ_API_KEY_STORAGE_KEY = 'typingmind_analyzer_groq_api_key';
    const GOOGLE_API_KEY_STORAGE_KEY = 'typingmind_analyzer_google_api_key';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';
    const TEMP_STORAGE_KEY = 'typingmind_analyzer_temperature';
    const TOPP_STORAGE_KEY = 'typingmind_analyzer_top_p';
    const REASONING_EFFORT_STORAGE_KEY = 'typingmind_analyzer_reasoning_effort';
    const PROMPT_STORAGE_KEY = 'typingmind_analyzer_prompt_title';
    const AUTO_ANALYZE_STORAGE_KEY = 'typingmind_analyzer_auto_analyze';
    const CUSTOM_PROMPT_STORAGE_KEY = 'typingmind_analyzer_custom_prompt';

    // --- PROMPT LIBRARY ---
    const PROMPTS = [
        {
            title: "整合與驗證 (v3.0+)",
            prompt: `你是一位頂尖的專家級研究員與事實查核員。你的任務是基於使用者提出的「原始問題」，對提供的「多個AI模型的回答文字稿」進行分析與整合。文字稿中的模型可能以長串ID標示，我會提供一個已知ID與其對應官方名稱的列表。

請嚴格遵循以下三段式結構，使用清晰的 Markdown 格式輸出你的最終報告。在報告中，請優先使用模型官方名稱，對於未知ID，請使用「模型A」、「模型B」等代號。

### 1. 原始問題
(在此處簡潔地重述使用者提出的原始問題。)

### 2. AI模型比較
(在此處用一兩句話簡要總結哪個模型的回答總體上更佳，並陳述最核心的理由。)

### 3. 權威性統整回答 (最重要)
(這是報告的核心。請將所有模型回答中的正確、互補的資訊，進行嚴格的事實查核與交叉驗證後，融合成一份單一、全面、且權威性的最終答案。這份答案應該要超越任何單一模型的回答，成為使用者唯一需要閱讀的完整內容。如果不同模型存在無法調和的矛盾，請在此處明確指出。)`
        },
        {
            title: "優劣比較 (v2.x)",
            prompt: `你是一位專業、公正且嚴謹的 AI 模型評估員。你的任務是基於使用者提出的「原始問題」，對提供的「對話文字稿」中多個 AI 模型的回答進行深入的比較分析。你的分析必須客觀、有理有據。

請使用清晰的 Markdown 格式來組織你的回答，應包含以下部分：
- ### 總體評價
  (簡要說明哪個模型的回答更好，為什麼？)
- ### 各模型優點
  (使用列表分別陳述每個模型回答的優點。)
- ### 各模型缺點
  (使用列表分別陳述每個模型回答的缺點。)
- ### 結論與建議
  (提供最終的裁決總結或改進建議。)`
        },
        {
            title: "數學領域統整",
            prompt: `你是一位數學專家。基於使用者提出的數學問題，對多個AI模型的回答進行統整。只針對上一輪問題、AI回答及過去總結。輸出結構：### 1. 問題簡述\n### 2. 模型比較\n### 3. 統整解答 (包含步驟、證明、驗證)`
        },
        {
            title: "程式領域統整",
            prompt: `你是一位程式專家。基於使用者提出的程式問題，對多個AI模型的回答進行統整。只針對上一輪問題、AI回答及過去總結。輸出結構：### 1. 問題簡述\n### 2. 模型比較\n### 3. 統整程式碼與解釋 (包含程式碼、註解、測試)`
        },
        {
            title: "自定義提示詞",
            prompt: "" // Will be filled from storage
        }
    ];

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 3; // Bumped for title addition
    let db;

    // --- DATABASE HELPERS ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                const oldVersion = event.oldVersion;
                if (oldVersion < 3) {
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
            const report = {
                uuid: self.crypto.randomUUID(),
                chatId: chatId,
                title: title,
                report: reportData,
                timestamp: new Date()
            };
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
            request.onsuccess = () => resolve(request.result.sort((a, b) => b.timestamp - a.timestamp)); // Sort newest first
            request.onerror = (event) => reject(`讀取報告失敗: ${event.target.error}`);
        });
    }

    // --- UI CREATION & STATE MANAGEMENT ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;
        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        container.style.cssText = `position: fixed; bottom: 80px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`; // Moved up
        const mainButton = document.createElement('button');
        mainButton.id = 'analyzer-main-button';
        mainButton.style.cssText = `background-color: #4A90E2; color: white; border: none; border-radius: 8px; padding: 10px 15px; font-size: 14px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: all 0.3s; min-width: 120px; text-align: center;`;
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
        if (!mainButton || mainButton.disabled) return;
        const reanalyzeButton = document.getElementById('analyzer-reanalyze-button');
        const chatId = getChatIdFromUrl();
        if (!chatId) {
            mainButton.style.display = 'none';
            reanalyzeButton.style.display = 'none';
            return;
        }
        mainButton.style.display = 'inline-block';
        const reports = await getReportsForChat(chatId);
        if (reports.length > 0) {
            mainButton.innerHTML = '📄 查看報告';
            mainButton.onclick = () => showReportListWindow(reports);
            reanalyzeButton.style.display = 'inline-block';
        } else {
            mainButton.innerHTML = '🤖 整合分析';
            mainButton.onclick = () => handleAnalysisRequest(false);
            reanalyzeButton.style.display = 'none';
        }
    }

    // --- CORE LOGIC ---
    async function handleAnalysisRequest(isReanalysis = false) {
        const mainButton = document.getElementById('analyzer-main-button');
        const reanalyzeButton = document.getElementById('analyzer-reanalyze-button');
        try {
            if (mainButton) {
                mainButton.innerHTML = '分析中... 🤖';
                mainButton.disabled = true;
                if(reanalyzeButton) reanalyzeButton.style.display = 'none';
            }
            const chatId = getChatIdFromUrl();
            if (!chatId) { throw new Error('無法獲取對話 ID。'); }
            const reports = await getReportsForChat(chatId);
            if (!isReanalysis && reports.length > 0) {
                showReportListWindow(reports);
                return;
            }
            const analysisTime = new Date();
            const { messages, modelMap } = await getTypingMindChatHistory();
            if (messages.length < 2) { throw new Error('當前對話訊息不足，無法進行分析。'); }
            const lastUserQuestion = messages.slice().reverse().find(m => m.role === 'user')?.content || '未找到原始問題。';
            const questionSummary = typeof lastUserQuestion === 'string' ? lastUserQuestion.substring(0, 15) + (lastUserQuestion.length > 15 ? '...' : '') : '未知問題';
            const formattedTime = `${analysisTime.getFullYear()}-${String(analysisTime.getMonth() + 1).padStart(2, '0')}-${String(analysisTime.getDate()).padStart(2, '0')} ${String(analysisTime.getHours()).padStart(2, '0')}:${String(analysisTime.getMinutes()).padStart(2, '0')}`;
            const reportTitle = `${questionSummary} - ${formattedTime}`;

            let apiKey;
            const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
            if (model.startsWith('grok-')) {
                apiKey = localStorage.getItem(GROQ_API_KEY_STORAGE_KEY);
            } else if (model.startsWith('gemini-')) {
                apiKey = localStorage.getItem(GOOGLE_API_KEY_STORAGE_KEY);
            } else {
                apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
            }
            if (!apiKey) {
                apiKey = window.prompt('請輸入您的 API 金鑰：');
                if (!apiKey) throw new Error('未提供 API 金鑰。');
                if (model.startsWith('grok-')) {
                    localStorage.setItem(GROQ_API_KEY_STORAGE_KEY, apiKey);
                } else if (model.startsWith('gemini-')) {
                    localStorage.setItem(GOOGLE_API_KEY_STORAGE_KEY, apiKey);
                } else {
                    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
                }
            }
            const startTime = Date.now();
            const analysisResult = await analyzeConversation(apiKey, messages, modelMap, reports, isReanalysis);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            let footer = `\n\n---\n*報告生成耗時：${duration} 秒*`;
            if (analysisResult.usage) {
                footer += `\n\n*Token 消耗：輸入 ${analysisResult.usage.prompt_tokens}, 輸出 ${analysisResult.usage.completion_tokens}, 總計 ${analysisResult.usage.total_tokens}*`;
            }
            const finalReportText = analysisResult.content + footer;
            await saveReport(chatId, finalReportText, reportTitle);
            showToast('總結已完成！');
            showReportWindow(finalReportText, reportTitle);
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
                    if (chatData.model && chatData.modelInfo) {
                        modelMap[chatData.model] = chatData.modelInfo.title || chatData.model;
                    }
                    for (const turn of chatData.messages) {
                        if (turn.role === 'user') allMessages.push(turn);
                        else if (turn.type === 'tm_multi_responses' && turn.responses) {
                            for (const response of turn.responses) {
                                if (response.model && response.modelInfo) {
                                    modelMap[response.model] = response.modelInfo.title || response.model;
                                }
                                if (response.messages && response.model) {
                                    allMessages.push(...response.messages.map(msg => ({ ...msg, model: response.model })));
                                }
                            }
                        } else if (turn.role === 'assistant') allMessages.push(turn);
                    }
                    resolve({ messages: allMessages, modelMap: modelMap });
                };
            };
        });
    }

    // --- LLM INTERACTION ---
    async function analyzeConversation(apiKey, messages, modelMap, reports, isReanalysis) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
        const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
        const reasoningEffort = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY);
        const selectedPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || PROMPTS[0].title;
        let systemPrompt = PROMPTS.find(p => p.title === selectedPromptTitle)?.prompt || PROMPTS[0].prompt;
        if (selectedPromptTitle === "自定義提示詞") {
            systemPrompt = localStorage.getItem(CUSTOM_PROMPT_STORAGE_KEY) || systemPrompt;
        }

        const stringifyContent = (content) => {
            if (content === null || content === undefined) return '';
            if (typeof content === 'string') return content;
            return JSON.stringify(content, null, 2);
        };

        // Only last round: last user and following assistants
        const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
        const lastRoundMessages = messages.slice(lastUserIndex);
        const lastUserQuestion = stringifyContent(lastRoundMessages[0]?.content) || '未找到原始問題。';
        const transcript = lastRoundMessages.slice(1).map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');

        // Past summary if exists
        let pastSummary = '';
        if (reports.length > 0 && isReanalysis) {
            const latestReport = reports[0].report;
            const summaryStart = latestReport.indexOf('### 3. 權威性統整回答');
            if (summaryStart !== -1) {
                pastSummary = latestReport.substring(summaryStart).split('---')[0].trim();
            }
            pastSummary = `\n\n--- 過去總結 ---\n${pastSummary}`;
        }

        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) {
            modelMapInfo += `- ${id}: ${modelMap[id]}\n`;
        }

        const userContentForAnalyzer = `${modelMapInfo}\n--- 原始問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}${pastSummary}`;

        let endpoint, headers, body;
        if (model.startsWith('grok-')) {
            endpoint = 'https://api.groq.com/openai/v1/chat/completions';
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            body = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }], temperature, top_p };
        } else if (model.startsWith('gemini-')) {
            endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
            body = {
                contents: [
                    { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContentForAnalyzer }] }
                ],
                generationConfig: { temperature, topP: top_p }
            };
        } else {
            endpoint = 'https://api.openai.com/v1/chat/completions';
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            body = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }], temperature, top_p };
        }
        if (reasoningEffort && !model.startsWith('gemini-')) { body.reasoning_effort = reasoningEffort; }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
        }
        const data = await response.json();
        let content, usage;
        if (model.startsWith('gemini-')) {
            content = data.candidates[0].content.parts[0].text;
            usage = data.usageMetadata ? { prompt_tokens: data.usageMetadata.promptTokenCount, completion_tokens: data.usageMetadata.candidatesTokenCount, total_tokens: data.usageMetadata.totalTokenCount } : null;
        } else {
            content = data.choices[0].message.content;
            usage = data.usage;
        }
        return { content, usage };
    }

    // --- UI (FLOATING WINDOW & TOAST) ---
    function createFloatingWindow(title, contentNode, options = {}) {
        hideWindow();
        const windowEl = document.createElement('div');
        windowEl.id = 'analyzer-window';
        windowEl.style.cssText = `position: fixed; top: ${options.top || '50px'}; left: ${options.left || '50px'}; width: ${options.width || '500px'}; height: ${options.height || '600px'}; z-index: 10001; background-color: #fff; border: 1px solid #ccc; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;`;
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

    function showReportWindow(reportText, reportTitle) {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = formatMarkdownToHtml(reportText);
        const copyButton = document.createElement('button');
        copyButton.innerText = '複製統整回答';
        copyButton.style.cssText = `margin-top: 10px; padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;`;
        copyButton.onclick = () => {
            const sections = reportText.split('### 3. 權威性統整回答');
            const integratedPart = sections.length > 1 ? sections[1].split('---')[0].trim() : '';
            navigator.clipboard.writeText(integratedPart).then(() => showToast('已複製統整部分！'));
        };
        contentNode.appendChild(copyButton);
        createFloatingWindow(reportTitle || '整合分析報告', contentNode);
    }

    function showReportListWindow(reports) {
        const contentNode = document.createElement('div');
        let listHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
        reports.forEach(report => {
            listHtml += `<li data-uuid="${report.uuid}" style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; transition: background-color 0.2s;">${report.title || '未知標題'}</li>`;
        });
        listHtml += '</ul>';
        contentNode.innerHTML = listHtml;
        contentNode.querySelectorAll('li').forEach(li => {
            li.onmouseover = () => li.style.backgroundColor = '#f0f0f0';
            li.onmouseout = () => li.style.backgroundColor = 'transparent';
            li.onclick = () => {
                const selectedReport = reports.find(r => r.uuid === li.dataset.uuid);
                if(selectedReport) showReportWindow(selectedReport.report, selectedReport.title);
            };
        });
        createFloatingWindow('歷史報告清單', contentNode, { height: '400px', width: '350px' });
    }

    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        const currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const currentTemp = localStorage.getItem(TEMP_STORAGE_KEY) || '1.0';
        const currentTopP = localStorage.getItem(TOPP_STORAGE_KEY) || '1.0';
        const currentReasoning = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY) || 'High';
        const currentPrompt = localStorage.getItem(PROMPT_STORAGE_KEY) || PROMPTS[0].title;
        const currentAutoAnalyze = localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY) !== 'false'; // Default true
        const currentCustomPrompt = localStorage.getItem(CUSTOM_PROMPT_STORAGE_KEY) || '';

        let promptOptions = '';
        PROMPTS.forEach(p => {
            promptOptions += `<option value="${p.title}" ${p.title === currentPrompt ? 'selected' : ''}>${p.title}</option>`;
        });

        contentNode.innerHTML = `
            <div><label style="display: block; margin-bottom: 8px;">分析模式 (提示詞):</label><select id="prompt-select" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">${promptOptions}</select></div>
            <div id="custom-prompt-container" style="display: ${currentPrompt === '自定義提示詞' ? 'block' : 'none'}; margin-top: 15px;"><label for="custom-prompt" style="display: block; margin-bottom: 8px;">自定義提示詞:</label><textarea id="custom-prompt" style="width: 100%; height: 100px; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">${currentCustomPrompt}</textarea></div>
            <div style="margin-top: 15px;"><label for="model-input" style="display: block; margin-bottom: 8px;">分析模型名稱 (e.g., gpt-4o, grok-beta, gemini-1.5-pro):</label><input type="text" id="model-input" value="${currentModel}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="margin-top: 15px;"><label for="openai-key-input" style="display: block; margin-bottom: 8px;">OpenAI API Key:</label><input type="text" id="openai-key-input" value="${localStorage.getItem(API_KEY_STORAGE_KEY) || ''}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="margin-top: 15px;"><label for="groq-key-input" style="display: block; margin-bottom: 8px;">Groq (XAI) API Key:</label><input type="text" id="groq-key-input" value="${localStorage.getItem(GROQ_API_KEY_STORAGE_KEY) || ''}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="margin-top: 15px;"><label for="google-key-input" style="display: block; margin-bottom: 8px;">Google (Gemini) API Key:</label><input type="text" id="google-key-input" value="${localStorage.getItem(GOOGLE_API_KEY_STORAGE_KEY) || ''}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="margin-top: 15px;"><label for="reasoning-input" style="display: block; margin-bottom: 8px;">Reasoning Effort:</label><input type="text" id="reasoning-input" value="${currentReasoning}" placeholder="例如: High, Medium, Auto" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="display: flex; gap: 20px; margin-top: 15px;">
                <div style="flex: 1;"><label for="temp-input" style="display: block; margin-bottom: 8px;">Temperature (0-2):</label><input type="number" id="temp-input" value="${currentTemp}" step="0.1" min="0" max="2" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
                <div style="flex: 1;"><label for="topp-input" style="display: block; margin-bottom: 8px;">Top P (0-1):</label><input type="number" id="topp-input" value="${currentTopP}" step="0.1" min="0" max="1" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            </div>
            <div style="margin-top: 15px;"><label><input type="checkbox" id="auto-analyze" ${currentAutoAnalyze ? 'checked' : ''}> 啟用自動統整 (所有模型回答完後)</label></div>`;
        const promptSelect = contentNode.querySelector('#prompt-select');
        promptSelect.onchange = () => {
            const customContainer = contentNode.querySelector('#custom-prompt-container');
            customContainer.style.display = (promptSelect.value === '自定義提示詞') ? 'block' : 'none';
        };
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 15px;`;
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999; margin-right: auto;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        const saveHandler = () => {
            localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
            localStorage.setItem(MODEL_STORAGE_KEY, contentNode.querySelector('#model-input').value);
            localStorage.setItem(API_KEY_STORAGE_KEY, contentNode.querySelector('#openai-key-input').value);
            localStorage.setItem(GROQ_API_KEY_STORAGE_KEY, contentNode.querySelector('#groq-key-input').value);
            localStorage.setItem(GOOGLE_API_KEY_STORAGE_KEY, contentNode.querySelector('#google-key-input').value);
            localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, contentNode.querySelector('#reasoning-input').value);
            localStorage.setItem(TEMP_STORAGE_KEY, contentNode.querySelector('#temp-input').value);
            localStorage.setItem(TOPP_STORAGE_KEY, contentNode.querySelector('#topp-input').value);
            localStorage.setItem(AUTO_ANALYZE_STORAGE_KEY, contentNode.querySelector('#auto-analyze').checked);
            if (contentNode.querySelector('#prompt-select').value === '自定義提示詞') {
                localStorage.setItem(CUSTOM_PROMPT_STORAGE_KEY, contentNode.querySelector('#custom-prompt').value);
            }
            hideWindow();
            alert(`設定已儲存！`);
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

    function showToast(message) {
        let toast = document.getElementById('analyzer-toast');
        if (toast) toast.remove();
        toast = document.createElement('div');
        toast.id = 'analyzer-toast';
        toast.textContent = message;
        toast.style.cssText = `position: fixed; bottom: 30px; right: 200px; background-color: #28a745; color: white; padding: 12px 20px; border-radius: 8px; z-index: 10002; font-size: 14px; opacity: 0; transition: opacity 0.5s, transform 0.5s; transform: translateY(20px);`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        }, 10);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(20px)';
            setTimeout(() => toast.remove(), 500);
        }, 3000);

        // Windows notification
        if (Notification.permission === 'granted') {
            new Notification('TypingMind Analyzer', { body: message });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('TypingMind Analyzer', { body: message });
                }
            });
        }
    }

    function makeDraggable(element, handle) { let p1=0,p2=0,p3=0,p4=0; handle.onmousedown=e=>{e.preventDefault();p3=e.clientX;p4=e.clientY;document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};document.onmousemove=e=>{e.preventDefault();p1=p3-e.clientX;p2=p4-e.clientY;p3=e.clientX;p4=e.clientY;element.style.top=(element.offsetTop-p2)+"px";element.style.left=(element.offsetLeft-p1)+"px";};};}
    function makeResizable(element, handle) { handle.onmousedown=e=>{e.preventDefault();const sX=e.clientX,sY=e.clientY,sW=parseInt(document.defaultView.getComputedStyle(element).width,10),sH=parseInt(document.defaultView.getComputedStyle(element).height,10);document.onmousemove=e=>{element.style.width=(sW+e.clientX-sX)+'px';element.style.height=(sH+e.clientY-sY)+'px';};document.onmouseup=()=>{document.onmousemove=null;document.onmouseup=null;};};}
    function formatMarkdownToHtml(markdownText) { if (!markdownText) return '無分析內容。'; let html = markdownText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); html = html.replace(/^### (.*$)/gim, '<h3 style="margin-bottom: 10px; margin-top: 20px; color: #333;">$1</h3>').replace(/^## (.*$)/gim, '<h2 style="margin-bottom: 15px; margin-top: 25px; border-bottom: 1px solid #eee; padding-bottom: 5px; color: #111;">$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/^\s*[-*] (.*$)/gim, '<li style="margin-bottom: 8px;">$1</li>'); html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>').replace(/(<li>.*?<\/li>)/g, '<ul style="padding-left: 20px; margin-top: 10px;">$1</ul>').replace(/<\/ul>\s*<ul>/g, ''); return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;}
    function getChatIdFromUrl() { const hash = window.location.hash; return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null; }

    // --- AUTO ANALYZE ---
    function setupAutoAnalyze() {
        const observer = new MutationObserver(async () => {
            if (localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY) !== 'false') {
                const { messages } = await getTypingMindChatHistory().catch(() => ({ messages: [] }));
                const lastTurn = messages[messages.length - 1];
                if (lastTurn && lastTurn.type === 'tm_multi_responses' && lastTurn.responses && lastTurn.responses.every(r => r.messages && r.messages.length > 0)) {
                    handleAnalysisRequest(false);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // --- INITIALIZATION ---
    async function initialize() {
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();

        // Request notification permission
        if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
            Notification.requestPermission();
        }

        // More robust state update logic
        let lastSeenChatId = null;
        setInterval(() => {
            const currentChatId = getChatIdFromUrl();
            if (currentChatId !== lastSeenChatId) {
                lastSeenChatId = currentChatId;
                updateUIState();
            }
        }, 500); // Check every 500ms

        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                createUI();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setupAutoAnalyze();
    }

    initialize();

})();
