// IIFE (Immediately Invoked Function Expression) to avoid polluting the global scope
(function() {
    'use strict';

    // --- CONFIGURATION ---
    const ANALYZER_MODEL = 'gpt-4o-mini'; // The "referee" model for analysis
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';

    // --- UI CREATION ---
    function createAnalyzerButton() {
        // Check if button already exists
        if (document.getElementById('analyzer-button-container')) {
            return;
        }

        const container = document.createElement('div');
        container.id = 'analyzer-button-container';
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
        `;

        const button = document.createElement('button');
        button.innerHTML = '🤖 分析對話';
        button.title = '分析當前對話中不同模型的回應';
        button.style.cssText = `
            background-color: #4A90E2;
            color: white;
            border: none;
            border-radius: 8px;
            padding: 10px 15px;
            font-size: 14px;
            cursor: pointer;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: background-color 0.3s;
        `;
        button.onmouseover = () => button.style.backgroundColor = '#357ABD';
        button.onmouseout = () => button.style.backgroundColor = '#4A90E2';
        
        button.addEventListener('click', handleAnalysisRequest);
        
        container.appendChild(button);
        document.body.appendChild(container);
    }

    // --- CORE LOGIC ---
    async function handleAnalysisRequest() {
        try {
            // 1. Get API Key
            let apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
            if (!apiKey) {
                apiKey = window.prompt('請輸入您的 OpenAI API 金鑰：');
                if (!apiKey) {
                    alert('未提供 API 金鑰，分析已取消。');
                    return;
                }
                localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
            }

            // 2. Get Chat History from IndexedDB
            showModal('讀取對話紀錄中...');
            const messages = await getChatHistory();
            if (messages.length < 2) {
                alert('當前對話訊息不足，無法進行分析。');
                hideModal();
                return;
            }

            // 3. Prepare data and call analyzer LLM
            showModal('分析中，請稍候...');
            const analysisJson = await analyzeConversation(apiKey, messages);
            
            // 4. Display result
            showModal(formatAnalysisToHtml(analysisJson), true);

        } catch (error) {
            console.error('分析擴充程式錯誤:', error);
            showModal(`<h3>發生錯誤</h3><pre style="white-space: pre-wrap; word-wrap: break-word;">${error.message}</pre>`, true);
        }
    }

    // --- DATA RETRIEVAL (INDEXEDDB) ---
    function getChatHistory() {
        return new Promise((resolve, reject) => {
            // --- 最終修正後的資料庫和 Object Store 名稱 ---
            const dbName = `typingmind-app-${window.location.host}`;
            const storeName = 'chats';
            // --- 邏輯修正結束 ---

            const request = indexedDB.open(dbName);

            request.onerror = () => reject(new Error('無法開啟 TypingMind 資料庫。'));
            
            request.onsuccess = (event) => {
                const db = event.target.result;
                
                const hash = window.location.hash;
                if (!hash ||!hash.startsWith('#chat=')) {
                    return reject(new Error('無法從 URL 中確定當前對話 ID。請先進入一個對話。'));
                }
                const chatId = hash.substring('#chat='.length);
                const currentChatKey = `CHAT_${chatId}`;

                if (!db.objectStoreNames.contains(storeName)) {
                    return reject(new Error(`在資料庫中找不到 '${storeName}' 物件儲存區。請確認 TypingMind 資料庫結構是否已變更。`));
                }
                
                const transaction = db.transaction([storeName], 'readonly');
                const objectStore = transaction.objectStore(storeName);
                const getRequest = objectStore.get(currentChatKey);

                getRequest.onerror = () => reject(new Error('讀取聊天資料時出錯。'));
                getRequest.onsuccess = () => {
                    const chatData = getRequest.result;
                    if (chatData && chatData.messages) {
                        resolve(chatData.messages);
                    } else {
                        reject(new Error('找不到對應的聊天資料或資料格式不符。'));
                    }
                };
            };
        });
    }

    // --- LLM INTERACTION ---
    async function analyzeConversation(apiKey, messages) {
        const lastUserQuestion = messages.filter(m => m.role === 'user').pop()?.content?? 'No user question found.';
        
        const transcript = messages
       .map(msg => `**${msg.role.toUpperCase()} (Model: ${msg.model?? 'N/A'})**: ${msg.content}`)
       .join('\n\n---\n\n');

        const systemPrompt = `你是一位專業、公正且嚴謹的 AI 模型評估員。你的任務是基於使用者提出的「原始問題」，對提供的「對話文字稿」中多個 AI 模型的回答進行深入的比較分析。你的分析必須客觀、有理有據，並以結構化的 JSON 格式輸出。

        分析流程：
        1.  **獨立評估每個模型**：對文字稿中每個 'assistant' 的回答進行評估，列出其優點和缺點。
        2.  **橫向比較與裁決**：比較所有回答，找出它們之間的關鍵差異點，並基於對「原始問題」的理解，判斷哪個模型的回答總體上更佳。
        3.  **提供結論**：給出詳細、令人信服的裁決理由。

        你的最終輸出**必須**是一個結構完全正確的 JSON 物件，不得包含任何額外的解釋性文字。`;

        const userContentForAnalyzer = `
        --- 原始問題 ---
        ${lastUserQuestion}

        --- 對話文字稿 ---
        ${transcript}
        `;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: ANALYZER_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContentForAnalyzer }
                ],
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤: ${response.status} - ${errorData.error?.message?? '未知錯誤'}`);
        }

        const data = await response.json();
        return JSON.parse(data.choices.message.content);
    }

    // --- UI (MODAL) ---
    function showModal(content, isResult = false) {
        hideModal(); // Remove any existing modal first

        const backdrop = document.createElement('div');
        backdrop.id = 'analyzer-backdrop';
        backdrop.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,0.5); z-index: 9999;
            opacity: 0; transition: opacity 0.3s;
        `;
        
        const modal = document.createElement('div');
        modal.id = 'analyzer-modal';
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -60%);
            width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto;
            background-color: white; color: black; border-radius: 12px;
            padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            z-index: 10000; transition: opacity 0.3s, transform 0.3s; opacity: 0;
        `;
        
        backdrop.addEventListener('click', hideModal);
        modal.innerHTML = content;

        if (isResult) {
            const closeButton = document.createElement('button');
            closeButton.innerText = '關閉';
            closeButton.style.cssText = 'display: block; margin: 20px auto 0; padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer;';
            closeButton.onclick = hideModal;
            modal.appendChild(closeButton);
        }

        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
        
        setTimeout(() => {
            backdrop.style.opacity = '1';
            modal.style.opacity = '1';
            modal.style.transform = 'translate(-50%, -50%)';
        }, 10);
    }

    function hideModal() {
        const modal = document.getElementById('analyzer-modal');
        const backdrop = document.getElementById('analyzer-backdrop');
        if (modal && backdrop) {
            document.body.removeChild(modal);
            document.body.removeChild(backdrop);
        }
    }

    function formatAnalysisToHtml(json) {
        let html = '<h3>分析報告</h3>';
        for (const key in json) {
            html += `<div style="margin-top: 15px; border-left: 3px solid #eee; padding-left: 10px;">
                        <strong style="text-transform: capitalize;">${key.replace(/_/g, ' ')}:</strong>`;
            const value = json[key];
            if (typeof value === 'object' && value!== null) {
                html += `<pre style="background-color: #f0f0f0; padding: 10px; border-radius: 6px; white-space: pre-wrap; margin-top: 5px;">${JSON.stringify(value, null, 2)}</pre>`;
            } else {
                html += `<p style="margin: 5px 0 0 0;">${value}</p>`;
            }
            html += `</div>`;
        }
        return html;
    }

    // --- INITIALIZATION ---
    function initializeExtension() {
        // Use MutationObserver to wait for the chat UI to be ready
        const observer = new MutationObserver((mutations, obs) => {
            const targetNode = document.querySelector('textarea');
            if (targetNode) {
                createAnalyzerButton();
                obs.disconnect(); // Stop observing once the button is created
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Failsafe timeout in case the target node never appears
        setTimeout(() => observer.disconnect(), 10000);
    }

    // Run initialization
    initializeExtension();

})();
