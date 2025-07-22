--- 原始程式 (clipboard.txt)  
+++ 新版本 clipboard.txt (v4.6)  
@@
 // @version      3.1  
+// @version      4.6  
@@
-    const SCRIPT_VERSION = '3.1';
+    const SCRIPT_VERSION = '4.6';
+
+    // --- STORAGE KEYS FOR MULTI-API SUPPORT ---
+    const OPENAI_KEY_STORAGE_KEY    = 'typingmind_analyzer_openai_api_key';
+    const XAI_KEY_STORAGE_KEY       = 'typingmind_analyzer_xai_api_key';
+    const GEMINI_KEY_STORAGE_KEY    = 'typingmind_analyzer_gemini_api_key';
+    const AUTO_ANALYZE_STORAGE_KEY  = 'typingmind_analyzer_auto_analyze';
+    const CUSTOM_PROMPTS_STORAGE_KEY= 'typingmind_analyzer_custom_prompts';
@@
-    const PROMPTS = [
+    // --- BUILT-IN PROMPTS (永遠可供選擇) ---
+    const BUILT_IN_PROMPTS = [
@@
-    ];
+    ];
+
+    // --- LOAD CUSTOM PROMPTS FROM STORAGE ---
+    let customPrompts = [];
+    try {
+        customPrompts = JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY) || '[]');
+    } catch (e) { customPrompts = []; }
+
+    // --- MERGED PROMPTS (包含內建 + 自定義) ---
+    let PROMPTS = [...BUILT_IN_PROMPTS, ...customPrompts];
@@
     function createUI() {
         if (document.getElementById('analyzer-controls-container')) return;
         const container = document.createElement('div');
-        container.id = 'analyzer-controls-container';
-        container.style.cssText = `position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;
+        container.id = 'analyzer-controls-container';
+        // 往上移至避免遮擋 TypingMind 按鍵
+        container.style.cssText = `position: fixed; bottom: 80px; right: 20px; z-index: 9999; display: flex; gap: 10px; align-items: center;`;
@@
     }
@@
     async function handleAnalysisRequest(isReanalysis = false) {
         const mainButton = document.getElementById('analyzer-main-button');
@@
         try {
             if (mainButton) {
@@
             if (!isReanalysis) {
@@
             let apiKey;
+            // 根據所選 MODEL 決定用哪組金鑰
+            const selectedModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
+            if (/^xai/i.test(selectedModel)) {
+                apiKey = localStorage.getItem(XAI_KEY_STORAGE_KEY);
+                if (!apiKey) {
+                    apiKey = window.prompt('請輸入您的 XAI API 金鑰：');
+                    if (!apiKey) throw new Error('未提供 XAI API 金鑰。');
+                    localStorage.setItem(XAI_KEY_STORAGE_KEY, apiKey);
+                }
+            } else if (/gemini/i.test(selectedModel)) {
+                apiKey = localStorage.getItem(GEMINI_KEY_STORAGE_KEY);
+                if (!apiKey) {
+                    apiKey = window.prompt('請輸入您的 Gemini API 金鑰：');
+                    if (!apiKey) throw new Error('未提供 Gemini API 金鑰。');
+                    localStorage.setItem(GEMINI_KEY_STORAGE_KEY, apiKey);
+                }
+            } else {
+                apiKey = localStorage.getItem(OPENAI_KEY_STORAGE_KEY);
+                if (!apiKey) {
+                    apiKey = window.prompt('請輸入您的 OpenAI API 金鑰：');
+                    if (!apiKey) throw new Error('未提供 OpenAI API 金鑰。');
+                    localStorage.setItem(OPENAI_KEY_STORAGE_KEY, apiKey);
+                }
+            }
             const { messages, modelMap } = await getTypingMindChatHistory();
+            // 取用過去一次的總結
+            const pastReports = await getReportsForChat(chatId);
+            const lastSummary = pastReports.length > 0 ? pastReports[0].report : '';
@@
             const startTime = Date.now();
-            const analysisResult = await analyzeConversation(apiKey, messages, modelMap);
+            // 傳入過去總結
+            const analysisResult = await analyzeConversation(apiKey, messages, modelMap, lastSummary);
             const duration = ((Date.now() - startTime) / 1000).toFixed(2);
@@
             const finalReportText = analysisResult.content + footer;
-            await saveReport(chatId, finalReportText);
-            showToast('總結已完成！');
-            showReportWindow(finalReportText);
+            // 一併存入 DB
+            await saveReport(chatId, finalReportText);
+
+            // 系統通知 + 頁面 toast
+            showToast('總結已完成！');
+            showSystemNotification('分析完成', '整合分析已經完成，點擊查看報告。');
+
+            // 動態標題：問題前15字 + 時間 (到分鐘)
+            const lastUserTurns = messages.filter(m => m.role === 'user');
+            const rawQ = lastUserTurns.length > 0 ? String(lastUserTurns.slice(-1)[0].content) : '';
+            const qTrim = rawQ.replace(/\s+/g, ' ').substring(0, 15) + (rawQ.length > 15 ? '…' : '');
+            const now = new Date();
+            const timestampTitle = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ` +
+                                   `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
+            const windowTitle = `${qTrim} ${timestampTitle}`;
+            showReportWindow(finalReportText, windowTitle);
         } catch (error) {
             console.error('分析擴充程式錯誤:', error);
             alert(`發生錯誤: ${error.message}`);
@@
     function analyzeConversation(apiKey, messages, modelMap) {
-        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
+    async function analyzeConversation(apiKey, messages, modelMap, pastSummary = '') {
+        const model = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_ANALYZER_MODEL;
         const temperature = parseFloat(localStorage.getItem(TEMP_STORAGE_KEY) || 1.0);
         const top_p = parseFloat(localStorage.getItem(TOPP_STORAGE_KEY) || 1.0);
@@
-        const lastUserQuestion = stringifyContent(messages.find(m => m.role === 'user')?.content) || '未找到原始問題。';
-        const transcript = messages.filter(msg => msg.role !== 'user').map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`).join('\n\n');
+        // 取最後一輪使用者提問
+        const userTurns = messages.filter(m => m.role === 'user');
+        const lastUserQuestion = stringifyContent(userTurns[userTurns.length-1]?.content) || '未找到原始問題。';
+        // 只取 AI 模型的回答
+        const transcript = messages
+            .filter(msg => msg.role === 'assistant')
+            .map(msg => `--- 模型回答 (ID: ${msg.model || 'N/A'}) ---\n${stringifyContent(msg.content)}`)
+            .join('\n\n');
+
+        // 在 prompt 中加入「過去總結」
+        let userContentForAnalyzer = `這是已知模型ID與其官方名稱的對照表，請在你的報告中優先使用官方名稱：\n`;
         for (const id in modelMap) {
             modelMapInfo += `- ${id}: ${modelMap[id]}\n`;
         }
-
-        const userContentForAnalyzer = `${modelMapInfo}\n--- 原始問題 ---\n${lastUserQuestion}\n\n--- 對話文字稿 ---\n${transcript}`;
+        userContentForAnalyzer = [
+            modelMapInfo,
+            `--- 過去總結 ---\n${pastSummary || '無過去總結'}`,
+            `--- 原始問題 ---\n${lastUserQuestion}`,
+            `--- AI 模型回答 ---\n${transcript}`
+        ].join('\n\n');
@@
-        const requestBody = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContentForAnalyzer }], temperature, top_p };
+        const requestBody = {
+            model,
+            messages: [
+                { role: 'system', content: systemPrompt },
+                { role: 'user', content: userContentForAnalyzer }
+            ],
+            temperature, top_p
+        };
         if (reasoningEffort) { requestBody.reasoning_effort = reasoningEffort; }
@@
-        const response = await fetch('https://api.openai.com/v1/chat/completions', {
+        // TODO: 支援 XAI / Gemini API endpoint (目前僅 OpenAI)
+        const response = await fetch('https://api.openai.com/v1/chat/completions', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
             body: JSON.stringify(requestBody)
@@
     }
+
+    // --- Windows 11 系統通知 --- 
+    function showSystemNotification(title, body) {
+        if (!("Notification" in window)) return;
+        if (Notification.permission === "granted") {
+            new Notification(title, { body });
+        } else if (Notification.permission !== "denied") {
+            Notification.requestPermission().then(permission => {
+                if (permission === "granted") {
+                    new Notification(title, { body });
+                }
+            });
+        }
+    }
+
+    // --- 修改 showReportWindow: 可自訂標題 & 加入「複製統整摘要」按鈕 ---
     function showReportWindow(reportText) {
-        const contentNode = document.createElement('div');
-        contentNode.innerHTML = formatMarkdownToHtml(reportText);
-        createFloatingWindow('整合分析報告', contentNode);
+    function showReportWindow(reportText, customTitle) {
+        const contentNode = document.createElement('div');
+        contentNode.innerHTML = formatMarkdownToHtml(reportText);
+        // 建立按鈕
+        const copyBtn = document.createElement('button');
+        copyBtn.textContent = '📋 複製統整摘要';
+        copyBtn.title = '只複製「權威性統整回答」區段';
+        copyBtn.style.cssText = `margin-right:8px;padding:4px 8px;border-radius:4px;border:none;background:#4A90E2;color:#fff;cursor:pointer;`;
+        copyBtn.onclick = () => {
+            const match = reportText.match(/###\s*3\.[\s\S]*?(?=^###\s*\d|\z)/m);
+            const summary = match ? match[0].trim() : reportText;
+            navigator.clipboard.writeText(summary).then(() => showToast('已複製統整摘要'));
+        };
+        createFloatingWindow(customTitle || '整合分析報告', contentNode, { actions: [copyBtn] });
     }
@@
     function showSettingsWindow() {
         const contentNode = document.createElement('div');
@@
-        const saveHandler = () => {
+        const saveHandler = () => {
             localStorage.setItem(PROMPT_STORAGE_KEY, contentNode.querySelector('#prompt-select').value);
             localStorage.setItem(MODEL_STORAGE_KEY, contentNode.querySelector('#model-input').value);
             localStorage.setItem(REASONING_EFFORT_STORAGE_KEY, contentNode.querySelector('#reasoning-input').value);
             localStorage.setItem(TEMP_STORAGE_KEY, contentNode.querySelector('#temp-input').value);
             localStorage.setItem(TOPP_STORAGE_KEY, contentNode.querySelector('#topp-input').value);
+            // API Keys
+            localStorage.setItem(OPENAI_KEY_STORAGE_KEY, contentNode.querySelector('#openai-key').value.trim());
+            localStorage.setItem(XAI_KEY_STORAGE_KEY, contentNode.querySelector('#xai-key').value.trim());
+            localStorage.setItem(GEMINI_KEY_STORAGE_KEY, contentNode.querySelector('#gemini-key').value.trim());
+            // 自動分析
+            localStorage.setItem(AUTO_ANALYZE_STORAGE_KEY, contentNode.querySelector('#auto-analyze').checked ? '1' : '0');
             hideWindow();
             alert(`設定已儲存！`);
         };
@@
-        createFloatingWindow('設定', contentNode);
+        // 加入「管理自定義提示詞」按鈕
+        const manageCustomBtn = document.createElement('button');
+        manageCustomBtn.textContent = '📝 管理自定義提示詞';
+        manageCustomBtn.style.cssText = `margin-top:10px; background:#f9f9f9; border:1px solid #ccc; padding:6px 12px; border-radius:4px; cursor:pointer;`;
+        manageCustomBtn.onclick = () => {
+            hideWindow();
+            showCustomPromptsWindow();
+        };
+        contentNode.insertBefore(manageCustomBtn, contentNode.lastElementChild);
+
+        createFloatingWindow('設定', contentNode);
     }
+
+    // --- 自定義提示詞編輯視窗 ---
+    function showCustomPromptsWindow() {
+        const w = document.createElement('div');
+        let html = '<div style="max-height:300px;overflow:auto;">';
+        customPrompts.forEach((p, i) => {
+            html += `<div data-index="${i}" style="margin-bottom:10px;padding:8px;border:1px solid #ddd;border-radius:6px;">
+                        <input class="cp-title" placeholder="標題" value="${p.title}" style="width:100%;margin-bottom:4px;padding:4px;">
+                        <textarea class="cp-body" placeholder="提示詞內容" style="width:100%;height:80px;padding:4px;">${p.prompt}</textarea>
+                        <button class="cp-del" style="float:right;background:#e74c3c;color:#fff;border:none;padding:2px 6px;border-radius:4px;cursor:pointer;">刪除</button>
+                    </div>`;
+        });
+        html += '</div>';
+        html += '<button id="add-cp" style="margin-bottom:10px;background:#4A90E2;color:#fff;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;">＋ 新增提示詞</button>';
+        html += '<div style="text-align:right;margin-top:12px;"><button id="save-cp" style="background:#28a745;color:#fff;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;">儲存</button></div>';
+        w.innerHTML = html;
+        createFloatingWindow('管理自定義提示詞', w);
+        w.querySelectorAll('.cp-del').forEach(btn => {
+            btn.onclick = e => {
+                const idx = +e.currentTarget.closest('div[data-index]').dataset.index;
+                customPrompts.splice(idx,1);
+                showCustomPromptsWindow();
+            };
+        });
+        w.querySelector('#add-cp').onclick = () => {
+            customPrompts.push({ title:'', prompt:'' });
+            showCustomPromptsWindow();
+        };
+        w.querySelector('#save-cp').onclick = () => {
+            const cards = w.querySelectorAll('div[data-index]');
+            customPrompts = [];
+            cards.forEach(div=>{
+                const t = div.querySelector('.cp-title').value.trim();
+                const b = div.querySelector('.cp-body').value.trim();
+                if (t && b) customPrompts.push({ title:t, prompt:b });
+            });
+            localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(customPrompts));
+            PROMPTS = [...BUILT_IN_PROMPTS, ...customPrompts];
+            hideWindow();
+            alert('自定義提示詞已更新');
+        };
+    }
@@
     async function initialize() {
         console.log(`TypingMind Analyzer Script v${SCRIPT_VERSION} Initialized`);
         await initDB();
+        // 讓 PROMPTS 可動態更新
+        PROMPTS = [...BUILT_IN_PROMPTS, ...customPrompts];
+
         // More robust state update logic
         let lastSeenChatId = null;
         setInterval(() => {
             const currentChatId = getChatIdFromUrl();
             if (currentChatId !== lastSeenChatId) {
                 lastSeenChatId = currentChatId;
                 updateUIState();
             }
         }, 500); // Check every 500ms
@@
         const observer = new MutationObserver(() => {
             if (document.querySelector('textarea') && !document.getElementById('analyzer-controls-container')) {
                 createUI();
             }
         });
         observer.observe(document.body, { childList: true, subtree: true });
+
+        // --- 自動整合機制 ---
+        const autoCheck = () => {
+            const enabled = localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY) === '1';
+            if (!enabled) return;
+            const chatId = getChatIdFromUrl();
+            if (!chatId) return;
+            // 若尚未儲存過報告，且已經有 AI model 回答，則觸發分析
+            getReportsForChat(chatId).then(reports => {
+                if (reports.length === 0) {
+                    getTypingMindChatHistory().then(({ messages }) => {
+                        const assistantCount = messages.filter(m=>m.role==='assistant').length;
+                        if (assistantCount > 0) {
+                            handleAnalysisRequest(false);
+                        }
+                    }).catch(()=>{});
+                }
+            });
+        };
+        // 每 1 秒檢查一次
+        setInterval(autoCheck, 1000);
     }
