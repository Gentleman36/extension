// ==UserScript==
// @name         TypingMind 對話分析與整合器
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  分析、整合並驗證 TypingMind 對話中的多模型回應，提供自動分析、增量統整、多提示詞切換、版本化歷史報告、桌面通知、效能數據及可自訂參數的懸浮視窗介面。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const SCRIPT_VERSION = '3.3';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o';
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';
    const TEMP_STORAGE_KEY = 'typingmind_analyzer_temperature';
    const TOPP_STORAGE_KEY = 'typingmind_analyzer_top_p';
    const REASONING_EFFORT_STORAGE_KEY = 'typingmind_analyzer_reasoning_effort';
    const PROMPT_STORAGE_KEY = 'typingmind_analyzer_prompt_title';
    const AUTO_ANALYZE_KEY = 'typingmind_analyzer_auto_analyze';

    // --- PROMPT LIBRARY ---
    const PROMPTS = [ /* ... (Prompts are defined at the bottom for readability) ... */ ];

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
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;
        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        // --- New Position V3.3 ---
        container.style.cssText = `position: fixed; bottom: 70px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;
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
            if (!chatId) { throw new Error('無法獲取對話 ID。'); }
            
            let reports = await getReportsForChat(chatId);
            if (!isReanalysis && reports.length > 0) {
                showReportListWindow(reports);
                return;
            }

            let apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
            if (!apiKey) {
                apiKey = window.prompt('請輸入您的 OpenAI API 金鑰：');
                if (!apiKey) throw new Error('未提供 API 金鑰。');
                localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
            }

            if (mainButton) mainButton.innerHTML = '讀取中...';
            const { messages, modelMap } = await getTypingMindChatHistory();
            if (messages.length < 2) { throw new Error('當前對話訊息不足，無法進行分析。'); }

            // --- New Logic V3.3: Isolate last turn and get previous summary ---
            const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
            const lastTurnMessages = messages.slice(lastUserIndex);
            const previousSummary = reports.length > 0 ? reports[0].report.split('\n\n---')[0] : null; // Get the latest summary, without footer

            const userQuestion = stringifyContent(lastTurnMessages.find(m => m.role === 'user')?.content) || '新對話';
            reportTitle = `${userQuestion.substring(0, 15)}... (${analysisTimestamp.getHours()}:${String(analysisTimestamp.getMinutes()).padStart(2, '0')})`;
            
            if (mainButton) mainButton.innerHTML = '分析中... 🤖';
            const startTime = Date.now();
            const analysisResult = await analyzeConversation(apiKey, lastTurnMessages, modelMap, previousSummary);
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

    // --- LLM INTERACTION - [MODIFIED SECTION V3.3] ---
    async function analyzeConversation(apiKey, lastTurnMessages, modelMap, previousSummary) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
        const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
        const reasoningEffort = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY);
        const selectedPromptTitle = localStorage.getItem(PROMPT_STORAGE_KEY) || PROMPTS[0].title;
        let systemPrompt = PROMPTS.find(p => p.title === selectedPromptTitle)?.prompt || PROMPTS[0].prompt;

        // --- New Logic V3.3: Adapt prompt for iterative summary ---
        if (previousSummary) {
            systemPrompt = `你是一位頂尖的專家級研究員。你的任務是「更新」一份已有的總結報告。

你將收到三份資訊：
1.  【過往的總結】：這是基於更早之前的對話得出的結論。
2.  【最新的問題】：這是使用者剛剛提出的新問題。
3.  【最新的AI回答】：這是多個AI模型對「最新的問題」的回答。

你的任務是，在【過往的總結】的基礎上，吸收【最新的AI回答】中的新資訊，來對其進行「擴充」、「修正」或「重寫」，以回答【最新的問題】。最終產出一份更新後、更完善的「權威性統整回答」。請保持報告的連貫性與完整性。` + systemPrompt;
        }

        const lastUserQuestion = stringifyContent(lastTurnMessages.find(m => m.role === 'user')?.content) || '未找到原始問題。';
        const transcript = lastTurnMessages.filter(msg => msg.role !== 'user').map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');
        
        let modelMapInfo = "這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n";
        for (const id in modelMap) { modelMapInfo += `- ${id}: ${modelMap[id]}\n`; }
        
        const userContentForAnalyzer = `${previousSummary ? `--- 過往的總結 ---\n${previousSummary}\n\n` : ''}${modelMapInfo}\n--- 最新的問題 ---\n${lastUserQuestion}\n\n--- 最新的AI回答 ---\n${transcript}`;
        
        const requestBody = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }], temperature, top_p };
        if (reasoningEffort) { requestBody.reasoning_effort = reasoningEffort; }

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
        return { content: data.choices[0].message.content, usage: data.usage };
    }

    // --- UI (FLOATING WINDOW, TOAST, NOTIFICATIONS) ---
    function createFloatingWindow(title, contentNode, options = {}) { /* ... (logic unchanged) ... */ }
    function hideWindow() { /* ... (logic unchanged) ... */ }
    function showReportWindow(reportText) { /* ... (logic unchanged) ... */ }
    function showReportListWindow(reports) { /* ... (logic unchanged) ... */ }
    
    // --- [MODIFIED SECTION V3.3] ---
    function showSettingsWindow() {
        const contentNode = document.createElement('div');
        const currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const currentTemp = localStorage.getItem(TEMP_STORAGE_KEY) || '1.0';
        const currentTopP = localStorage.getItem(TOPP_STORAGE_KEY) || '1.0';
        const currentReasoning = localStorage.getItem(REASONING_EFFORT_STORAGE_KEY) || 'High';
        const currentPrompt = localStorage.getItem(PROMPT_STORAGE_KEY) || PROMPTS[0].title;
        const isAutoAnalyze = localStorage.getItem(AUTO_ANALYZE_KEY) === 'true';

        let promptOptions = '';
        PROMPTS.forEach(p => {
            promptOptions += `<option value="${p.title}" ${p.title === currentPrompt ? 'selected' : ''}>${p.title}</option>`;
        });

        contentNode.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; background-color: #f7f7f7; padding: 10px; border-radius: 6px;">
                <label for="auto-analyze-toggle">自動進行統整</label>
                <input type="checkbox" id="auto-analyze-toggle" ${isAutoAnalyze ? 'checked' : ''}>
            </div>
            <div style="margin-top: 15px;"><label style="display: block; margin-bottom: 8px;">分析模式 (提示詞):</label><select id="prompt-select" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;">${promptOptions}</select></div>
            <div style="margin-top: 15px;"><label for="model-input" style="display: block; margin-bottom: 8px;">分析模型名稱:</label><input type="text" id="model-input" value="${currentModel}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="margin-top: 15px;"><label for="reasoning-input" style="display: block; margin-bottom: 8px;">Reasoning Effort:</label><input type="text" id="reasoning-input" value="${currentReasoning}" placeholder="例如: High, Medium, Auto" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            <div style="display: flex; gap: 20px; margin-top: 15px;">
                <div style="flex: 1;"><label for="temp-input" style="display: block; margin-bottom: 8px;">Temperature (0-2):</label><input type="number" id="temp-input" value="${currentTemp}" step="0.1" min="0" max="2" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
                <div style="flex: 1;"><label for="topp-input" style="display: block; margin-bottom: 8px;">Top P (0-1):</label><input type="number" id="topp-input" value="${currentTopP}" step="0.1" min="0" max="1" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc;"></div>
            </div>`;
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 15px;`;
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999; margin-right: auto;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        const saveHandler = () => {
            localStorage.setItem(AUTO_ANALYZE_KEY, contentNode.querySelector('#auto-analyze-toggle').checked);
            localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
            localStorage.setItem(MODEL_STORAGE_KEY, contentNode.querySelector('#model-input').value);
            localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, contentNode.querySelector('#reasoning-input').value);
            localStorage.setItem(TEMP_STORAGE_KEY, contentNode.querySelector('#temp-input').value);
            localStorage.setItem(TOPP_STORAGE_KEY, contentNode.querySelector('#topp-input').value);
            hideWindow();
            alert(`設定已儲存！`);
        };
        const saveButton = createButton('儲存', saveHandler, 'green');
        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);
        createFloatingWindow('設定', contentNode);
    }
    
    function showToast(message) { /* ... (logic unchanged) ... */ }
    function requestAndShowDesktopNotification(title, body) { /* ... (logic unchanged) ... */ }
    function createButton(text, onClick, colorScheme) { /* ... (logic unchanged) ... */ }
    function makeDraggable(element, handle) { /* ... (logic unchanged) ... */ }
    function makeResizable(element, handle) { /* ... (logic unchanged) ... */ }
    function formatMarkdownToHtml(markdownText) { /* ... (logic unchanged) ... */ }
    
    // --- INITIALIZATION ---
    async function initialize() {
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();
        
        let lastSeenChatId = null;
        setInterval(() => {
            const currentChatId = getChatIdFromUrl();
            if (currentChatId !== lastSeenChatId) {
                lastSeenChatId = currentChatId;
                updateUIState();
            }
        }, 500);

        // --- New: Auto-analyze observer V3.3 ---
        let analysisDebounceTimer;
        const triggerAutoAnalysis = () => {
            const isAutoAnalyze = localStorage.getItem(AUTO_ANALYZE_KEY) === 'true';
            if (!isAutoAnalyze) return;
            const mainButton = document.getElementById('analyzer-main-button');
            if (mainButton && mainButton.innerText.includes('查看報告')) return; // Don't auto-run if a report already exists
            
            console.log("Auto-analysis triggered!");
            handleAnalysisRequest(true);
        };
        
        const autoAnalyzeObserver = new MutationObserver((mutations) => {
            // A simple heuristic: watch for when streaming indicators disappear.
            // This might need adjustment if TypingMind changes their class names.
            let isStreaming = false;
            mutations.forEach(mutation => {
                 if(mutation.target.querySelector(".streaming-text-indicator-cursor") || mutation.target.querySelector(".animate-pulse")){
                     isStreaming = true;
                 }
            });

            if (!isStreaming) {
                clearTimeout(analysisDebounceTimer);
                analysisDebounceTimer = setTimeout(triggerAutoAnalysis, 1500); // Wait 1.5s after last change to be sure
            }
        });

        // Start observing when a chat is active
        const uiObserver = new MutationObserver(() => {
            const chatContainer = document.querySelector('.chat-messages-container');
            if (chatContainer) {
                if (!document.getElementById('analyzer-controls-container')) createUI();
                autoAnalyzeObserver.observe(chatContainer, { childList: true, subtree: true });
            } else {
                autoAnalyzeObserver.disconnect();
            }
        });
        uiObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Minified unchanged functions and prompt definitions at the end for script managers
    PROMPTS[0].prompt = `你是一位頂尖的專家級研究員與事實查核員。你的任務是基於使用者提出的「原始問題」，對提供的「多個AI模型的回答文字稿」進行分析與整合。文字稿中的模型可能以長串ID標示，我會提供一個已知ID與其對應官方名稱的列表。\n\n請嚴格遵循以下三段式結構，使用清晰的 Markdown 格式輸出你的最終報告。在報告中，請優先使用模型官方名稱，對於未知ID，請使用「模型A」、「模型B」等代號。\n\n### 1. 原始問題\n(在此處簡潔地重述使用者提出的原始問題。)\n\n### 2. AI模型比較\n(在此處用一兩句話簡要總結哪個模型的回答總體上更佳，並陳述最核心的理由。)\n\n### 3. 權威性統整回答 (最重要)\n(這是報告的核心。請將所有模型回答中的正確、互補的資訊，進行嚴格的事實查核與交叉驗證後，融合成一份單一、全面、且權威性的最終答案。這份答案應該要超越任何單一模型的回答，成為使用者唯一需要閱讀的完整內容。如果不同模型存在無法調和的矛盾，請在此處明確指出。)`;
    PROMPTS[1].prompt = `你是一位專業、公正且嚴謹的 AI 模型評估員。你的任務是基於使用者提出的「原始問題」，對提供的「對話文字稿」中多個 AI 模型的回答進行深入的比較分析。你的分析必須客觀、有理有據。\n\n請使用清晰的 Markdown 格式來組織你的回答，應包含以下部分：\n- ### 總體評價\n  (簡要說明哪個模型的回答更好，為什麼？)\n- ### 各模型優點\n  (使用列表分別陳述每個模型回答的優點。)\n- ### 各模型缺點\n  (使用列表分別陳述每個模型回答的缺點。)\n- ### 結論與建議\n  (提供最終的裁決總結或改進建議。)`;
    initDB=()=>{return new Promise((r,t)=>{const e=indexedDB.open(DB_NAME,DB_VERSION);e.onupgradeneeded=e=>{const n=e.target.result;e.oldVersion<2&&(n.objectStoreNames.contains(REPORT_STORE_NAME)&&n.deleteObjectStore(REPORT_STORE_NAME),n.createObjectStore(REPORT_STORE_NAME,{keyPath:"uuid"}).createIndex("chatIdIndex","chatId",{unique:!1}))},e.onerror=r=>t(`資料庫錯誤: ${r.target.errorCode}`),e.onsuccess=e=>{db=e.target.result,r(db)}})};
    saveReport=(c,r,t)=>{return new Promise((e,n)=>{if(!db)return n("資料庫未初始化。");const o=db.transaction([REPORT_STORE_NAME],"readwrite").objectStore(REPORT_STORE_NAME).add({uuid:self.crypto.randomUUID(),chatId:c,title:t,report:r,timestamp:new Date});o.onsuccess=()=>e(),o.onerror=r=>n(`儲存報告失敗: ${r.target.error}`)})};
    getReportsForChat=(c)=>{return new Promise((r,t)=>{if(!db)return t("資料庫未初始化。");db.transaction([REPORT_STORE_NAME],"readonly").objectStore(REPORT_STORE_NAME).index("chatIdIndex").getAll(c).onsuccess=e=>r(e.target.result.sort((r,t)=>t.timestamp-r.timestamp))})};
    getTypingMindChatHistory=()=>{return new Promise((resolve,reject)=>{const request=indexedDB.open("keyval-store");request.onerror=()=>reject(new Error("無法開啟 TypingMind 資料庫。"));request.onsuccess=event=>{const tmDb=event.target.result,chatId=getChatIdFromUrl();if(!chatId)return reject(new Error("無法確定當前對話 ID。"));const currentChatKey=`CHAT_${chatId}`,transaction=tmDb.transaction(["keyval"],"readonly"),objectStore=transaction.objectStore("keyval"),getRequest=objectStore.get(currentChatKey);getRequest.onerror=()=>reject(new Error("讀取聊天資料出錯。"));getRequest.onsuccess=()=>{const chatData=getRequest.result;if(!chatData||!chatData.messages)return reject(new Error("找不到對應的聊天資料。"));const allMessages=[],modelMap={};chatData.model&&chatData.modelInfo&&(modelMap[chatData.model]=chatData.modelInfo.title||chatData.model);for(const turn of chatData.messages)if("user"===turn.role)allMessages.push(turn);else if("tm_multi_responses"===turn.type&&turn.responses)for(const response of turn.responses)response.model&&response.modelInfo&&(modelMap[response.model]=response.modelInfo.title||response.model),response.messages&&response.model&&allMessages.push(...response.messages.map(msg=>({...msg,model:response.model})));else"assistant"===turn.role&&allMessages.push(turn);resolve({messages:allMessages,modelMap:modelMap})}}})};
    createFloatingWindow=(t,e,o={})=>{hideWindow();const n=document.createElement("div");n.id="analyzer-window",n.style.cssText=`position: fixed; top: ${o.top||"50px"}; left: ${o.left||"50px"}; width: ${o.width||"500px"}; height: ${o.height||"600px"}; z-index: 10001; background-color: #fff; border: 1px solid #ccc; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;`;const i=document.createElement("div");i.style.cssText="background-color: #f0f0f0; padding: 8px 12px; cursor: move; border-bottom: 1px solid #ccc; display: flex; justify-content: space-between; align-items: center; user-select: none; gap: 10px;";const s=document.createElement("span");s.textContent=t,s.style.fontWeight="bold",s.style.whiteSpace="nowrap",s.style.overflow="hidden",s.style.textOverflow="ellipsis";const l=document.createElement("div");l.style.display="flex",l.style.alignItems="center",l.style.gap="10px";if(o.showCopyButton){const a=document.createElement("button");a.innerText="複製總結",a.style.cssText="padding: 4px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background-color: #fff; cursor: pointer;",a.onclick=t=>{t.stopPropagation();const n=o.fullReportText||"",c=n.split(/### 3\.\s*權威性統整回答\s*\(最重要\)/i);c.length>1?navigator.clipboard.writeText(c[1].split("\n\n---")[0].trim()).then(()=>{a.innerText="已複製!",setTimeout(()=>{a.innerText="複製總結"},2e3)}):a.innerText="無內容"},l.appendChild(a)}const d=document.createElement("button");d.innerHTML="&times;",d.style.cssText="background: none; border: none; font-size: 20px; cursor: pointer;",d.onclick=hideWindow,l.appendChild(d),i.appendChild(s),i.appendChild(l);const r=document.createElement("div");r.style.cssText="padding: 15px; flex-grow: 1; overflow-y: auto;",r.appendChild(e);const p=document.createElement("div");p.style.cssText="position: absolute; bottom: 0; right: 0; width: 15px; height: 15px; cursor: se-resize; background: linear-gradient(135deg, transparent 50%, #aaa 50%);",n.appendChild(i),n.appendChild(r),n.appendChild(p),document.body.appendChild(n),makeDraggable(n,i),makeResizable(n,p)};
    hideWindow = () => { const windowEl = document.getElementById('analyzer-window'); if (windowEl) windowEl.remove(); };
    createButton = (t,e,o="grey")=>{const n=document.createElement("button");n.innerText=t;const i={grey:{bg:"#6c757d",hover:"#5a6268"},blue:{bg:"#007bff",hover:"#0069d9"},green:{bg:"#28a745",hover:"#218838"}},s=i[o]||i.grey;return n.style.cssText="padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; color: white; font-size: 14px; font-weight: 500; transition: background-color 0.2s;",n.style.backgroundColor=s.bg,n.onmouseover=()=>n.style.backgroundColor=s.hover,n.onmouseout=()=>n.style.backgroundColor=s.bg,n.onclick=e,n};
    showToast = (msg) => { let t=document.getElementById('analyzer-toast');if(t)t.remove();t=document.createElement('div');t.id='analyzer-toast';t.textContent=msg;t.style.cssText='position:fixed;bottom:30px;right:200px;background-color:#28a745;color:white;padding:12px 20px;border-radius:8px;z-index:10002;font-size:14px;opacity:0;transition:opacity .5s,transform .5s;transform:translateY(20px)';document.body.appendChild(t);setTimeout(()=>{t.style.opacity='1';t.style.transform='translateY(0)'},10);setTimeout(()=>{t.style.opacity='0';t.style.transform='translateY(20px)';setTimeout(()=>t.remove(),500)},3000);};
    requestAndShowDesktopNotification = (t,e)=>{if(!("Notification"in window))return;const o=()=>{new Notification(t,{body:e,icon:"https://www.typingmind.com/favicon.ico"})};"granted"===Notification.permission?o():"denied"!==Notification.permission&&Notification.requestPermission().then(t=>{"granted"===t&&o()})};
    makeDraggable = (el, handle) => { let p1=0,p2=0,p3=0,p4=0; handle.onmousedown=e=>{e.preventDefault();p3=e.clientX;p4=e.clientY;document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};document.onmousemove=e=>{e.preventDefault();p1=p3-e.clientX;p2=p4-e.clientY;p3=e.clientX;p4=e.clientY;el.style.top=(el.offsetTop-p2)+"px";el.style.left=(el.offsetLeft-p1)+"px";};};};
    makeResizable = (el, handle) => { handle.onmousedown=e=>{e.preventDefault();const sX=e.clientX,sY=e.clientY,sW=parseInt(document.defaultView.getComputedStyle(el).width,10),sH=parseInt(document.defaultView.getComputedStyle(el).height,10);document.onmousemove=e=>{el.style.width=(sW+e.clientX-sX)+'px';el.style.height=(sH+e.clientY-sY)+'px';};document.onmouseup=()=>{document.onmousemove=null;document.onmouseup=null;};};};
    formatMarkdownToHtml = (text) => { if (!text) return ''; let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); html = html.replace(/^### (.*$)/gim, '<h3 style="margin-bottom:10px;margin-top:20px;color:#333;">$1</h3>').replace(/^## (.*$)/gim, '<h2 style="margin-bottom:15px;margin-top:25px;border-bottom:1px solid #eee;padding-bottom:5px;color:#111;">$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/^\s*[-*] (.*$)/gim, '<li style="margin-bottom:8px;">$1</li>'); html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>').replace(/(<li>.*?<\/li>)/g, '<ul style="padding-left:20px;margin-top:10px;">$1</ul>').replace(/<\/ul>\s*<ul>/g, ''); return `<div class="markdown-body" style="line-height:1.7;font-size:15px;">${html.replace(/\n/g, '<br>')}</div>`;};
    
    initialize();
})();
