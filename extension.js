// ==UserScript==
// @name         TypingMind 對話分析與整合器
// @namespace    http://tampermonkey.net/
// @version      4.9  // 更新版本以反映UI修正
// @description  分析、整合並驗證 TypingMind 對話中的多模型回應，提供多金鑰、自訂提示詞、自動統整與 Win11 通知等功能。
// @author       Gemini & Your Name
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION (v4.6) ---
    const SCRIPT_VERSION = '4.9';  // 更新版本
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';

    // 金鑰儲存 (支援多模型)
    const KEY_OPENAI = 'typingmind_openai_key';
    const KEY_XAI = 'typingmind_xai_key';
    const KEY_GEMINI = 'typingmind_gemini_key';

    // 設定儲存
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';
    const TEMP_STORAGE_KEY = 'typingmind_analyzer_temperature';
    const TOPP_STORAGE_KEY = 'typingmind_analyzer_top_p';
    const REASONING_EFFORT_STORAGE_KEY = 'typingmind_analyzer_reasoning_effort';
    const PROMPT_STORAGE_KEY = 'typingmind_analyzer_prompt_title';
    const CUSTOM_PROMPTS_KEY = 'typingmind_customPrompts';
    const AUTO_ANALYZE_KEY = 'typingmind_autoAnalyze';


    // --- PROMPT LIBRARY (v4.6 - 支援自訂) ---
    let PROMPTS = [
        {
            title: "整合與驗證 (v3.0+)",
            prompt: `你是一位頂尖的專家級研究員與事實查核員。你的任務是基於使用者提出的「原始問題」，對提供的「多個AI模型的回答文字稿」進行分析與整合。同時，你也會收到一份「過去一次的統整報告」，請將其內容納入考量，進行增補、修正或迭代，以產生更完善的結果。

請嚴格遵循以下三段式結構，使用清晰的 Markdown 格式輸出你的最終報告。在報告中，請優先使用模型官方名稱。

### 1. 原始問題
(在此處簡潔地重述使用者提出的原始問題。)

### 2. AI模型比較
(在此處用一兩句話簡要總結哪個模型的回答總體上更佳，並陳述最核心的理由。)

### 3. 權威性統整回答 (最重要)
(這是報告的核心。請將所有模型回答中的正確、互補的資訊，以及「過去的統整報告」內容，進行嚴格的事實查核與交叉驗證後，融合成一份單一、全面、且權威性的最終答案。這份答案應該要超越任何單一模型的回答，成為使用者唯一需要閱讀的完整內容。如果不同模型存在無法調和的矛盾，請在此處明確指出。)`
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

    // 功能 8: 載入自訂提示詞
    try {
        const customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_KEY) || '[]');
        PROMPTS = [...customPrompts, ...PROMPTS];
    } catch (e) {
        console.error("無法解析自訂提示詞:", e);
    }


    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 3;  // 升級版本以支援遷移
    let db;


    // --- DATABASE HELPERS (v4.6 - 報告結構更新) ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                const oldVersion = event.oldVersion;
                let store;
                if (!dbInstance.objectStoreNames.contains(REPORT_STORE_NAME)) {
                    store = dbInstance.createObjectStore(REPORT_STORE_NAME, { keyPath: 'uuid' });
                    store.createIndex('chatIdIndex', 'chatId', { unique: false });
                } else {
                    store = event.target.transaction.objectStore(REPORT_STORE_NAME);
                }
                // 遷移邏輯：如果舊版本 < 3，將舊報告轉換為新結構
                if (oldVersion < 3) {
                    store.openCursor().onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (cursor) {
                            const report = cursor.value;
                            if (typeof report.report === 'string') {
                                report.report = { title: '舊報告 - ' + new Date(report.timestamp).toLocaleString(), content: report.report };
                                cursor.update(report);
                            }
                            cursor.continue();
                        }
                    };
                }
            };
            request.onerror = (event) => reject(`資料庫錯誤: ${event.target.errorCode}`);
            request.onsuccess = (event) => {
                db = event.target.result;
                resolve(db);
            };
        });
    }

    // 功能 3: 報告儲存結構更新 (包含標題)
    function saveReport(chatId, reportObject) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction([REPORT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const report = {
                uuid: self.crypto.randomUUID(),
                chatId: chatId,
                report: reportObject, // reportObject is { title, content }
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


    // --- UI CREATION & STATE MANAGEMENT (學習v3.1寫法) ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;

        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        // 學習v3.1位置：bottom: 20px; right: 20px;
        container.style.cssText = `position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;

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


    // --- CORE LOGIC (v4.6 - 重構以支援新功能) ---
    async function handleAnalysisRequest(isReanalysis = false, isAuto = false) {
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

            if (!isReanalysis && !isAuto) {
                const reports = await getReportsForChat(chatId);
                if (reports.length > 0) {
                    showReportListWindow(reports);
                    return;
                }
            }
            
            // 取得對話資料
            const { messages, modelMap } = await getTypingMindChatHistory();
            if (messages.length < 2) { throw new Error('當前對話訊息不足，無法進行分析。'); }

            // 功能 4: 僅統整「上一輪 + 上次總結」
            const lastUserIdx = messages.map(m=>m.role).lastIndexOf('user');
            const lastUserTurn = messages[lastUserIdx];
            const aiTurns = [];
            for (let i = lastUserIdx + 1; i < messages.length && messages[i].role !== 'user'; i++){
                aiTurns.push(messages[i]);
            }
            if (aiTurns.length === 0) {
                throw new Error('最新的使用者問題後沒有任何 AI 回應，無法分析。');
            }
            const pastReports = await getReportsForChat(chatId);
            const prevSummary = pastReports[0]?.report.content ?? ''; // 使用新結構

            // 功能 3: 產生報告標題
            const now = new Date();
            const yyyy = now.getFullYear();
            const MM = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const lastUserQuestionContent = (typeof lastUserTurn.content === 'string' ? lastUserTurn.content : JSON.stringify(lastUserTurn.content)) || '';
            const title = `${lastUserQuestionContent.slice(0, 15)}... - ${yyyy}-${MM}-${dd} ${hh}:${mm}`;

            const startTime = Date.now();
            const analysisResult = await analyzeConversation(lastUserTurn, aiTurns, prevSummary, modelMap);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            let footer = `\n\n---\n*報告生成於 ${yyyy}-${MM}-${dd} ${hh}:${mm}，耗時：${duration} 秒*`;
            if (analysisResult.usage) {
                footer += `\n\n*Token 消耗：輸入 ${analysisResult.usage.prompt_tokens}, 輸出 ${analysisResult.usage.completion_tokens}, 總計 ${analysisResult.usage.total_tokens}*`;
            }

            const reportObject = {
                title: title,
                content: analysisResult.content + footer
            };

            await saveReport(chatId, reportObject);
            showToast('總結已完成！');
            showReportWindow(reportObject);

        } catch (error) {
            console.error('分析擴充程式錯誤:', error);
            if (!isAuto) { // 自動分析時不跳 alert
                alert(`發生錯誤: ${error.message}`);
            }
        } finally {
            if (mainButton) {
                mainButton.disabled = false;
                updateUIState();
            }
        }
    }


    // --- DATA RETRIEVAL (v3.1 - 無變更) ---
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

    // --- LLM INTERACTION (v4.6 - 支援多金鑰與新Prompt結構) ---
    async function analyzeConversation(lastUserTurn, aiTurns, prevSummary, modelMap) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
        const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
        const reasoningEffort = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY);
        const selectedPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || PROMPTS[0].title;
        const systemPrompt = PROMPTS.find(p => p.title === selectedPromptTitle)?.prompt || PROMPTS[0].prompt;

        // 功能 7: 根據模型名稱選擇金鑰與API端點
        const { apiKey, apiUrl } = pickApiKeyAndEndpoint(model);
        if (!apiKey) {
            throw new Error(`未設定 ${model} 對應的 API 金鑰，請至設定中新增。`);
        }

        const stringifyContent = (content) => {
            if (content === null || content === undefined) return '';
            if (typeof content === 'string') return content;
            return JSON.stringify(content, null, 2);
        };
        
        // 使用新傳入的參數組合 Prompt
        const lastUserQuestion = stringifyContent(lastUserTurn.content) || '未找到原始問題。';
        const transcript = aiTurns.map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');
        
        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) {
            modelMapInfo += `- ${id}: ${modelMap[id]}\n`;
        }

        const userContentForAnalyzer = `${modelMapInfo}
--- 原始問題 ---
${lastUserQuestion}

--- 本輪模型回答 ---
${transcript}

--- 過去一次統整報告 ---
${prevSummary || '這是第一次統整，沒有過去的報告。'}
`;
        
        let response;
        let content;
        let usage = null;

        if (model.startsWith('gemini:')) {
            // Gemini專屬處理
            const geminiModel = model.replace('gemini:', '');
            const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
            const geminiBody = {
                contents: [
                    { role: 'user', parts: [{ text: systemPrompt }] },
                    { role: 'model', parts: [{ text: 'OK' }] },  // 模擬system prompt
                    { role: 'user', parts: [{ text: userContentForAnalyzer }] }
                ],
                generationConfig: {
                    temperature: temperature,
                    topP: top_p
                }
            };
            response = await fetch(geminiApiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiBody)
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Gemini API 錯誤: ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
            }
            const data = await response.json();
            content = data.candidates[0].content.parts[0].text;
            usage = data.usageMetadata ? { prompt_tokens: data.usageMetadata.promptTokenCount, completion_tokens: data.usageMetadata.candidatesTokenCount, total_tokens: data.usageMetadata.totalTokenCount } : null;
        } else {
            // OpenAI / x.ai 處理
            const requestBody = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }], temperature, top_p };
            if (model.startsWith('xai:') && reasoningEffort) {  // 只在xai模型使用
                requestBody.reasoning_effort = reasoningEffort;
            }
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
            }
            const data = await response.json();
            if (!data.choices || !data.choices[0].message) {
                throw new Error('API 回應結構無效。');
            }
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

    // 功能 2 & 3: 顯示報告視窗 (使用報告物件，並加入複製按鈕)
    function showReportWindow(reportObject) {
        const contentNode = document.createElement('div');
        
        // 功能 2: 「複製統整回答」按鈕
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 複製權威性統整回答';
        copyBtn.style.cssText = 'margin-bottom: 15px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background-color: #e9ecef; cursor: pointer;';
        copyBtn.onclick = () => {
            const reportText = reportObject.content;
            const match = reportText.match(/### 3\. 權威性統整回答.*?(?=(###|---|$))/s);
            const textToCopy = match ? match[0].trim() : reportText;
            navigator.clipboard.writeText(textToCopy).then(() => {
                showToast('已複製統整部分！');
            }, () => {
                showToast('複製失敗！');
            });
        };
        contentNode.appendChild(copyBtn);

        const reportContentDiv = document.createElement('div');
        reportContentDiv.innerHTML = formatMarkdownToHtml(reportObject.content);
        contentNode.appendChild(reportContentDiv);

        createFloatingWindow(reportObject.title, contentNode); // 功能 3: 使用帶時間的標題
    }
    
    // 功能 3: 顯示歷史報告列表 (使用報告標題)
    function showReportListWindow(reports) {
        const contentNode = document.createElement('div');
        let listHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
        reports.forEach(report => {
            // 使用 report.report.title 作為列表項的顯示文字
            const displayTitle = report.report.title || new Date(report.timestamp).toLocaleString();
            listHtml += `<li data-uuid="${report.uuid}" title="${displayTitle}" style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayTitle}</li>`;
        });
        listHtml += '</ul>';
        contentNode.innerHTML = listHtml;
        contentNode.querySelectorAll('li').forEach(li => {
            li.onmouseover = () => li.style.backgroundColor = '#f0f0f0';
            li.onmouseout = () => li.style.backgroundColor = 'transparent';
            li.onclick = () => {
                const selectedReport = reports.find(r => r.uuid === li.dataset.uuid);
                if (selectedReport) showReportWindow(selectedReport.report); // 傳遞整個 report object
            };
        });
        createFloatingWindow('歷史報告清單', contentNode, { height: '400px', width: '400px' });
    }

    // 功能 5, 7, 8: 全新的設定視窗
    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        const currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const currentTemp = localStorage.getItem(TEMP_STORAGE_KEY) || '1.0';
        const currentTopP = localStorage.getItem(TOPP_STORAGE_KEY) || '1.0';
        const currentReasoning = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY) || 'High';
        const currentPrompt = localStorage.getItem(PROMPT_STORAGE_KEY) || PROMPTS[0].title;
        const openaiKey = localStorage.getItem(KEY_OPENAI) || '';
        const xaiKey = localStorage.getItem(KEY_XAI) || '';
        const geminiKey = localStorage.getItem(KEY_GEMINI) || '';
        const autoAnalyze = localStorage.getItem(AUTO_ANALYZE_KEY) !== 'false';

        let promptOptions = '';
        PROMPTS.forEach(p => {
            promptOptions += `<option value="${p.title}" ${p.title === currentPrompt ? 'selected' : ''}>${p.title}</option>`;
        });
        
        contentNode.innerHTML = `
            <style>
              .settings-label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
              .settings-input, .settings-select { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-bottom: 15px; }
              .settings-flex { display: flex; gap: 20px; }
              .settings-flex > div { flex: 1; }
              .settings-section-title { font-size: 1.1em; font-weight: bold; margin-top: 20px; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #eee; }
            </style>
            
            <div class="settings-section-title">主要設定</div>
            <div><label class="settings-label">分析模式 (提示詞):</label><select id="prompt-select" class="settings-select">${promptOptions}</select></div>
            <div><label for="model-input" class="settings-label">分析模型名稱:</label><input type="text" id="model-input" value="${currentModel}" placeholder="例如: gpt-4o, xai:claude-3-opus, gemini:gemini-1.5-pro" class="settings-input"></div>
            <div><label for="reasoning-input" class="settings-label">Reasoning Effort:</label><input type="text" id="reasoning-input" value="${currentReasoning}" placeholder="例如: High, Medium, Auto" class="settings-input"></div>
            <div class="settings-flex">
                <div><label for="temp-input" class="settings-label">Temperature (0-2):</label><input type="number" id="temp-input" value="${currentTemp}" step="0.1" min="0" max="2" class="settings-input"></div>
                <div><label for="topp-input" class="settings-label">Top P (0-1):</label><input type="number" id="topp-input" value="${currentTopP}" step="0.1" min="0" max="1" class="settings-input"></div>
            </div>

            <div class="settings-section-title">API 金鑰 (功能 7)</div>
            <div><label for="openai-key" class="settings-label">OpenAI API Key:</label><input type="password" id="openai-key" value="${openaiKey}" class="settings-input"></div>
            <div><label for="xai-key" class="settings-label">XAI/Grok API Key (模型名稱以 "xai:" 開頭):</label><input type="password" id="xai-key" value="${xaiKey}" class="settings-input"></div>
            <div><label for="gemini-key" class="settings-label">Google Gemini API Key (模型名稱以 "gemini:" 開頭):</label><input type="password" id="gemini-key" value="${geminiKey}" class="settings-input"></div>

            <div class="settings-section-title">進階功能</div>
            <div><label class="settings-label" style="display:inline-flex; align-items:center; width: 100%;"><input type="checkbox" id="auto-analyze" ${autoAnalyze ? 'checked' : ''} style="margin-right: 10px;">啟用自動統整 (功能 5)</label></div>
        `;

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: space-between; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 15px;`;
        
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;

        const rightButtons = document.createElement('div');
        rightButtons.style.cssText = 'display: flex; gap: 10px;';

        const addPromptBtn = document.createElement('button');
        addPromptBtn.innerText = '➕ 新增提示詞';
        addPromptBtn.style.cssText = `padding: 8px 16px; border-radius: 6px; border: 1px solid #007bff; background-color: white; color: #007bff; cursor: pointer;`;
        addPromptBtn.onclick = () => {
            const title = prompt('請輸入新提示詞的標題:');
            if (!title) return;
            const p = prompt(`請輸入 "${title}" 的完整提示詞內容:`);
            if (p) {
                const arr = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_KEY) || '[]');
                arr.unshift({ title: title, prompt: p });
                localStorage.setItem(CUSTOM_PROMPTS_KEY, JSON.stringify(arr));
                alert('已新增！請關閉並重新開啟設定視窗以查看。');
            }
        };

        const saveButton = document.createElement('button');
        saveButton.innerText = '儲存';
        saveButton.style.cssText = `padding: 8px 16px; border-radius: 6px; border: none; background-color: #28a745; color: white; cursor: pointer;`;
        saveButton.onclick = () => {
            localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
            localStorage.setItem(MODEL_STORAGE_KEY, contentNode.querySelector('#model-input').value);
            localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, contentNode.querySelector('#reasoning-input').value);
            localStorage.setItem(TEMP_STORAGE_KEY, contentNode.querySelector('#temp-input').value);
            localStorage.setItem(TOPP_STORAGE_KEY, contentNode.querySelector('#topp-input').value);
            localStorage.setItem(KEY_OPENAI, contentNode.querySelector('#openai-key').value);
            localStorage.setItem(KEY_XAI, contentNode.querySelector('#xai-key').value);
            localStorage.setItem(KEY_GEMINI, contentNode.querySelector('#gemini-key').value);
            localStorage.setItem(AUTO_ANALYZE_KEY, contentNode.querySelector('#auto-analyze').checked);
            hideWindow();
            alert(`設定已儲存！`);
        };
        
        rightButtons.appendChild(addPromptBtn);
        rightButtons.appendChild(saveButton);
        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(rightButtons);
        contentNode.appendChild(buttonContainer);

        createFloatingWindow('設定', contentNode, {width: '600px', height: 'auto'});
    }
    
    // 功能 1: Win 11 通知
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

        // 新增系統通知
        if (window.Notification) {
            if (Notification.permission === 'granted') {
                new Notification('TypingMind 統整通知', { body: message });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(p => {
                    if (p === 'granted') {
                        new Notification('TypingMind 統整通知', { body: message });
                    }
                });
            }
        }
    }


    // --- HELPERS ---
    function pickApiKeyAndEndpoint(modelName) {
        // Gemini API endpoint is special and handled by caller
        if (modelName.startsWith('xai:')) {
            return { apiKey: localStorage.getItem(KEY_XAI), apiUrl: 'https://api.x.ai/v1/chat/completions' };
        }
        if (modelName.startsWith('gemini:')) {
            // Note: Gemini API requires key in URL, this is a placeholder. Actual fetch must construct it.
            // Let's simplify and handle it here completely.
            const geminiKey = localStorage.getItem(KEY_GEMINI);
            return { apiKey: geminiKey, apiUrl: '' };  // apiUrl在analyzeConversation中動態構建
        }
        // Default to OpenAI
        return { apiKey: localStorage.getItem(KEY_OPENAI), apiUrl: 'https://api.openai.com/v1/chat/completions' };
    }

    function makeDraggable(element, handle) { let p1=0,p2=0,p3=0,p4=0; handle.onmousedown=e=>{e.preventDefault();p3=e.clientX;p4=e.clientY;document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};document.onmousemove=e=>{e.preventDefault();p1=p3-e.clientX;p2=p4-e.clientY;p3=e.clientX;p4=e.clientY;element.style.top=(element.offsetTop-p2)+"px";element.style.left=(element.offsetLeft-p1)+"px";};};}
    function makeResizable(element, handle) { handle.onmousedown=e=>{e.preventDefault();const sX=e.clientX,sY=e.clientY,sW=parseInt(document.defaultView.getComputedStyle(element).width,10),sH=parseInt(document.defaultView.getComputedStyle(element).height,10);document.onmousemove=e=>{element.style.width=(sW+e.clientX-sX)+'px';element.style.height=(sH+e.clientY-sY)+'px';};document.onmouseup=()=>{document.onmousemove=null;document.onmouseup=null;};};}
    function formatMarkdownToHtml(markdownText) { 
        if (!markdownText) return '無分析內容。'; 
        let html = markdownText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); 
        html = html.replace(/^### (.*$)/gim, '<h3 style="margin-bottom: 10px; margin-top: 20px; color: #333;">$1</h3>')
                   .replace(/^## (.*$)/gim, '<h2 style="margin-bottom: 15px; margin-top: 25px; border-bottom: 1px solid #eee; padding-bottom: 5px; color: #111;">$1</h2>')
                   .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                   .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                   .replace(/\*(.*?)\*/g, '<em>$1</em>')
                   .replace(/^\s*[-*] (.*$)/gim, '<li style="margin-bottom: 8px;">$1</li>')
                   .replace(/^\s*```(\w+)?\n([\s\S]*?)\n```/gim, '<pre style="background: #f4f4f4; padding: 10px; border-radius: 5px;"><code>$2</code></pre>')
                   .replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" style="color: #007bff; text-decoration: none;">$1</a>');
        html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>').replace(/(<li>.*?<\/li>)/g, '<ul style="padding-left: 20px; margin-top: 10px;">$1</ul>').replace(/<\/ul>\s*<ul>/g, ''); 
        return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;
    }
    function getChatIdFromUrl() { const hash = window.location.hash; return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null; }
    
    // --- INITIALIZATION (學習v3.1的初始化邏輯) ---
    async function initialize() {
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();
        
        // More robust state update logic (from v3.1)
        let lastSeenChatId = null;
        setInterval(() => {
            const currentChatId = getChatIdFromUrl();
            if (currentChatId !== lastSeenChatId) {
                lastSeenChatId = currentChatId;
                updateUIState();
            }
        }, 500); // Check every 500ms

        // UI Creation trigger (from v3.1)
        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                createUI();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // UI Creation and Auto-analysis trigger
        let autoAnalyzeTimeout = null;
        let lastMessageCount = 0;  // 用於fallback偵測
        const autoObserver = new MutationObserver((mutations) => {
            // 在Observer中額外檢查UI
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                createUI();
                console.log('UI 已透過autoObserver創建');
            }
            
            // 功能 5: 自動統整
            const autoAnalyzeEnabled = localStorage.getItem(AUTO_ANALYZE_KEY) !== 'false';
            if (!autoAnalyzeEnabled) return;

            for(const mutation of mutations) {
                if (mutation.type === 'childList') {
                    // 原SVG偵測
                    const generatingSvg = document.querySelector('[d="M12 4.5v3m0 9v3m4.5-10.5l-2.12 2.12M6.62 17.38l-2.12 2.12M19.5 12h-3m-9 0H3M17.38 6.62l-2.12 2.12M6.62 6.62l2.12 2.12"]');
                    // fallback: 檢查是否有generating class或Stop按鈕（假設TypingMind使用）
                    const generatingClass = document.querySelector('.generating, [title*="Stop"], [aria-label*="generating"]');  // 相容不同版本
                    const isGenerating = generatingSvg || generatingClass;
                    const mainButton = document.getElementById('analyzer-main-button');
                    
                    // fallback: 檢查訊息長度變化
                    const currentMessageCount = document.querySelectorAll('.message').length;  // 假設聊天訊息有.message class
                    const messagesChanged = currentMessageCount > lastMessageCount;
                    lastMessageCount = currentMessageCount;

                    // If we detect a change AND the generating spinner is gone, it might be complete.
                    if (!isGenerating && mainButton && !mainButton.disabled && messagesChanged) {
                        clearTimeout(autoAnalyzeTimeout);
                        autoAnalyzeTimeout = setTimeout(() => {
                            // Double check if it's really finished before triggering
                            if (!document.querySelector('[d="M12 4.5v3m0 9v3m4.5-10.5l-2.12 2.12M6.62 17.38l-2.12 2.12M19.5 12h-3m-9 0H3M17.38 6.62l-2.12 2.12M6.62 6.62l2.12 2.12"]') && !generatingClass) {
                                console.log("自動統整觸發...");
                                handleAnalysisRequest(false, true);
                            }
                        }, 2500); // Wait 2.5 seconds to be sure
                    }
                }
            }
        });
        autoObserver.observe(document.body, { childList: true, subtree: true });
    }

    initialize();

})();
