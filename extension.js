// ==UserScript==
// @name         TypingMind 對話分析與整合器
// @namespace    http://tampermonkey.net/
// @version      4.6
// @description  分析、整合並驗證 TypingMind 對話中的多模型回應，提供多提示詞切換、版本化歷史報告、效能數據及可自訂參數的懸浮視窗介面。新增 v4.6 功能：桌面通知、一鍵複製、自動分析、多API支援、自訂提示詞等。
// @author       Gemini & Developer
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION V4.6 ---
    const SCRIPT_VERSION = '4.6';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';

    // Storage Keys
    const API_KEY_STORAGE_KEY_OPENAI = 'typingmind_analyzer_openai_api_key';
    const API_KEY_STORAGE_KEY_GEMINI = 'typingmind_analyzer_gemini_api_key';
    const API_KEY_STORAGE_KEY_XAI = 'typingmind_analyzer_xai_api_key'; // For XAI or other OpenAI-compatible APIs
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';
    const TEMP_STORAGE_KEY = 'typingmind_analyzer_temperature';
    const TOPP_STORAGE_KEY = 'typingmind_analyzer_top_p';
    const PROMPT_STORAGE_KEY = 'typingmind_analyzer_prompt_title';
    const CUSTOM_PROMPTS_STORAGE_KEY = 'typingmind_analyzer_custom_prompts';
    const AUTO_ANALYZE_STORAGE_KEY = 'typingmind_analyzer_auto_analyze_enabled';

    // --- PROMPT LIBRARY V4.6 ---
    const DEFAULT_PROMPTS = [
        {
            title: "整合與驗證 (v4.0+)",
            prompt: `你是一位頂尖的專家級研究員與事實查核員。你的任務是基於「上一輪問題」，對提供的「AI模型回答」以及「過去的總結」進行分析與整合。

請嚴格遵循以下三段式結構，使用清晰的 Markdown 格式輸出你的最終報告。

### 1. 原始問題
(在此處簡潔地重述使用者提出的問題。)

### 2. AI模型比較
(在此處用一兩句話簡要總結哪個模型的回答總體上更佳，並陳述最核心的理由。)

### 3. 權威性統整回答 (最重要)
(這是報告的核心。請將所有模型回答中的正確、互補的資訊，以及「過去的總結」中的相關內容，進行嚴格的事實查核與交叉驗證後，融合成一份單一、全面、且權威性的最終答案。這份答案應該要超越任何單一模型的回答，成為使用者唯一需要閱讀的完整內容。如果不同模型存在無法調和的矛盾，請在此處明確指出。)`
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
        }
    ];

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 3; // Bump version for new report structure
    let db;

    // --- DATABASE HELPERS ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                if (event.oldVersion < 3) {
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

    // NEW (Req #3): Save report with new structure
    function saveReport(chatId, reportData) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction([REPORT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const report = {
                uuid: self.crypto.randomUUID(),
                chatId: chatId,
                ...reportData // Contains title, content, timestamp
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
            request.onsuccess = () => resolve(request.result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
            request.onerror = (event) => reject(`讀取報告失敗: ${event.target.error}`);
        });
    }

    // --- UI CREATION & STATE MANAGEMENT ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;
        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        // NEW (Req #6): Adjusted button position
        container.style.cssText = `position: fixed; bottom: 95px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;

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

            const { messages, modelMap } = await getTypingMindChatHistory();
            if (messages.length < 2) { throw new Error('當前對話訊息不足，無法進行分析。'); }

            // NEW (Req #3): Capture timestamp and generate title
            const analysisTimestamp = new Date();
            const lastUserQuestionText = messages.find(m => m.role === 'user')?.content?.substring(0, 15) || '對話分析';
            const formattedTime = `${analysisTimestamp.getFullYear()}-${String(analysisTimestamp.getMonth() + 1).padStart(2, '0')}-${String(analysisTimestamp.getDate()).padStart(2, '0')} ${String(analysisTimestamp.getHours()).padStart(2, '0')}:${String(analysisTimestamp.getMinutes()).padStart(2, '0')}`;
            const reportTitle = `${lastUserQuestionText}... (${formattedTime})`;

            // NEW (Req #4): Get latest report for context
            const allReports = await getReportsForChat(chatId);
            const previousSummary = allReports.length > 0 ? allReports[0].content : null;

            const startTime = Date.now();
            const analysisResult = await analyzeConversation(messages, modelMap, previousSummary);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            let footer = `\n\n---\n*報告生成耗時：${duration} 秒*`;
            if (analysisResult.usage) {
                footer += `\n\n*Token 消耗：輸入 ${analysisResult.usage.prompt_tokens}, 輸出 ${analysisResult.usage.completion_tokens}, 總計 ${analysisResult.usage.total_tokens}*`;
            }
            const finalReportText = analysisResult.content + footer;

            await saveReport(chatId, { title: reportTitle, content: finalReportText, timestamp: analysisTimestamp });

            showToast('總結已完成！');
            // NEW (Req #1): Show desktop notification
            showDesktopNotification('整合分析完成', '點擊此處查看報告', () => {
                showReportWindow(finalReportText, reportTitle);
            });
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

    // --- LLM INTERACTION (Refactored for v4.6) ---
    // NEW (Req #4, #7, #8)
    async function analyzeConversation(messages, modelMap, previousSummary) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
        const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
        const allPrompts = getPrompts();
        const selectedPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || allPrompts[0].title;
        const systemPrompt = allPrompts.find(p => p.title === selectedPromptTitle)?.prompt || allPrompts[0].prompt;

        const stringifyContent = (content) => {
            if (content === null || content === undefined) return '';
            if (typeof content === 'string') return content;
            return JSON.stringify(content, null, 2);
        };

        // NEW (Req #4): Focus on the last user question and subsequent answers.
        const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
        const relevantMessages = lastUserIndex !== -1 ? messages.slice(lastUserIndex) : messages;
        const lastUserQuestion = stringifyContent(relevantMessages.find(m => m.role === 'user')?.content) || '未找到原始問題。';
        const transcript = relevantMessages.filter(msg => msg.role !== 'user').map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');

        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) { modelMapInfo += `- ${id}: ${modelMap[id]}\n`; }

        let userContentForAnalyzer = `${modelMapInfo}\n--- 上一輪問題 ---\n${lastUserQuestion}\n\n--- AI模型回答 ---\n${transcript}`;
        if (previousSummary) {
            userContentForAnalyzer += `\n\n--- 過去的總結 (請參考並整合) ---\n${previousSummary}`;
        }

        // NEW (Req #7): API ROUTING
        let apiEndpoint, apiKey, requestBody;

        if (model.toLowerCase().startsWith('gemini-')) {
            apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            apiKey = localStorage.getItem(API_KEY_STORAGE_KEY_GEMINI);
            if (!apiKey) throw new Error('尚未設定 Gemini API 金鑰。');
            apiEndpoint += `?key=${apiKey}`;
            requestBody = {
                contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContentForAnalyzer }] }],
                generationConfig: { temperature, topP: top_p }
            };
        } else { // Default to OpenAI-compatible APIs (OpenAI, Groq, XAI etc.)
            apiEndpoint = 'https://api.openai.com/v1/chat/completions'; // Default, can be overridden for XAI etc.
            apiKey = localStorage.getItem(API_KEY_STORAGE_KEY_OPENAI); // Default
            // Check if it's a known non-OpenAI model that uses a compatible API
            if (!model.startsWith('gpt-')) {
                 apiKey = localStorage.getItem(API_KEY_STORAGE_KEY_XAI) || apiKey; // Fallback to XAI key then OpenAI key
            }
            if (!apiKey) throw new Error('尚未設定 OpenAI 或 XAI/相容 API 金鑰。');

            requestBody = {
                model,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }],
                temperature,
                top_p
            };
        }

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...( !model.toLowerCase().startsWith('gemini-') && {'Authorization': `Bearer ${apiKey}`} ) },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json();
            const errorMessage = errorData.error?.message || JSON.stringify(errorData);
            throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorMessage}`);
        }

        const data = await response.json();

        // Process response based on API type
        if (model.toLowerCase().startsWith('gemini-')) {
            return {
                content: data.candidates[0].content.parts[0].text,
                usage: null // Gemini API response structure for usage is different, simplified for now
            };
        } else {
            return {
                content: data.choices[0].message.content,
                usage: data.usage
            };
        }
    }


    // --- UI (FLOATING WINDOW & TOAST) ---
    function createFloatingWindow(title, contentNode, options = {}) {
        hideWindow();
        const windowEl = document.createElement('div');
        windowEl.id = 'analyzer-window';
        windowEl.style.cssText = `position: fixed; top: ${options.top || '50px'}; left: ${options.left || '50px'}; width: ${options.width || '550px'}; height: ${options.height || '700px'}; z-index: 10001; background-color: #fff; border: 1px solid #ccc; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;`;
        const header = document.createElement('div');
        header.style.cssText = `background-color: #f0f0f0; padding: 8px 12px; cursor: move; border-bottom: 1px solid #ccc; display: flex; justify-content: space-between; align-items: center; user-select: none;`;
        const titleEl = document.createElement('span');
        titleEl.textContent = title;
        titleEl.style.cssText = `font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;

        const buttonGroup = document.createElement('div');
        buttonGroup.style.display = 'flex';
        buttonGroup.style.alignItems = 'center';
        buttonGroup.style.gap = '10px';

        if (options.showCopyButton) {
            const copyButton = document.createElement('button');
            copyButton.textContent = '📋 複製統整回答';
            copyButton.style.cssText = 'padding: 4px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background-color: #fff; cursor: pointer;';
            copyButton.onclick = (e) => {
                e.stopPropagation();
                // Find the specific section to copy
                const summaryHeader = '### 3. 權威性統整回答';
                const footerMarker = '\n\n---';
                let contentToCopy = options.rawText;
                const summaryStartIndex = contentToCopy.indexOf(summaryHeader);
                if (summaryStartIndex !== -1) {
                    contentToCopy = contentToCopy.substring(summaryStartIndex + summaryHeader.length).trim();
                    const footerIndex = contentToCopy.lastIndexOf(footerMarker);
                    if (footerIndex !== -1) {
                         contentToCopy = contentToCopy.substring(0, footerIndex).trim();
                    }
                } else {
                    // Fallback to copying everything except footer
                     const footerIndex = contentToCopy.lastIndexOf(footerMarker);
                     if (footerIndex !== -1) {
                         contentToCopy = contentToCopy.substring(0, footerIndex).trim();
                     }
                }
                navigator.clipboard.writeText(contentToCopy).then(() => {
                    copyButton.textContent = '✅ 已複製!';
                    setTimeout(() => { copyButton.textContent = '📋 複製統整回答'; }, 2000);
                }).catch(err => alert('複製失敗: ' + err));
            };
            buttonGroup.appendChild(copyButton);
        }

        const closeButton = document.createElement('button');
        closeButton.innerHTML = '&times;';
        closeButton.style.cssText = `background: none; border: none; font-size: 20px; cursor: pointer;`;
        closeButton.onclick = hideWindow;
        buttonGroup.appendChild(closeButton);

        header.appendChild(titleEl);
        header.appendChild(buttonGroup);

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

    // NEW (Req #2): Pass raw text for copy function
    function showReportWindow(reportText, reportTitle) {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = formatMarkdownToHtml(reportText);
        createFloatingWindow(reportTitle, contentNode, { showCopyButton: true, rawText: reportText });
    }

    // NEW (Req #3): Show new title in list
    function showReportListWindow(reports) {
        const contentNode = document.createElement('div');
        let listHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
        reports.forEach(report => {
            listHtml += `<li data-uuid="${report.uuid}" title="${report.title}" style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${report.title}</li>`;
        });
        listHtml += '</ul>';
        contentNode.innerHTML = listHtml;
        contentNode.querySelectorAll('li').forEach(li => {
            li.onmouseover = () => li.style.backgroundColor = '#f0f0f0';
            li.onmouseout = () => li.style.backgroundColor = 'transparent';
            li.onclick = () => {
                const selectedReport = reports.find(r => r.uuid === li.dataset.uuid);
                if (selectedReport) showReportWindow(selectedReport.content, selectedReport.title);
            };
        });
        createFloatingWindow('歷史報告清單', contentNode, { height: '400px', width: '400px' });
    }

    // NEW (Req #5, #7, #8): Major update to settings window
    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        contentNode.style.cssText = 'display: flex; flex-direction: column; gap: 15px;';

        const allPrompts = getPrompts();
        const currentPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || allPrompts[0].title;
        let promptOptions = allPrompts.map(p => `<option value="${p.title}" ${p.title === currentPromptTitle ? 'selected' : ''}>${p.title}</option>`).join('');

        const isAutoAnalyzeEnabled = localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY) === 'true';

        contentNode.innerHTML = `
            <div>
                <h4 style="margin:0 0 8px;">常規設定</h4>
                <div style="display: flex; gap: 20px;">
                    <div style="flex: 1;"><label style="display: block; margin-bottom: 8px;">分析模式 (提示詞):</label><select id="prompt-select" class="settings-input">${promptOptions}</select></div>
                    <div style="flex: 1;"><label style="display: block; margin-bottom: 8px;">分析模型:</label><input type="text" id="model-input" value="${localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL}" class="settings-input" placeholder="e.g., gpt-4o, gemini-1.5-pro-latest"></div>
                </div>
                <div style="display: flex; gap: 20px; margin-top: 15px;">
                    <div style="flex: 1;"><label style="display: block; margin-bottom: 8px;">Temperature (0-2):</label><input type="number" id="temp-input" value="${localStorage.getItem(TEMP_STORAGE_KEY) || '1.0'}" step="0.1" min="0" max="2" class="settings-input"></div>
                    <div style="flex: 1;"><label style="display: block; margin-bottom: 8px;">Top P (0-1):</label><input type="number" id="topp-input" value="${localStorage.getItem(TOPP_STORAGE_KEY) || '1.0'}" step="0.1" min="0" max="1" class="settings-input"></div>
                </div>
                 <div style="margin-top: 15px;">
                    <label><input type="checkbox" id="auto-analyze-checkbox" ${isAutoAnalyzeEnabled ? 'checked' : ''}> <b>自動分析:</b> 當所有模型回應完成後自動進行統整。</label>
                </div>
            </div>
            <hr>
            <div>
                <h4 style="margin:0 0 8px;">API 金鑰設定</h4>
                <div><label>OpenAI API Key:</label><input type="password" id="openai-key-input" value="${localStorage.getItem(API_KEY_STORAGE_KEY_OPENAI) || ''}" class="settings-input"></div>
                <div style="margin-top: 10px;"><label>Gemini API Key:</label><input type="password" id="gemini-key-input" value="${localStorage.getItem(API_KEY_STORAGE_KEY_GEMINI) || ''}" class="settings-input"></div>
                <div style="margin-top: 10px;"><label>XAI / OpenAI-Compatible API Key:</label><input type="password" id="xai-key-input" value="${localStorage.getItem(API_KEY_STORAGE_KEY_XAI) || ''}" class="settings-input"></div>
            </div>
            <hr>
            <div>
                <div style="display:flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <h4 style="margin:0;">自定義提示詞</h4>
                    <button id="add-prompt-btn" class="small-btn">新增</button>
                </div>
                <div id="custom-prompts-list" style="max-height: 150px; overflow-y: auto; border: 1px solid #ccc; padding: 5px; border-radius: 4px;"></div>
            </div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            .settings-input { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 4px; border: 1px solid #ccc; }
            label { display: block; margin-bottom: 4px; font-size: 14px; color: #555; }
            hr { border: none; border-top: 1px solid #eee; margin: 15px 0; }
            .small-btn { padding: 4px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background-color: #f0f0f0; cursor: pointer; }
            .prompt-item { display: flex; justify-content: space-between; align-items: center; padding: 5px; border-bottom: 1px solid #eee; }
            .prompt-item:last-child { border-bottom: none; }
        `;
        contentNode.appendChild(style);

        // --- Custom Prompts Logic ---
        const promptsListDiv = contentNode.querySelector('#custom-prompts-list');
        const renderCustomPrompts = () => {
            promptsListDiv.innerHTML = '';
            const customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]');
            if (customPrompts.length === 0) {
                 promptsListDiv.innerHTML = '<span style="color: #999; font-size: 13px;">尚未新增自定義提示詞。</span>';
                 return;
            }
            customPrompts.forEach((prompt, index) => {
                const item = document.createElement('div');
                item.className = 'prompt-item';
                item.innerHTML = `<span>${prompt.title}</span><div>
                    <button class="small-btn edit-prompt-btn" data-index="${index}">編輯</button>
                    <button class="small-btn delete-prompt-btn" data-index="${index}" style="margin-left: 5px; background-color: #fcebeb; color: #c53030;">刪除</button>
                </div>`;
                promptsListDiv.appendChild(item);
            });
        };

        const editPrompt = (index = -1) => {
            const customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]');
            const prompt = index > -1 ? customPrompts[index] : { title: '', prompt: '' };
            const title = window.prompt('請輸入提示詞標題:', prompt.title);
            if (!title) return;
            const content = window.prompt(`請輸入提示詞內容 (for "${title}"):`, prompt.prompt);
            if (content === null) return;
            const newPrompt = { title, prompt: content };
            if (index > -1) {
                customPrompts[index] = newPrompt;
            } else {
                customPrompts.push(newPrompt);
            }
            localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(customPrompts));
            showSettingsWindow(); // Re-render the whole window
        };

        contentNode.querySelector('#add-prompt-btn').onclick = () => editPrompt();
        promptsListDiv.addEventListener('click', (e) => {
            if (e.target.classList.contains('edit-prompt-btn')) {
                editPrompt(parseInt(e.target.dataset.index));
            } else if (e.target.classList.contains('delete-prompt-btn')) {
                if (!confirm('確定要刪除這個提示詞嗎？')) return;
                const customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]');
                customPrompts.splice(parseInt(e.target.dataset.index), 1);
                localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(customPrompts));
                showSettingsWindow();
            }
        });

        renderCustomPrompts();

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 15px;`;
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999; margin-right: auto;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        const saveButton = document.createElement('button');
        saveButton.innerText = '儲存設定';
        saveButton.style.cssText = `padding: 8px 16px; border-radius: 6px; border: none; background-color: #28a745; color: white; cursor: pointer;`;
        saveButton.onclick = () => {
            localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
            localStorage.setItem(MODEL_STORAGE_KEY, contentNode.querySelector('#model-input').value);
            localStorage.setItem(TEMP_STORAGE_KEY, contentNode.querySelector('#temp-input').value);
            localStorage.setItem(TOPP_STORAGE_KEY, contentNode.querySelector('#topp-input').value);
            localStorage.setItem(API_KEY_STORAGE_KEY_OPENAI, contentNode.querySelector('#openai-key-input').value);
            localStorage.setItem(API_KEY_STORAGE_KEY_GEMINI, contentNode.querySelector('#gemini-key-input').value);
            localStorage.setItem(API_KEY_STORAGE_KEY_XAI, contentNode.querySelector('#xai-key-input').value);
            localStorage.setItem(AUTO_ANALYZE_STORAGE_KEY, contentNode.querySelector('#auto-analyze-checkbox').checked);
            hideWindow();
            alert(`設定已儲存！`);
        };

        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);
        createFloatingWindow('整合器設定', contentNode, {width: '600px', height: 'auto'});
    }

    function showToast(message) {
        let toast = document.getElementById('analyzer-toast');
        if (toast) toast.remove();
        toast = document.createElement('div');
        toast.id = 'analyzer-toast';
        toast.textContent = message;
        toast.style.cssText = `position: fixed; bottom: 100px; right: 200px; background-color: #28a745; color: white; padding: 12px 20px; border-radius: 8px; z-index: 10002; font-size: 14px; opacity: 0; transition: opacity 0.5s, transform 0.5s; transform: translateY(20px);`;
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
    }

    // NEW (Req #1): Desktop Notification
    function showDesktopNotification(title, body, onClick = () => {}) {
        if (!("Notification" in window)) return;
        const doNotify = () => {
            const notification = new Notification(title, { body });
            notification.onclick = () => {
                window.focus();
                onClick();
                notification.close();
            };
        };
        if (Notification.permission === "granted") {
            doNotify();
        } else if (Notification.permission !== "denied") {
            Notification.requestPermission().then(permission => {
                if (permission === "granted") doNotify();
            });
        }
    }


    // --- HELPERS & UTILITIES ---
    function makeDraggable(element, handle) { let p1=0,p2=0,p3=0,p4=0; handle.onmousedown=e=>{e.preventDefault();p3=e.clientX;p4=e.clientY;document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};document.onmousemove=e=>{e.preventDefault();p1=p3-e.clientX;p2=p4-e.clientY;p3=e.clientX;p4=e.clientY;element.style.top=(element.offsetTop-p2)+"px";element.style.left=(element.offsetLeft-p1)+"px";};};}
    function makeResizable(element, handle) { handle.onmousedown=e=>{e.preventDefault();const sX=e.clientX,sY=e.clientY,sW=parseInt(document.defaultView.getComputedStyle(element).width,10),sH=parseInt(document.defaultView.getComputedStyle(element).height,10);document.onmousemove=e=>{element.style.width=(sW+e.clientX-sX)+'px';element.style.height=(sH+e.clientY-sY)+'px';};document.onmouseup=()=>{document.onmousemove=null;document.onmouseup=null;};};}
    function formatMarkdownToHtml(markdownText) { if (!markdownText) return '無分析內容。'; let html = markdownText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); html = html.replace(/^### (.*$)/gim, '<h3 style="margin-bottom: 10px; margin-top: 20px; color: #333;">$1</h3>').replace(/^## (.*$)/gim, '<h2 style="margin-bottom: 15px; margin-top: 25px; border-bottom: 1px solid #eee; padding-bottom: 5px; color: #111;">$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/^\s*[-*] (.*$)/gim, '<li style="margin-bottom: 8px;">$1</li>'); html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>').replace(/(<li>.*?<\/li>)/g, '<ul style="padding-left: 20px; margin-top: 10px;">$1</ul>').replace(/<\/ul>\s*<ul>/g, ''); return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;}
    function getChatIdFromUrl() { const hash = window.location.hash; return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null; }
    // NEW (Req #8): Get merged prompts
    function getPrompts() {
        const customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]');
        return [...DEFAULT_PROMPTS, ...customPrompts];
    }

    // NEW (Req #5): Auto-analysis observer
    let analysisDebounceTimer;
    let wasGenerating = false;
    function setupAutoAnalysisObserver() {
        const observer = new MutationObserver((mutations) => {
            if (localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY) !== 'true') return;
            const mainButton = document.getElementById('analyzer-main-button');
            if(mainButton && mainButton.disabled) return; // Already analyzing

            const isGenerating = !!document.querySelector('button[aria-label="Stop generating"]');

            if (wasGenerating && !isGenerating) {
                // Generation just finished
                clearTimeout(analysisDebounceTimer);
                analysisDebounceTimer = setTimeout(() => {
                    console.log('自動分析已觸發');
                    showToast('自動分析已觸發...');
                    handleAnalysisRequest(true); // Treat as re-analysis to overwrite temp state
                }, 1500); // Wait 1.5s to ensure all streams are fully closed
            }
            wasGenerating = isGenerating;
        });

        const chatContainer = document.querySelector('#chat-container');
        if (chatContainer) {
            observer.observe(chatContainer, { childList: true, subtree: true });
        } else {
             setTimeout(setupAutoAnalysisObserver, 1000); // Retry if not found
        }
    }

    // --- INITIALIZATION ---
    async function initialize() {
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();

        let lastSeenChatId = null;
        setInterval(() => {
            const currentChatId = getChatIdFromUrl();
            if (currentChatId !== lastSeenChatId) {
                lastSeenChatId = currentChatId;
                wasGenerating = false; // Reset generation state on chat switch
                updateUIState();
            }
        }, 500);

        const uiObserver = new MutationObserver(() => {
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                createUI();
                setupAutoAnalysisObserver();
            }
        });
        uiObserver.observe(document.body, { childList: true, subtree: true });
    }

    initialize();

})();
