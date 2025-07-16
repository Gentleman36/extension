// IIFE (Immediately Invoked Function Expression) to avoid polluting the global scope
(function() {
    'use strict';

    // --- CONFIGURATION ---
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o-mini';
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model'; // Key for saving the user's preferred model

    // --- DATABASE CONFIGURATION ---
    const DB_NAME = 'TypingMindAnalyzerDB';
    const REPORT_STORE_NAME = 'analysis_reports';
    const DB_VERSION = 1;
    let db; // To hold the database instance

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
            request.onsuccess = () => resolve(request.result); // Returns the record or undefined
            request.onerror = (event) => reject(`讀取報告失敗: ${event.target.error}`);
        });
    }


    // --- UI CREATION ---
    function createUI() {
        if (document.getElementById('analyzer-controls-container')) return;

        const container = document.createElement('div');
        container.id = 'analyzer-controls-container';
        container.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            display: flex; gap: 10px; align-items: center;
        `;

        // Main action button (will be updated dynamically)
        const mainButton = document.createElement('button');
        mainButton.id = 'analyzer-main-button';
        mainButton.style.cssText = `
            background-color: #4A90E2; color: white; border: none; border-radius: 8px;
            padding: 10px 15px; font-size: 14px; cursor: pointer;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: all 0.3s;
        `;
        mainButton.onmouseover = () => mainButton.style.backgroundColor = '#357ABD';
        mainButton.onmouseout = () => mainButton.style.backgroundColor = '#4A90E2';

        // Re-analyze button (initially hidden)
        const reanalyzeButton = document.createElement('button');
        reanalyzeButton.id = 'analyzer-reanalyze-button';
        reanalyzeButton.innerHTML = '🔄';
        reanalyzeButton.title = '重新分析';
        reanalyzeButton.style.cssText = `
            background-color: #6c757d; color: white; border: none; border-radius: 50%;
            width: 38px; height: 38px; font-size: 18px; cursor: pointer; display: none;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.3s;
        `;
        reanalyzeButton.onclick = () => handleAnalysisRequest(true); // Force re-analysis

        // Settings button
        const settingsButton = document.createElement('button');
        settingsButton.innerHTML = '⚙️';
        settingsButton.title = '設定分析模型';
        settingsButton.style.cssText = `
            background-color: #f0f0f0; color: #333; border: 1px solid #ccc; border-radius: 50%;
            width: 38px; height: 38px; font-size: 20px; cursor: pointer;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.3s;
        `;
        settingsButton.onclick = showSettingsModal;

        container.appendChild(reanalyzeButton);
        container.appendChild(mainButton);
        container.appendChild(settingsButton);
        document.body.appendChild(container);

        updateUIState(); // Initial UI update
    }

    async function updateUIState() {
        const mainButton = document.getElementById('analyzer-main-button');
        const reanalyzeButton = document.getElementById('analyzer-reanalyze-button');
        if (!mainButton) return;

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
            mainButton.onclick = () => showModal(formatAnalysisToHtml(existingReport.report), true);
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
        if (!chatId) {
            alert('無法獲取對話 ID。');
            return;
        }

        if (!isReanalysis) {
            const existingReport = await getReport(chatId);
            if (existingReport) {
                showModal(formatAnalysisToHtml(existingReport.report), true);
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

            showModal('讀取對話紀錄中...');
            const messages = await getTypingMindChatHistory();
            if (messages.length < 2) {
                alert('當前對話訊息不足，無法進行分析。');
                hideModal();
                return;
            }

            showModal('分析中，請稍候...');
            const analysisJson = await analyzeConversation(apiKey, messages);
            
            await saveReport(chatId, analysisJson);
            showModal(formatAnalysisToHtml(analysisJson), true);
            updateUIState();

        } catch (error) {
            console.error('分析擴充程式錯誤:', error);
            showModal(`<h3>發生錯誤</h3><pre style="white-space: pre-wrap; word-wrap: break-word;">${error.message}</pre>`, true);
        }
    }

    // --- DATA RETRIEVAL (TypingMind's DB) ---
    function getTypingMindChatHistory() {
        return new Promise((resolve, reject) => {
            const dbName = 'keyval-store';
            const storeName = 'keyval';
            const request = indexedDB.open(dbName);

            request.onerror = () => reject(new Error('無法開啟 TypingMind 資料庫 (keyval-store)。'));
            
            request.onsuccess = (event) => {
                const tmDb = event.target.result;
                const chatId = getChatIdFromUrl();
                if (!chatId) return reject(new Error('無法從 URL 中確定當前對話 ID。'));
                
                const currentChatKey = `CHAT_${chatId}`; 

                const transaction = tmDb.transaction([storeName], 'readonly');
                const objectStore = transaction.objectStore(storeName);
                const getRequest = objectStore.get(currentChatKey);

                getRequest.onerror = () => reject(new Error('讀取聊天資料時出錯。'));
                getRequest.onsuccess = () => {
                    const chatData = getRequest.result;
                    if (chatData && chatData.messages) {
                        resolve(chatData.messages);
                    } else {
                        reject(new Error(`使用金鑰 '${currentChatKey}' 找不到對應的聊天資料。`));
                    }
                };
            };
        });
    }

    // --- LLM INTERACTION ---
    async function analyzeConversation(apiKey, messages) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const lastUserQuestion = messages.filter(m => m.role === 'user').pop()?.content ?? 'No user question found.';
        
        // --- THIS IS THE FIX ---
        const transcript = messages
            .map(msg => `**${(msg.role ?? 'system_note').toUpperCase()} (Model: ${msg.model ?? 'N/A'})**: ${msg.content}`)
            .join('\n\n---\n\n');
        // --- END OF FIX ---

        const systemPrompt = `你是一位專業、公正且嚴謹的 AI 模型評估員。你的任務是基於使用者提出的「原始問題」，對提供的「對話文字稿」中多個 AI 模型的回答進行深入的比較分析。你的分析必須客觀、有理有據，並以結構化的 JSON 格式輸出。你的最終輸出必須是一個結構完全正確的 JSON 物件，不得包含任何額外的解釋性文字。`;
        const userContentForAnalyzer = `--- 原始問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }],
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
        }
        const data = await response.json();
        return JSON.parse(data.choices[0].message.content);
    }

    // --- UI (MODALS) ---
    function showModal(content, isResult = false) {
        hideModal();
        const backdrop = document.createElement('div');
        backdrop.id = 'analyzer-backdrop';
        backdrop.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.6); z-index: 10000;`;
        const modal = document.createElement('div');
        modal.id = 'analyzer-modal';
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 800px; max-height: 85vh; overflow-y: auto; background-color: #2c2c2c; color: #f0f0f0; border-radius: 12px; padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); border: 1px solid #444;`;
        
        backdrop.addEventListener('click', hideModal);
        if (typeof content === 'string') modal.innerHTML = content;
        else modal.innerHTML = formatAnalysisToHtml(content);

        if (isResult) {
            const closeButton = document.createElement('button');
            closeButton.innerText = '關閉';
            closeButton.style.cssText = `display: block; margin: 25px auto 0; padding: 10px 20px; border-radius: 8px; border: 1px solid #555; cursor: pointer; background-color: #4A90E2; color: white;`;
            closeButton.onclick = hideModal;
            modal.appendChild(closeButton);
        }
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
    }

    function showSettingsModal() {
        hideModal();
        const currentModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const content = `
            <h3 style="text-align: center; color: #4A90E2;">設定</h3>
            <div style="margin-top: 20px;">
                <label for="model-input" style="display: block; margin-bottom: 8px;">分析模型名稱:</label>
                <input type="text" id="model-input" value="${currentModel}" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #555; background-color: #333; color: #f0f0f0;">
            </div>
        `;
        const modal = document.createElement('div');
        modal.innerHTML = content;

        const saveButton = document.createElement('button');
        saveButton.innerText = '儲存';
        saveButton.style.cssText = `display: block; margin: 20px auto 0; padding: 10px 20px; border-radius: 8px; border: none; cursor: pointer; background-color: #28a745; color: white;`;
        saveButton.onclick = () => {
            const newModel = document.getElementById('model-input').value;
            if (newModel) {
                localStorage.setItem(MODEL_STORAGE_KEY, newModel);
                hideModal();
                alert(`模型已更新為: ${newModel}`);
            } else {
                alert('模型名稱不可為空！');
            }
        };
        modal.appendChild(saveButton);
        showModal(modal.innerHTML);
    }

    function hideModal() {
        const modal = document.getElementById('analyzer-modal');
        const backdrop = document.getElementById('analyzer-backdrop');
        if (modal) modal.remove();
        if (backdrop) backdrop.remove();
    }

    function formatAnalysisToHtml(json) {
        return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${JSON.stringify(json, null, 2)}</pre>`;
    }
    
    function getChatIdFromUrl() {
        const hash = window.location.hash;
        if (hash && hash.startsWith('#chat=')) {
            return hash.substring('#chat='.length);
        }
        return null;
    }

    // --- INITIALIZATION ---
    async function initialize() {
        await initDB();
        
        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea')) {
                if (!document.getElementById('analyzer-controls-container')) {
                    createUI();
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('hashchange', updateUIState, false);
    }

    initialize();

})();
