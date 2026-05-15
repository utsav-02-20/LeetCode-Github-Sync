// Content script — injected into leetcode.com
// Detects accepted submissions via DOM + network interception

(function () {
  'use strict';

  let lastSubmissionId = null;
  let isInitialized = false;
  
  // Track synced problems for the current page session
  const _syncedThisLoad = new Set();

  // ─── Network Interception ─────────────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;

  // Intercept fetch (LeetCode uses GraphQL via fetch)
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = args[0]?.toString() || '';
      if (url.includes('leetcode.com/graphql') || url.includes('/submissions/')) {
        const cloned = response.clone();
        cloned.json().then(data => handleAPIResponse(data, url)).catch(() => {});
      }
    } 
    catch (e) { 
      console.error('[LeetSync] Error intercepting fetch:', e); 
    }

    return response;
  };

  // ─── API Response Handler ─────────────────────────────────────────────────

  function handleAPIResponse(data, url) {
    if (!data) return;

    // GraphQL submission result
    if (data.data) {
      const d = data.data;

      // submissionDetails query
      if (d.submissionDetails) {
        const sub = d.submissionDetails;
        if (sub.statusDisplay === 'Accepted') {
          handleAcceptedSubmission(sub);
        }
      }

      // submissionList
      if (d.submissionList && d.submissionList.submissions) {
        // Not triggered here — only on real-time accept
      }
    }
  }

  // ─── DOM Observer ─────────────────────────────────────────────────────────

  const observer = new MutationObserver(debounce(checkForAccepted, 500));

  function startObserver() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function checkForAccepted() {
    if (!window.location.pathname.includes('/problems/')) return;

    // Already handled this page load
    const slug = extractSlugFromURL();
    if (slug && _syncedThisLoad.has(slug)) return;

    // Look for "Accepted" result text on submission result pages
    const acceptedIndicators = [
      '#submission-status-accepted', // New preferred ID selector
      '[data-e2e-locator="submission-result"]',
      '.text-green-s',
      '.text-\\[\\#00b8a3\\]',
      'span[class*="text-green"]'
    ];

    for (const selector of acceptedIndicators) {
      try {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim() === 'Accepted') {
          extractAndSync();
          return;
        }
      } catch (e) { /* invalid selector, skip */ }
    }

    // Brute-force text scan (fallback)
    const allSpans = document.querySelectorAll('span, h3, div');
    for (const el of allSpans) {
      if (el.children.length === 0 && el.textContent.trim() === 'Accepted') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          extractAndSync();
          return;
        }
      }
    }
  }

  // ─── Extraction & Sync ────────────────────────────────────────────────────

  async function handleAcceptedSubmission(submissionData) {
    const slug = submissionData.question?.titleSlug || extractSlugFromURL();
    if (!slug || _syncedThisLoad.has(slug)) return;

    const submissionId = submissionData.id || submissionData.submissionId;
    if (submissionId && submissionId === lastSubmissionId) return;
    lastSubmissionId = submissionId;

    const problem = {
      id: submissionData.question?.questionId || extractIdFromPage(),
      title: submissionData.question?.title || extractTitleFromPage(),
      slug: slug,
      difficulty: submissionData.question?.difficulty || extractDifficultyFromPage(),
      tags: (submissionData.question?.topicTags || []).map(t => t.name || t),
      language: submissionData.lang || extractLanguageFromPage(),
      runtime: submissionData.runtimeDisplay || submissionData.runtime,
      memory: submissionData.memoryDisplay || submissionData.memory,
      submissionId,
      submittedAt: submissionData.timestamp || submissionData.submitTime || submissionData.createdAt,
      code: submissionData.code || extractCodeFromEditor()
    };

    if (!problem.code) {
      console.warn('[LeetSync] Could not extract code, retrying...');
      await sleep(1000);
      problem.code = extractCodeFromEditor();
    }

    if (!problem.id || !problem.code) {
      console.warn('[LeetSync] Missing required fields, skipping sync.');
      return;
    }

    _syncedThisLoad.add(slug);
    chrome.runtime.sendMessage({
      type: 'SYNC_PROBLEM',
      problem
    });
  }

  async function extractAndSync() {
    const slug = extractSlugFromURL();
    if (!slug || _syncedThisLoad.has(slug)) return;

    await sleep(1200); // let editor initialize

    const problem = {
      id:          extractIdFromPage(),
      title:       extractTitleFromPage(),
      slug:        slug,
      difficulty:  extractDifficultyFromPage(),
      tags:        extractTagsFromPage(),
      language:    extractLanguageFromPage(),
      code:        extractCodeFromEditor()
    };

    if (!problem.code) {
      // Some LeetCode pages mount editor late; retry a few times.
      for (let i = 0; i < 4 && !problem.code; i++) {
        await sleep(800);
        problem.code = extractCodeFromEditor();
      }
    }

    if (!problem.id || !problem.code) {
      console.warn('[LeetSync] Extraction failed — id:', problem.id, 'code:', !!problem.code);
      return;
    }

    _syncedThisLoad.add(slug);
    chrome.runtime.sendMessage({ type: 'SYNC_PROBLEM', problem });
  }

  // ─── DOM Extraction Helpers ───────────────────────────────────────────────

  function extractIdFromPage() {
  // Method 1: from page URL + document title
  const titleTag = document.title; // "1. Two Sum - LeetCode"
  const titleMatch = titleTag.match(/^(\d+)\./);
  if (titleMatch) return titleMatch[1];

  // Method 2: from breadcrumb / heading
  const allText = document.querySelectorAll('a, span, div, h4');
  for (const el of allText) {
    if (el.children.length === 0) {
      const m = el.textContent.trim().match(/^(\d+)\.\s+\w/);
      if (m) return m[1];
    }
  }

  // Method 3: from URL path (for /problems/two-sum/ style - no ID, skip)
  return null;
  }

  function extractTitleFromPage() {
    const sel = [
      '[data-cy="question-title"]',
      'a[href*="/problems/"] span',
      'h4',
      '.mr-2.text-lg.font-medium'
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) {
        const text = el.textContent.trim();
        return text.replace(/^\d+\.\s*/, '');
      }
    }
    return 'Unknown Problem';
  }

  function extractSlugFromURL() {
    const match = window.location.pathname.match(/\/problems\/([^/]+)/);
    return match ? match[1] : null;
  }

  function extractDifficultyFromPage() {
    const diffs = ['Easy', 'Medium', 'Hard'];
    for (const diff of diffs) {
      const el = Array.from(document.querySelectorAll('span, div')).find(
        e => e.textContent.trim() === diff && e.children.length === 0
      );
      if (el) return diff;
    }
    return null;
  }

  function extractTagsFromPage() {
    const tagEls = document.querySelectorAll(
      'a[href*="/tag/"], [data-topic], .topic-tag__1jni'
    );
    return Array.from(tagEls).map(el => el.textContent.trim()).filter(Boolean);
  }

  function extractLanguageFromPage() {
    const langBtns = document.querySelectorAll('button');
    const langs = ['C++', 'Java', 'Python', 'Python3', 'JavaScript', 'TypeScript', 'Go', 'Rust', 'Kotlin', 'C', 'C#', 'Swift'];
    for (const btn of langBtns) {
      const text = btn.textContent.trim();
      if (langs.includes(text)) return text;
    }
    // Check select elements
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const val = sel.value;
      if (langs.some(l => l.toLowerCase() === val.toLowerCase())) return val;
    }
    return 'C++'; // Default for CP folks
  }

function extractCodeFromEditor() {
  // Method 1: Monaco (primary - most reliable)
  try {
    if (window.monaco?.editor) {
      const editors = window.monaco.editor.getEditors();
      if (editors.length > 0) return editors[0].getValue();
      // Also try getModels
      const models = window.monaco.editor.getModels();
      if (models.length > 0) return models[0].getValue();
    }
  } catch (e) {}

  // Method 2: React fiber internal state (LeetCode stores code here)
  try {
    const editorEl = document.querySelector('.monaco-editor');
    if (editorEl) {
      const fiberKey = Object.keys(editorEl).find(k => k.startsWith('__reactFiber'));
      let fiber = editorEl[fiberKey];
      while (fiber) {
        if (fiber.memoizedProps?.value && typeof fiber.memoizedProps.value === 'string') {
          return fiber.memoizedProps.value;
        }
        fiber = fiber.return;
      }
    }
  } catch (e) {}

  // Method 3: view-lines DOM scrape
  const lines = document.querySelectorAll('.view-lines .view-line');
  if (lines.length > 0) {
    return Array.from(lines).map(l => l.innerText).join('\n');
  }

  // Method 4: CodeMirror fallback
  const cm = document.querySelector('.CodeMirror');
  if (cm?.CodeMirror) return cm.CodeMirror.getValue();

  // Method 5: Page-context Monaco bridge (works when isolated world can't read window.monaco)
  const bridgedCode = getCodeViaPageContext();
  if (bridgedCode) return bridgedCode;

  return null;
}

function getCodeViaPageContext() {
  const key = `__leetsync_code_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let captured = null;

  function onCode(event) {
    if (event?.detail?.key !== key) return;
    captured = typeof event.detail.code === 'string' ? event.detail.code : null;
  }

  window.addEventListener('LEETSYNC_CODE_BRIDGE', onCode, { once: true });
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      var key = ${JSON.stringify(key)};
      var code = null;
      try {
        if (window.monaco && window.monaco.editor) {
          var editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
          if (editors && editors.length > 0 && editors[0] && typeof editors[0].getValue === 'function') {
            code = editors[0].getValue();
          } else {
            var models = window.monaco.editor.getModels ? window.monaco.editor.getModels() : [];
            if (models && models.length > 0 && models[0] && typeof models[0].getValue === 'function') {
              code = models[0].getValue();
            }
          }
        }
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('LEETSYNC_CODE_BRIDGE', { detail: { key: key, code: code } }));
    })();
  `;

  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
  window.removeEventListener('LEETSYNC_CODE_BRIDGE', onCode);
  return captured;
}

  // ─── Utilities ────────────────────────────────────────────────────────────

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    if (isInitialized) return;
    isInitialized = true;
    startObserver();
    console.log('[LeetSync] Content script initialized on', window.location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Handle SPA navigation (LeetCode is React-based)
  let lastURL = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastURL) {
      lastURL = window.location.href;
      setTimeout(checkForAccepted, 2000);
    }
  }).observe(document, { subtree: true, childList: true });

})();
