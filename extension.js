// ==UserScript==
// @name         TypingMind 對話分析與整合器
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  終極版：支援多API平台(OpenAI, Gemini, Grok)、自訂提示詞庫、自動分析、增量統整、版本化歷史報告、桌面通知、效能數據及可自訂參數的懸浮視窗介面。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION V4.0 ---
    const SCRIPT_VERSION = '4.0';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';
    // Storage Keys
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
            prompt: `你是一位頂尖的專家級研究員與事實查核員... (Your detailed prompt here)`,
            isDefault: true
        },
        {
            title: "優劣比較",
            prompt: `你是一位專業、公正且嚴謹的 AI 模型評估員... (Your detailed prompt here)`,
            isDefault: true
        }
    ];

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 2;
    let db;
    
    // --- DATABASE HELPERS ---
    function initDB() { /* ... (logic unchanged) ... */ }
    function saveReport(chatId, reportData, title) { /* ... (logic unchanged) ... */ }
    function getReportsForChat(chatId) { /* ... (logic unchanged) ... */ }

    // --- UI CREATION & STATE MANAGEMENT ---
    function createUI() { /* ... (logic unchanged) ... */ }
    async function updateUIState() { /* ... (logic unchanged) ... */ }

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
            if (mainButton) mainButton.innerHTML = '讀取中...';
            const { messages, modelMap } = await getTypingMindChatHistory();
            if (messages.length < 2) throw new Error('當前對話訊息不足，無法進行分析。');
            const userQuestion = stringifyContent(messages.find(m => m.role === 'user')?.content) || '新對話';
            reportTitle = `${userQuestion.substring(0, 15)}... (${analysisTimestamp.getHours()}:${String(analysisTimestamp.getMinutes()).padStart(2, '0')})`;
            if (mainButton) mainButton.innerHTML = '分析中... 🤖';
            const startTime = Date.now();
            const previousSummary = reports.length > 0 ? reports[0].report.split('\n\n---')[0] : null;
            const analysisResult = await analyzeConversation(messages, modelMap, previousSummary);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            let footer = `\n\n---\n*報告生成耗時：${duration} 秒*`;
            if (analysisResult.usage) {
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
    function getTypingMindChatHistory() { /* ... (logic unchanged) ... */ }

    // --- LLM INTERACTION - [COMPLETELY REWRITTEN SECTION V4.0] ---
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
             systemPrompt = `你是一位頂尖的專家級研究員... (Iterative summary prompt here)` + systemPrompt;
        }

        const lastUserQuestion = stringifyContent(messages.find(m => m.role === 'user')?.content) || '未找到原始問題。';
        const transcript = messages.filter(msg => msg.role !== 'user').map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');
        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) { modelMapInfo += `- ${id}: ${modelMap[id]}\n`; }
        
        const userContentForAnalyzer = `${previousSummary ? `--- 過往的總結 ---\n${previousSummary}\n\n` : ''}${modelMapInfo}\n--- 最新的問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}`;
        
        const commonPayload = { model, temperature, top_p };
        if (reasoningEffort) commonPayload.reasoning_effort = reasoningEffort;

        let endpoint, headers, body;
        
        if (provider === 'google') {
            const apiKey = localStorage.getItem(API_KEY_GEMINI_KEY);
            if (!apiKey) throw new Error('尚未設定 Google AI (Gemini) 的 API 金鑰。');
            endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
            // Convert OpenAI format to Gemini format
            body = {
                contents: [
                    { role: 'user', parts: [{ text: systemPrompt + "\n\n" + userContentForAnalyzer }] }
                ],
                generationConfig: { temperature: commonPayload.temperature, topP: commonPayload.top_p }
            };
        } else { // OpenAI, X.AI, and other compatible services
            let apiKey, baseUrl;
            if (provider === 'xai') {
                apiKey = localStorage.getItem(API_KEY_XAI_KEY);
                baseUrl = 'https://api.x.ai/v1';
            } else { // Default to OpenAI
                apiKey = localStorage.getItem(API_KEY_OPENAI_KEY);
                baseUrl = 'https://api.openai.com/v1';
            }
            if (!apiKey) throw new Error(`尚未設定 ${provider} 的 API 金鑰。`);
            endpoint = `${baseUrl}/chat/completions`;
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            body = {
                ...commonPayload,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }],
            };
        }

        const response = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤 (${provider}/${model}): ${response.status} - ${errorData.error?.message ?? JSON.stringify(errorData)}`);
        }
        const data = await response.json();
        
        // Parse response based on provider
        let content = '';
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        if (provider === 'google') {
            content = data.candidates[0].content.parts[0].text;
            // Gemini API doesn't provide token usage in the same way, so we'll estimate or ignore.
        } else {
            content = data.choices[0].message.content;
            if (data.usage) usage = data.usage;
        }
        
        return { content, usage };
    }

    // --- UI (FLOATING WINDOW, TOAST, NOTIFICATIONS) ---
    function createFloatingWindow(title, contentNode, options = {}) { /* ... (logic unchanged) ... */ }
    function hideWindow() { /* ... (logic unchanged) ... */ }
    function showReportWindow(reportText) { /* ... (logic unchanged) ... */ }
    function showReportListWindow(reports) { /* ... (logic unchanged) ... */ }
    
    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        // Retrieve all current settings
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

        // Build UI
        let promptOptions = allPrompts.map(p => `<option value="${p.title}" ${p.title === currentPromptTitle ? 'selected' : ''}>${p.title}</option>`).join('');
        contentNode.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; background-color: #f7f7f7; padding: 10px; border-radius: 6px; margin-bottom: 15px;">
                <label for="auto-analyze-toggle" style="cursor: pointer;">自動進行統整</label>
                <input type="checkbox" id="auto-analyze-toggle" ${isAutoAnalyze ? 'checked' : ''}>
            </div>
            <div><label>API 服務商:</label><select id="provider-select" style="width:100%; ...">${['openai', 'google', 'xai'].map(p => `<option value="${p}" ${p === currentProvider ? 'selected' : ''}>${p.toUpperCase()}</option>`).join('')}</select></div>
            <div style="margin-top: 15px;"><label>API 金鑰:</label><input type="password" id="api-key-input" value="${apiKeyMap[currentProvider]}" style="width:100%; ..."></div>
            <div style="margin-top: 15px;"><label>分析模型名稱:</label><input type="text" id="model-input" value="${currentModel}" style="width:100%; ..."></div>
            <div style="margin-top: 15px; display: flex; align-items: center; gap: 10px;">
                <div style="flex-grow: 1;"><label>分析模式 (提示詞):</label><select id="prompt-select" style="width:100%; ...">${promptOptions}</select></div>
                <button id="manage-prompts-btn" style="padding: 8px 12px; ...">管理...</button>
            </div>
            <div style="margin-top: 15px;"><label>Reasoning Effort:</label><input type="text" id="reasoning-input" value="${currentReasoning}" style="width:100%; ..."></div>
            <div style="display: flex; gap: 20px; margin-top: 15px;">
                <div style="flex:1;"><label>Temperature:</label><input type="number" id="temp-input" value="${currentTemp}" step="0.1" min="0" max="2" style="width:100%; ..."></div>
                <div style="flex:1;"><label>Top P:</label><input type="number" id="topp-input" value="${currentTopP}" step="0.1" min="0" max="1" style="width:100%; ..."></div>
            </div>
        `;
        // Event Listeners and Save Logic
        const providerSelect = contentNode.querySelector('#provider-select');
        const apiKeyInput = contentNode.querySelector('#api-key-input');
        providerSelect.onchange = () => {
            const newProvider = providerSelect.value;
            apiKeyMap[currentProvider] = apiKeyInput.value; // Save current input before switching
            apiKeyInput.value = apiKeyMap[newProvider] || '';
            localStorage.setItem(API_PROVIDER_KEY, newProvider);
        };
        contentNode.querySelector('#manage-prompts-btn').onclick = showPromptManagerWindow;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; ...`;
        const versionDiv = document.createElement('div');
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        const saveHandler = () => {
            const provider = providerSelect.value;
            apiKeyMap[provider] = apiKeyInput.value;
            localStorage.setItem(API_KEY_OPENAI_KEY, apiKeyMap.openai);
            localStorage.setItem(API_KEY_GEMINI_KEY, apiKeyMap.google);
            localStorage.setItem(API_KEY_XAI_KEY, apiKeyMap.xai);
            localStorage.setItem(AUTO_ANALYZE_KEY, contentNode.querySelector('#auto-analyze-toggle').checked);
            localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
            localStorage.setItem(MODEL_STORAGE_KEY, contentNode.querySelector('#model-input').value);
            // ... (save other settings) ...
            hideWindow();
            alert(`設定已儲存！`);
        };
        const saveButton = createButton('儲存', saveHandler, 'green');
        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);
        createFloatingWindow('設定', contentNode);
    }
    
    function showPromptManagerWindow() { /* ... (logic to create a new window for CRUD operations on prompts) ... */ }
    function getPrompts() { return [...DEFAULT_PROMPTS, ...(JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]'))]; }
    function savePrompts(prompts) { localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(prompts.filter(p => !p.isDefault))); }
    
    // --- Other Helpers (Toast, Notifications, Draggable, Resizable, etc.) ---
    
    // --- INITIALIZATION ---
    async function initialize() { /* ... (logic including new auto-analyze observer) ... */ }
    
    // (Omitted unchanged/minified functions and full prompt text for brevity)
    // ...
    initialize();
})();
