// ==UserScript==
// @name         TypingMind Multi-AI Integrator v4.0
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  分析、整合並驗證 TypingMind 對話中的多模型回應。支援 OpenAI, Gemini, XAI 模型，提供系統通知、自動分析、自訂提示詞、版本化歷史報告及可自訂參數的懸浮視窗介面。
// @author       Gemini & Human-Collaborator
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const SCRIPT_VERSION = '4.0';
    const SETTINGS_STORAGE_KEY = 'typingmind_analyzer_settings_v4';

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const CUSTOM_PROMPT_STORE_NAME = 'custom_prompts';
    const DB_VERSION = 3; // Bump version for new object store
    let db;

    // --- DEFAULT SETTINGS & PROMPTS ---
    const DEFAULT_SETTINGS = {
        providers: {
            openai: { apiKey: '', model: 'gpt-4o' },
            gemini: { apiKey: '', model: 'gemini-1.5-pro-latest' },
            xai: { apiKey: '', model: 'grok-4' }
        },
        analyzerProvider: 'openai',
        temperature: 1.0,
        top_p: 1.0,
        reasoning_effort: 'High',
        promptTitle: "整合與驗證 (v4.0+)",
        autoAnalyze: false,
        notificationsEnabled: null // null: not asked, true: granted, false: denied
    };

    const PROMPTS =;

    let settings = {};
    let customPrompts =;

    // --- DATABASE HELPERS ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const dbInstance = event.target.result;
                if (!dbInstance.objectStoreNames.contains(REPORT_STORE_NAME)) {
                    const reportStore = dbInstance.createObjectStore(REPORT_STORE_NAME, { keyPath: 'uuid' });
                    reportStore.createIndex('chatIdIndex', 'chatId', { unique: false });
                }
                if (!dbInstance.objectStoreNames.contains(CUSTOM_PROMPT_STORE_NAME)) {
                    dbInstance.createObjectStore(CUSTOM_PROMPT_STORE_NAME, { keyPath: 'uuid' });
                }
            };
            request.onerror = (event) => reject(`資料庫錯誤: ${event.target.errorCode}`);
            request.onsuccess = (event) => {
                db = event.target.result;
                resolve(db);
            };
        });
    }

    // --- CRUD for Reports ---
    function saveReport(chatId, title, reportData) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction(, 'readwrite');
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
            const transaction = db.transaction(, 'readonly');
            const store = transaction.objectStore(REPORT_STORE_NAME);
            const index = store.index('chatIdIndex');
            const request = index.getAll(chatId);
            request.onsuccess = () => resolve(request.result.sort((a, b) => b.timestamp - a.timestamp));
            request.onerror = (event) => reject(`讀取報告失敗: ${event.target.error}`);
        });
    }

    // --- CRUD for Custom Prompts ---
    async function loadCustomPrompts() {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction(, 'readonly');
            const store = transaction.objectStore(CUSTOM_PROMPT_STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                customPrompts = request.result;
                resolve(customPrompts);
            };
            request.onerror = (event) => reject(`讀取自訂提示詞失敗: ${event.target.error}`);
        });
    }

    function saveCustomPrompt(prompt) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction(, 'readwrite');
            const store = transaction.objectStore(CUSTOM_PROMPT_STORE_NAME);
            const request = store.put(prompt); // put will add or update
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(`儲存自訂提示詞失敗: ${event.target.error}`);
        });
    }

    function deleteCustomPrompt(uuid) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('資料庫未初始化。');
            const transaction = db.transaction(, 'readwrite');
            const store = transaction.objectStore(CUSTOM_PROMPT_STORE_NAME);
            const request = store.delete(uuid);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(`刪除自訂提示詞失敗: ${event.target.error}`);
        });
    }

    // --- SETTINGS MANAGEMENT ---
    function loadSettings() {
        const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
        settings = savedSettings? JSON.parse(savedSettings) : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        // Merge to ensure new settings are added
        settings = {...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),...settings };
    }

    function saveSettings() {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }

    // --- UI CREATION & STATE MANAGEMENT ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;

        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        // Requirement 6: Adjust button position
        container.style.cssText = `position: fixed; bottom: 85px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;

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

        // Requirement 5: Auto-analysis toggle
        const autoAnalyzeLabel = document.createElement('label');
        autoAnalyzeLabel.style.cssText = `display: flex; align-items: center; gap: 5px; font-size: 12px; color: #555; background-color: #f0f0f0; padding: 4px 8px; border-radius: 12px; cursor: pointer;`;
        const autoAnalyzeCheckbox = document.createElement('input');
        autoAnalyzeCheckbox.type = 'checkbox';
        autoAnalyzeCheckbox.id = 'auto-analyze-toggle';
        autoAnalyzeCheckbox.checked = settings.autoAnalyze;
        autoAnalyzeCheckbox.onchange = (e) => {
            settings.autoAnalyze = e.target.checked;
            saveSettings();
            showToast(`自動分析已${e.target.checked? '開啟' : '關閉'}`);
        };
        autoAnalyzeLabel.appendChild(autoAnalyzeCheckbox);
        autoAnalyzeLabel.append('自動');

        container.appendChild(reanalyzeButton);
        container.appendChild(mainButton);
        container.appendChild(autoAnalyzeLabel);
        container.appendChild(settingsButton);
        document.body.appendChild(container);
        updateUIState();
    }

    async function updateUIState() {
        const mainButton = document.getElementById('analyzer-main-button');
        if (!mainButton |

| mainButton.disabled) return;
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
        const analysisTimestamp = new Date(); // Requirement 3: Capture timestamp on click

        try {
            if (mainButton) {
                mainButton.innerHTML = '分析中... 🤖';
                mainButton.disabled = true;
                if (reanalyzeButton) reanalyzeButton.style.display = 'none';
            }

            const chatId = getChatIdFromUrl();
            if (!chatId) { throw new Error('無法獲取對話 ID。'); }

            if (!isReanalysis) {
                const reports = await getReportsForChat(chatId);
                if (reports.length > 0) {
                    showReportListWindow(reports);
                    return;
                }
            }
            
            const provider = settings.analyzerProvider;
            const apiKey = settings.providers[provider]?.apiKey;
            if (!apiKey) {
                throw new Error(`未設定 ${provider.toUpperCase()} 的 API 金鑰。請前往設定頁面新增。`);
            }

            // Requirement 4: Refined analysis scope
            const { lastUserQuestion, recentAssistantMessages, modelMap } = await getTypingMindChatHistory();
            if (recentAssistantMessages.length === 0) { throw new Error('找不到最新的 AI 模型回答，無法進行分析。'); }

            const reports = await getReportsForChat(chatId);
            const previousSummary = reports.length > 0? reports.report : null;

            const startTime = Date.now();
            const analysisResult = await analyzeConversation(apiKey, provider, lastUserQuestion, recentAssistantMessages, modelMap, previousSummary);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);

            let footer = `\n\n---\n*報告生成耗時：${duration} 秒*`;
            if (analysisResult.usage) {
                const { prompt_tokens, completion_tokens, total_tokens } = analysisResult.usage;
                footer += `\n\n*Token 消耗：輸入 ${prompt_tokens}, 輸出 ${completion_tokens}, 總計 ${total_tokens}*`;
            }
            const finalReportText = analysisResult.content + footer;

            // Requirement 3: Generate new report title
            const questionSummary = lastUserQuestion.substring(0, 15);
            const formattedTime = analysisTimestamp.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(' ', ' @ ');
            const reportTitle = `${questionSummary}... (${formattedTime})`;

            await saveReport(chatId, reportTitle, finalReportText);
            
            // Requirement 1: Show notifications
            showToast('總結已完成！');
            showSystemNotification('分析已完成', `您的 TypingMind 整合報告已準備就緒。`);

            showReportWindow(reportTitle, finalReportText);

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
                
                const transaction = tmDb.transaction(['keyval'], 'readonly');
                const objectStore = transaction.objectStore('keyval');
                const getRequest = objectStore.get(`CHAT_${chatId}`);
                
                getRequest.onerror = () => reject(new Error('讀取聊天資料出錯。'));
                getRequest.onsuccess = () => {
                    const chatData = getRequest.result;
                    if (!chatData ||!chatData.messages) return reject(new Error(`找不到對應的聊天資料。`));

                    // Requirement 4: Logic to get ONLY the last user question and subsequent AI answers.
                    let lastUserMessageIndex = -1;
                    for (let i = chatData.messages.length - 1; i >= 0; i--) {
                        if (chatData.messages[i].role === 'user') {
                            lastUserMessageIndex = i;
                            break;
                        }
                    }

                    if (lastUserMessageIndex === -1) {
                        return resolve({ lastUserQuestion: '未找到使用者問題。', recentAssistantMessages:, modelMap: {} });
                    }

                    const lastUserMessage = chatData.messages[lastUserMessageIndex];
                    const subsequentTurn = chatData.messages[lastUserMessageIndex + 1];
                    const stringifyContent = (content) => typeof content === 'string'? content : JSON.stringify(content, null, 2);
                    const lastUserQuestion = stringifyContent(lastUserMessage.content);

                    const recentAssistantMessages =;
                    const modelMap = {};

                    if (chatData.model && chatData.modelInfo) {
                        modelMap = chatData.modelInfo.title |

| chatData.model;
                    }

                    if (subsequentTurn) {
                        if (subsequentTurn.type === 'tm_multi_responses' && subsequentTurn.responses) {
                            for (const response of subsequentTurn.responses) {
                                if (response.model && response.modelInfo) {
                                    modelMap[response.model] = response.modelInfo.title |

| response.model;
                                }
                                if (response.messages && response.model) {
                                    recentAssistantMessages.push(...response.messages.map(msg => ({...msg, model: response.model })));
                                }
                            }
                        } else if (subsequentTurn.role === 'assistant') {
                            recentAssistantMessages.push(subsequentTurn);
                        }
                    }
                    
                    resolve({ lastUserQuestion, recentAssistantMessages, modelMap });
                };
            };
        });
    }

    // --- LLM INTERACTION ---
    async function analyzeConversation(apiKey, provider, lastUserQuestion, assistantMessages, modelMap, previousSummary) {
        const model = settings.providers[provider]?.model;
        const selectedPromptObj =.find(p => p.title === settings.promptTitle);
        const systemPrompt = selectedPromptObj? selectedPromptObj.prompt : PROMPTS.prompt;

        const stringifyContent = (content) => (content === null |

| content === undefined)? '' : (typeof content === 'string'? content : JSON.stringify(content, null, 2));

        const transcript = assistantMessages.map(msg => `--- 模型回答 (ID: ${msg.model |

| 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');
        
        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) {
            modelMapInfo += `- ${id}: ${modelMap[id]}\n`;
        }

        let userContentForAnalyzer = `${modelMapInfo}\n--- 上一輪問題 ---\n${lastUserQuestion}\n\n--- 多個AI模型的最新回答 ---\n${transcript}`;
        if (previousSummary) {
            userContentForAnalyzer += `\n\n--- 過去的總結 (請參考此內容進行更新與擴充) ---\n${previousSummary}`;
        }

        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }];
        return await unifiedApiCall(provider, apiKey, model, messages);
    }

    // Requirement 7: Unified API call function
    async function unifiedApiCall(provider, apiKey, model, messages) {
        let endpoint = '';
        let headers = {};
        let body = {};

        const { temperature, top_p, reasoning_effort } = settings;

        switch (provider) {
            case 'gemini':
                endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                headers = { 'Content-Type': 'application/json' };
                // Convert OpenAI message format to Gemini format
                body = {
                    contents: messages.map(msg => ({
                        role: msg.role === 'assistant'? 'model' : msg.role,
                        parts: [{ text: msg.content }]
                    })),
                    generationConfig: { temperature, topP: top_p }
                };
                break;
            
            case 'xai':
                endpoint = 'https://api.x.ai/v1/chat/completions';
                headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
                body = { model, messages, temperature, top_p };
                break;

            case 'openai':
            default:
                endpoint = 'https://api.openai.com/v1/chat/completions';
                headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
                body = { model, messages, temperature, top_p };
                if (reasoning_effort) body.reasoning_effort = reasoning_effort;
                break;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json();
            const errorMessage = errorData.error?.message?? JSON.stringify(errorData);
            throw new Error(`API 錯誤 (${provider}/${model}): ${response.status} - ${errorMessage}`);
        }
        
        const data = await response.json();

        // Normalize response
        let content = '';
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        switch (provider) {
            case 'gemini':
                content = data.candidates?.?.content?.parts?.?.text?? '';
                if (data.usageMetadata) {
                    usage = {
                        prompt_tokens: data.usageMetadata.promptTokenCount,
                        completion_tokens: data.usageMetadata.candidatesTokenCount,
                        total_tokens: data.usageMetadata.totalTokenCount
                    };
                }
                break;

            case 'xai':
            case 'openai':
            default:
                content = data.choices?.?.message?.content?? '';
                if (data.usage) {
                    usage = {
                        prompt_tokens: data.usage.prompt_tokens,
                        completion_tokens: data.usage.completion_tokens,
                        total_tokens: data.usage.total_tokens
                    };
                }
                break;
        }
        return { content, usage };
    }

    // --- UI (FLOATING WINDOW & TOAST & NOTIFICATION) ---
    function createFloatingWindow(title, contentNode, options = {}) {
        hideWindow();
        const windowEl = document.createElement('div');
        windowEl.id = 'analyzer-window';
        windowEl.style.cssText = `position: fixed; top: ${options.top |

| '50px'}; left: ${options.left |
| '50px'}; width: ${options.width |
| '600px'}; height: ${options.height |
| '700px'}; z-index: 10001; background-color: #fff; border: 1px solid #ccc; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;`;

        const header = document.createElement('div');
        header.style.cssText = `background-color: #f0f0f0; padding: 8px 12px; cursor: move; border-bottom: 1px solid #ccc; display: flex; justify-content: space-between; align-items: center; user-select: none;`;
        
        const titleEl = document.createElement('span');
        titleEl.textContent = title;
        titleEl.style.fontWeight = 'bold';
        titleEl.style.whiteSpace = 'nowrap';
        titleEl.style.overflow = 'hidden';
        titleEl.style.textOverflow = 'ellipsis';
        titleEl.title = title;

        const headerControls = document.createElement('div');
        headerControls.style.cssText = 'display: flex; align-items: center; gap: 10px;';

        // Requirement 2: Add copy summary button
        if (options.showCopyButton) {
            const copyButton = document.createElement('button');
            copyButton.innerText = '複製統整';
            copyButton.title = '僅複製「權威性統整回答」部分的內容';
            copyButton.style.cssText = 'padding: 3px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background-color: #e9e9e9; cursor: pointer;';
            copyButton.onclick = () => {
                const summarySection = contentNode.querySelector('#analyzer-summary-section');
                if (summarySection) {
                    navigator.clipboard.writeText(summarySection.innerText)
                       .then(() => {
                            copyButton.innerText = '已複製!';
                            setTimeout(() => { copyButton.innerText = '複製統整'; }, 2000);
                        })
                       .catch(err => alert('複製失敗: ' + err));
                } else {
                    alert('找不到可複製的統整內容。');
                }
            };
            headerControls.appendChild(copyButton);
        }

        const closeButton = document.createElement('button');
        closeButton.innerHTML = '&times;';
        closeButton.style.cssText = `background: none; border: none; font-size: 20px; cursor: pointer;`;
        closeButton.onclick = hideWindow;
        headerControls.appendChild(closeButton);

        header.appendChild(titleEl);
        header.appendChild(headerControls);

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

    function showReportWindow(title, reportText) {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = formatMarkdownToHtml(reportText);
        createFloatingWindow(title, contentNode, { showCopyButton: true });
    }
    
    function showReportListWindow(reports) {
        const contentNode = document.createElement('div');
        let listHtml = '<ul style="list-style: none; padding: 0; margin: 0;">';
        reports.forEach(report => {
            listHtml += `<li data-uuid="${report.uuid}" style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; transition: background-color 0.2s;">${report.title |

| '歷史報告'}</li>`;
        });
        listHtml += '</ul>';
        contentNode.innerHTML = listHtml;
        contentNode.querySelectorAll('li').forEach(li => {
            li.onmouseover = () => li.style.backgroundColor = '#f0f0f0';
            li.onmouseout = () => li.style.backgroundColor = 'transparent';
            li.onclick = () => {
                const selectedReport = reports.find(r => r.uuid === li.dataset.uuid);
                if(selectedReport) showReportWindow(selectedReport.title, selectedReport.report);
            };
        });
        createFloatingWindow('歷史報告清單', contentNode, { height: '400px', width: '450px' });
    }

    async function showSettingsWindow() {
        await loadCustomPrompts();
        const contentNode = document.createElement('div');
        contentNode.style.cssText = 'display: flex; flex-direction: column; gap: 20px;';

        let allPrompts =;
        let promptOptions = allPrompts.map(p => `<option value="${p.title}" ${p.title === settings.promptTitle? 'selected' : ''}>${p.title}</option>`).join('');

        contentNode.innerHTML = `
            <details open>
                <summary style="font-weight: bold; cursor: pointer;">通用設定</summary>
                <div style="padding: 10px; border: 1px solid #eee; border-radius: 4px; margin-top: 5px; display: flex; flex-direction: column; gap: 15px;">
                    <div>
                        <label style="display: block; margin-bottom: 8px;">分析服務供應商:</label>
                        <select id="analyzer-provider-select" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">
                            <option value="openai" ${settings.analyzerProvider === 'openai'? 'selected' : ''}>OpenAI</option>
                            <option value="gemini" ${settings.analyzerProvider === 'gemini'? 'selected' : ''}>Google Gemini</option>
                            <option value="xai" ${settings.analyzerProvider === 'xai'? 'selected' : ''}>xAI Grok</option>
                        </select>
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 8px;">分析模式 (提示詞):</label>
                        <select id="prompt-select" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">${promptOptions}</select>
                    </div>
                    <div style="display: flex; gap: 20px;">
                        <div style="flex: 1;"><label style="display: block; margin-bottom: 8px;">Temperature (0-2):</label><input type="number" id="temp-input" value="${settings.temperature}" step="0.1" min="0" max="2" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
                        <div style="flex: 1;"><label style="display: block; margin-bottom: 8px;">Top P (0-1):</label><input type="number" id="topp-input" value="${settings.top_p}" step="0.1" min="0" max="1" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
                    </div>
                </div>
            </details>
            <details>
                <summary style="font-weight: bold; cursor: pointer;">API 金鑰與模型</summary>
                <div style="padding: 10px; border: 1px solid #eee; border-radius: 4px; margin-top: 5px; display: flex; flex-direction: column; gap: 15px;">
                    <div><label style="font-weight: bold;">OpenAI</label><input type="password" id="openai-key-input" placeholder="sk-..." value="${settings.providers.openai.apiKey}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-top: 5px;"><input type="text" id="openai-model-input" placeholder="gpt-4o" value="${settings.providers.openai.model}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-top: 5px;"></div>
                    <div><label style="font-weight: bold;">Google Gemini</label><input type="password" id="gemini-key-input" placeholder="AIzaSy..." value="${settings.providers.gemini.apiKey}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-top: 5px;"><input type="text" id="gemini-model-input" placeholder="gemini-1.5-pro-latest" value="${settings.providers.gemini.model}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-top: 5px;"></div>
                    <div><label style="font-weight: bold;">xAI Grok</label><input type="password" id="xai-key-input" placeholder="xai-..." value="${settings.providers.xai.apiKey}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-top: 5px;"><input type="text" id="xai-model-input" placeholder="grok-4" value="${settings.providers.xai.model}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; margin-top: 5px;"></div>
                </div>
            </details>
            <details>
                <summary style="font-weight: bold; cursor: pointer;">自訂提示詞管理</summary>
                <div id="custom-prompts-container" style="padding: 10px; border: 1px solid #eee; border-radius: 4px; margin-top: 5px;"></div>
            </details>
        `;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 15px;`;
        
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999; margin-right: auto;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        
        const notificationButton = document.createElement('button');
        notificationButton.innerText = '啟用系統通知';
        notificationButton.style.cssText = `padding: 8px 12px; border-radius: 6px; border: 1px solid #ccc; background-color: #f0f0f0; cursor: pointer;`;
        notificationButton.onclick = requestNotificationPermission;
        if (settings.notificationsEnabled === true) {
            notificationButton.innerText = '通知已啟用';
            notificationButton.disabled = true;
        } else if (settings.notificationsEnabled === false) {
            notificationButton.innerText = '通知已禁用';
            notificationButton.disabled = true;
        }

        const saveButton = document.createElement('button');
        saveButton.innerText = '儲存設定';
        saveButton.style.cssText = `padding: 8px 16px; border-radius: 6px; border: none; background-color: #28a745; color: white; cursor: pointer;`;
        saveButton.onclick = () => {
            settings.analyzerProvider = contentNode.querySelector('#analyzer-provider-select').value;
            settings.promptTitle = contentNode.querySelector('#prompt-select').value;
            settings.temperature = parseFloat(contentNode.querySelector('#temp-input').value);
            settings.top_p = parseFloat(contentNode.querySelector('#topp-input').value);
            settings.providers.openai.apiKey = contentNode.querySelector('#openai-key-input').value;
            settings.providers.openai.model = contentNode.querySelector('#openai-model-input').value;
            settings.providers.gemini.apiKey = contentNode.querySelector('#gemini-key-input').value;
            settings.providers.gemini.model = contentNode.querySelector('#gemini-model-input').value;
            settings.providers.xai.apiKey = contentNode.querySelector('#xai-key-input').value;
            settings.providers.xai.model = contentNode.querySelector('#xai-model-input').value;
            saveSettings();
            hideWindow();
            alert(`設定已儲存！`);
        };

        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(notificationButton);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);

        createFloatingWindow('設定', contentNode, { width: '600px', height: 'auto' });
        renderCustomPromptsUI(contentNode.querySelector('#custom-prompts-container'));
    }

    function renderCustomPromptsUI(container) {
        container.innerHTML = '';
        const list = document.createElement('ul');
        list.style.cssText = 'list-style: none; padding: 0; margin: 0; max-height: 150px; overflow-y: auto;';
        
        customPrompts.forEach(p => {
            const li = document.createElement('li');
            li.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid #f0f0f0;';
            li.innerText = p.title;
            
            const buttons = document.createElement('div');
            const editBtn = document.createElement('button');
            editBtn.innerText = '編輯';
            editBtn.onclick = () => showPromptEditor(p);
            const deleteBtn = document.createElement('button');
            deleteBtn.innerText = '刪除';
            deleteBtn.onclick = async () => {
                if (confirm(`確定要刪除提示詞 "${p.title}" 嗎？`)) {
                    await deleteCustomPrompt(p.uuid);
                    await loadCustomPrompts();
                    renderCustomPromptsUI(container);
                }
            };
           .forEach(btn => {
                btn.style.cssText = 'margin-left: 5px; font-size: 12px; padding: 2px 6px;';
            });
            
            buttons.appendChild(editBtn);
            buttons.appendChild(deleteBtn);
            li.appendChild(buttons);
            list.appendChild(li);
        });
        container.appendChild(list);

        const addBtn = document.createElement('button');
        addBtn.innerText = '新增提示詞';
        addBtn.style.cssText = 'margin-top: 10px; padding: 8px 12px;';
        addBtn.onclick = () => showPromptEditor(null);
        container.appendChild(addBtn);
    }
    
    function showPromptEditor(prompt) {
        const isNew =!prompt;
        const promptData = isNew? { uuid: self.crypto.randomUUID(), title: '', prompt: '' } : prompt;

        const editorNode = document.createElement('div');
        editorNode.innerHTML = `
            <div style="margin-bottom: 10px;"><label>標題:</label><input type="text" id="prompt-editor-title" value="${promptData.title}" style="width: 100%; padding: 8px; box-sizing: border-box;"></div>
            <div><label>提示詞內容:</label><textarea id="prompt-editor-content" style="width: 100%; height: 200px; padding: 8px; box-sizing: border-box; font-family: monospace;">${promptData.prompt}</textarea></div>
        `;
        const saveBtn = document.createElement('button');
        saveBtn.innerText = '儲存';
        saveBtn.style.cssText = 'margin-top: 10px; padding: 8px 16px; background-color: #28a745; color: white; border: none; border-radius: 4px;';
        saveBtn.onclick = async () => {
            promptData.title = editorNode.querySelector('#prompt-editor-title').value;
            promptData.prompt = editorNode.querySelector('#prompt-editor-content').value;
            if (!promptData.title ||!promptData.prompt) {
                alert('標題和內容不能為空。');
                return;
            }
            await saveCustomPrompt(promptData);
            hideWindow();
            showSettingsWindow(); // Refresh settings window
        };
        editorNode.appendChild(saveBtn);
        createFloatingWindow(isNew? '新增提示詞' : '編輯提示詞', editorNode, { width: '500px', height: 'auto' });
    }

    function showToast(message) {
        let toast = document.getElementById('analyzer-toast');
        if (toast) toast.remove();
        toast = document.createElement('div');
        toast.id = 'analyzer-toast';
        toast.textContent = message;
        toast.style.cssText = `position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background-color: #28a745; color: white; padding: 12px 20px; border-radius: 8px; z-index: 10002; font-size: 14px; opacity: 0; transition: opacity 0.5s, transform 0.5s; transform: translate(-50%, 20px);`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translate(-50%, 0)';
        }, 10);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translate(-50%, 20px)';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }

    // Requirement 1: System Notification
    function requestNotificationPermission() {
        if (!("Notification" in window)) {
            alert("此瀏覽器不支援桌面通知。");
            return;
        }
        Notification.requestPermission().then((permission) => {
            settings.notificationsEnabled = (permission === "granted");
            saveSettings();
            alert(permission === "granted"? "通知權限已授予！" : "通知權限被拒絕或忽略。");
            hideWindow();
            showSettingsWindow(); // Refresh settings window to update button state
        });
    }

    function showSystemNotification(title, body) {
        if (!settings.notificationsEnabled) return;
        new Notification(title, { body });
    }

    // --- UTILITY FUNCTIONS ---
    function makeDraggable(element, handle) { let p1=0,p2=0,p3=0,p4=0; handle.onmousedown=e=>{e.preventDefault();p3=e.clientX;p4=e.clientY;document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};document.onmousemove=e=>{e.preventDefault();p1=p3-e.clientX;p2=p4-e.clientY;p3=e.clientX;p4=e.clientY;element.style.top=(element.offsetTop-p2)+"px";element.style.left=(element.offsetLeft-p1)+"px";};};}
    function makeResizable(element, handle) { handle.onmousedown=e=>{e.preventDefault();const sX=e.clientX,sY=e.clientY,sW=parseInt(document.defaultView.getComputedStyle(element).width,10),sH=parseInt(document.defaultView.getComputedStyle(element).height,10);document.onmousemove=e=>{element.style.width=(sW+e.clientX-sX)+'px';element.style.height=(sH+e.clientY-sY)+'px';};document.onmouseup=()=>{document.onmousemove=null;document.onmouseup=null;};};}
    function getChatIdFromUrl() { const hash = window.location.hash; return (hash && hash.startsWith('#chat='))? hash.substring('#chat='.length) : null; }
    
    function formatMarkdownToHtml(markdownText) {
        if (!markdownText) return '無分析內容。';
        let html = markdownText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        // Requirement 2: Add ID for copy button targeting
        html = html.replace(/(### 3\. 權威性統整回答 \(最重要\))/i, '<div id="analyzer-summary-section">$1');
        const summaryEndMarker = '\n\n---'; // The footer start
        if (html.includes('id="analyzer-summary-section"')) {
            const parts = html.split(summaryEndMarker);
            if (parts.length > 1) {
                html = parts + '</div>' + summaryEndMarker + parts.slice(1).join(summaryEndMarker);
            } else {
                html += '</div>'; // Close div if no footer
            }
        }
        
        html = html.replace(/^### (.*$)/gim, '<h3 style="margin-bottom: 10px; margin-top: 20px; color: #333;">$1</h3>')
                  .replace(/^## (.*$)/gim, '<h2 style="margin-bottom: 15px; margin-top: 25px; border-bottom: 1px solid #eee; padding-bottom: 5px; color: #111;">$1</h2>')
                  .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                  .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                  .replace(/\*(.*?)\*/g, '<em>$1</em>')
                  .replace(/^\s*[-*] (.*$)/gim, '<li style="margin-bottom: 8px;">$1</li>');
        html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>').replace(/(<li>.*?<\/li>)/g, '<ul style="padding-left: 20px; margin-top: 10px;">$1</ul>').replace(/<\/ul>\s*<ul>/g, '');
        return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;
    }

    // --- INITIALIZATION & OBSERVERS ---
    let analysisInProgress = false;
    let lastAutoAnalysisTriggerTime = 0;

    const autoAnalysisObserver = new MutationObserver((mutations) => {
        if (!settings.autoAnalyze |

| analysisInProgress ||!getChatIdFromUrl()) return;

        // Debounce to avoid rapid firing
        const now = Date.now();
        if (now - lastAutoAnalysisTriggerTime < 5000) return;

        // Check if any model is still generating a response
        const isGenerating = document.querySelector('[d="M120 50c0-16.5-13.5-30-30-30s-30 13.5-30 30 13.5 30 30 30h0c16.5 0 30-13.5 30-30Z"]'); // Typingmind's loading SVG path
        if (isGenerating) return;

        // Check if there are already reports for this chat
        getReportsForChat(getChatIdFromUrl()).then(reports => {
            if (reports.length > 0) return; // Don't auto-analyze if reports exist

            console.log("自動分析觸發條件滿足，開始分析...");
            lastAutoAnalysisTriggerTime = now;
            analysisInProgress = true;
            handleAnalysisRequest(false).finally(() => {
                analysisInProgress = false;
            });
        });
    });

    async function initialize() {
        console.log(`TypingMind Integrator Script v${SCRIPT_VERSION} Initialized`);
        loadSettings();
        await initDB();
        await loadCustomPrompts();
        
        // Initial UI creation
        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea') &&!document.getElementById('analyzer-controls-container')) {
                createUI();
                // Start observing for auto-analysis once the main UI is ready
                const chatContainer = document.querySelector('div[class*="ChatMessages_chatMessages"]');
                if (chatContainer) {
                    autoAnalysisObserver.observe(chatContainer, { childList: true, subtree: true });
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Update UI state when URL changes
        let lastSeenChatId = null;
        setInterval(() => {
            const currentChatId = getChatIdFromUrl();
            if (currentChatId!== lastSeenChatId) {
                lastSeenChatId = currentChatId;
                analysisInProgress = false; // Reset lock on chat change
                updateUIState();
            }
        }, 500);
    }

    initialize();
})();
