// ==UserScript==
// @name         TypingMind 對話分析器
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  分析 TypingMind 對話中不同模型的回應，並提供設定介面與報告儲存功能。
// @author       Gemini
// @match        https://www.typingmind.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const SCRIPT_VERSION = '2.5';
    const DEFAULT_ANALYZER_MODEL = 'gpt-4o-mini';
    const API_KEY_STORAGE_KEY = 'typingmind_analyzer_openai_api_key';
    const MODEL_STORAGE_KEY = 'typingmind_analyzer_model';

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
        mainButton.onmouseover = () => mainButton.style.backgroundColor = '#357ABD';
        mainButton.onmouseout = () => mainButton.style.backgroundColor = '#4A90E2';
        const reanalyzeButton = document.createElement('button');
        reanalyzeButton.id = 'analyzer-reanalyze-button';
        reanalyzeButton.innerHTML = '🔄';
        reanalyzeButton.title = '重新分析';
        reanalyzeButton.style.cssText = `background-color: #6c757d; color: white; border: none; border-radius: 50%; width: 38px; height: 38px; font-size: 18px; cursor: pointer; display: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.3s;`;
        reanalyzeButton.onclick = () => handleAnalysisRequest(true);
        const settingsButton = document.createElement('button');
        settingsButton.innerHTML = '⚙️';
        settingsButton.title = '設定分析模型';
        settingsButton.style.cssText = `background-color: #f0f0f0; color: #333; border: 1px solid #ccc; border-radius: 50%; width: 38px; height: 38px; font-size: 20px; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.3s;`;
        settingsButton.onclick = showSettingsModal;
        container.appendChild(reanalyzeButton);
        container.appendChild(mainButton);
        container.appendChild(settingsButton);
        document.body.appendChild(container);
        updateUIState();
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
            mainButton.onclick = () => showReportModal(existingReport.report);
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
        if (!chatId) return;
        if (!isReanalysis) {
            const existingReport = await getReport(chatId);
            if (existingReport) {
                showReportModal(existingReport.report);
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
            showInfoModal('讀取對話紀錄中...');
            const messages = await getTypingMindChatHistory();
            if (messages.length < 2) {
                hideModal();
                alert('當前對話訊息不足，無法進行分析。');
                return;
            }
            showInfoModal('分析中，請稍候...');
            const analysisText = await analyzeConversation(apiKey, messages);
            await saveReport(chatId, analysisText);
            hideModal();
            showReportModal(analysisText);
            updateUIState();
        } catch (error) {
            console.error('分析擴充程式錯誤:', error);
            hideModal();
            showInfoModal(`<h3>發生錯誤</h3><pre>${error.message}</pre>`, true);
        }
    }

    // --- DATA RETRIEVAL (TypingMind's DB) ---
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
                                    const messagesWithModel = response.messages.map(msg => ({ ...msg, model: response.model }));
                                    allMessages.push(...messagesWithModel);
                                }
                            }
                        } else if (turn.role === 'assistant') allMessages.push(turn);
                    }
                    resolve(allMessages);
                };
            };
        });
    }

    // --- LLM INTERACTION - [MODIFIED SECTION V2.5] ---
    async function analyzeConversation(apiKey, messages) {
        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
        const stringifyContent = (content) => {
            if (content === null || content === undefined) return '';
            if (typeof content === 'string') return content;
            return JSON.stringify(content, null, 2);
        };
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const lastUserQuestion = lastUserMsg ? stringifyContent(lastUserMsg.content) : 'No user question found.';
        const transcript = messages.map(msg => {
            const contentStr = stringifyContent(msg.content);
            const modelId = msg.model || 'N/A';
            return `**${(msg.role ?? 'system_note').toUpperCase()} (Model: ${modelId})**: ${contentStr}`;
        }).join('\n\n---\n\n');

        // New prompt asking for Markdown instead of JSON
        const systemPrompt = `你是一位專業、公正且嚴謹的 AI 模型評估員。你的任務是基於使用者提出的「原始問題」，對提供的「對話文字稿」中多個 AI 模型的回答進行深入的比較分析。你的分析必須客觀、有理有據。

請使用清晰的 Markdown 格式來組織你的回答，應包含以下部分：
- ### 總體評價
  (簡要說明哪個模型的回答總體更佳，並陳述核心理由。)
- ### 各模型優點
  (使用列表分別陳述每個模型回答的突出優點。)
- ### 各模型缺點
  (使用列表分別陳述每個模型回答的明顯缺點或可改進之處。)
- ### 結論與建議
  (提供最終的裁決總結或改進建議。)`;
        
        const userContentForAnalyzer = `--- 原始問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }],
                // REMOVED: response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API 錯誤 (${model}): ${response.status} - ${errorData.error?.message ?? '未知錯誤'}`);
        }
        
        const data = await response.json();
        // Return the text content directly, no more JSON.parse()
        return data.choices[0].message.content;
    }
    
    // --- UI (MODALS) ---
    function createModal(contentNode) {
        hideModal(); 
        document.body.classList.add('analyzer-modal-open');
        const overlay = document.createElement('div');
        overlay.id = 'analyzer-overlay';
        overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.65); z-index: 10000; overflow-y: auto; padding: 40px 20px; box-sizing: border-box; display: flex; justify-content: center;`;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hideModal();
        });
        const contentBox = document.createElement('div');
        contentBox.id = 'analyzer-content-box';
        contentBox.style.cssText = `width: 100%; max-width: 800px; margin: auto 0; background-color: #ffffff; color: #1a1a1a; border-radius: 12px; padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;`;
        contentBox.appendChild(contentNode);
        overlay.appendChild(contentBox);
        document.body.appendChild(overlay);
    }

    function showInfoModal(htmlContent, addCloseButton = false) {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = htmlContent;
        if (addCloseButton) {
            const closeButton = createButton('關閉', hideModal, 'blue');
            closeButton.style.marginTop = '20px';
            contentNode.appendChild(closeButton);
        }
        createModal(contentNode);
    }

    function showReportModal(reportText) {
        const contentNode = document.createElement('div');
        // The report is now text/markdown, so we pass it to the formatter
        contentNode.innerHTML = formatAnalysisToHtml(reportText);
        const closeButton = createButton('關閉', hideModal, 'blue');
        closeButton.style.marginTop = '20px';
        contentNode.appendChild(closeButton);
        createModal(contentNode);
    }

    function showSettingsModal() {
        const contentNode = document.createElement('div');
        contentNode.innerHTML = `
            <h3 style="text-align: center; color: #333; margin-top: 0;">設定</h3>
            <div style="margin-top: 20px;">
                <label for="model-input" style="display: block; margin-bottom: 8px; color: #333;">分析模型名稱:</label>
                <input type="text" id="model-input" value="${localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL}" style="width: 100%; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid #ccc; background-color: #fff; color: #333; font-size: 14px;">
            </div>`;
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; align-items: center; border-top: 1px solid #eee; padding-top: 20px;`;
        const versionDiv = document.createElement('div');
        versionDiv.style.cssText = `font-size: 12px; color: #999; margin-right: auto;`;
        versionDiv.textContent = `Version: ${SCRIPT_VERSION}`;
        const saveHandler = () => {
            const newModel = document.getElementById('model-input').value;
            if (newModel) {
                localStorage.setItem(MODEL_STORAGE_KEY, newModel);
                hideModal();
                alert(`模型已更新為: ${newModel}`);
            } else {
                alert('模型名稱不可為空！');
            }
        };
        const saveButton = createButton('儲存', saveHandler, 'green');
        const closeButton = createButton('取消', hideModal, 'grey');
        buttonContainer.appendChild(versionDiv);
        buttonContainer.appendChild(closeButton);
        buttonContainer.appendChild(saveButton);
        contentNode.appendChild(buttonContainer);
        createModal(contentNode);
    }

    function createButton(text, onClick, colorScheme = 'grey') {
        const button = document.createElement('button');
        button.innerText = text;
        const styles = {
            grey: { bg: '#6c757d', hover: '#5a6268' },
            blue: { bg: '#007bff', hover: '#0069d9' },
            green: { bg: '#28a745', hover: '#218838' }
        };
        const style = styles[colorScheme] || styles.grey;
        button.style.cssText = `padding: 10px 20px; border-radius: 8px; border: none; cursor: pointer; color: white; font-size: 14px; font-weight: 500; transition: background-color 0.2s;`;
        button.style.backgroundColor = style.bg;
        button.onmouseover = () => button.style.backgroundColor = style.hover;
        button.onmouseout = () => button.style.backgroundColor = style.bg;
        button.onclick = onClick;
        return button;
    }

    function hideModal() {
        const overlay = document.getElementById('analyzer-overlay');
        if (overlay) overlay.remove();
        document.body.classList.remove('analyzer-modal-open');
    }
    
    // --- [MODIFIED SECTION V2.5] ---
    // This function now converts Markdown to HTML
    function formatAnalysisToHtml(markdownText) {
        if (!markdownText) return '無分析內容。';

        // Basic sanitization
        let html = markdownText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Markdown to HTML conversion
        html = html
            // Headings (e.g., ### Title)
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            // Bold (**text**)
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            // Italic (*text*)
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            // List items (- item or * item)
            .replace(/^\s*[-*] (.*$)/gim, '<li>$1</li>');

        // Wrap adjacent list items in <ul>
        html = html.replace(/<li>(.*?)<\/li>\s*(?=<li)/g, '<li>$1</li>');
        html = html.replace(/(<li>.*?<\/li>)/g, '<ul>$1</ul>');
        html = html.replace(/<\/ul>\s*<ul>/g, '');
        
        // Final container
        return `<div class="markdown-body" style="line-height: 1.7; font-size: 15px;">${html.replace(/\n/g, '<br>')}</div>`;
    }
    
    function getChatIdFromUrl() {
        const hash = window.location.hash;
        return (hash && hash.startsWith('#chat=')) ? hash.substring('#chat='.length) : null;
    }

    // --- INITIALIZATION ---
    async function initialize() {
        const styleSheet = document.createElement("style");
        styleSheet.type = "text/css";
        styleSheet.innerText = ".analyzer-modal-open { overflow: hidden; }";
        document.head.appendChild(styleSheet);
        console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
        await initDB();
        const observer = new MutationObserver(() => {
            if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                createUI();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('hashchange', updateUIState, false);
    }

    initialize();

})();
