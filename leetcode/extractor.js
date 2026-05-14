// LeetCode data extraction — DOM + network interception

export class LeetCodeExtractor {
  /**
   * Extracts problem metadata from the current LeetCode page.
   * Works on /problems/{slug}/submissions/ or /problems/{slug}/
   */
  static extractMetaFromDOM() {
    const meta = {};

    // Problem title — multiple selectors for robustness
    const titleEl =
      document.querySelector('[data-cy="question-title"]') ||
      document.querySelector('.mr-2.text-lg') ||
      document.querySelector('a[href*="/problems/"] .title') ||
      document.querySelector('div[class*="title__"') ||
      document.querySelector('h4') ||
      document.querySelector('.css-v3d350');

    if (titleEl) {
      const text = titleEl.textContent.trim();
      // "48. Rotate Image" → id=48, title="Rotate Image"
      const match = text.match(/^(\d+)\.\s+(.+)$/);
      if (match) {
        meta.id = match[1];
        meta.title = match[2].trim();
      } else {
        meta.title = text;
      }
    }

    // Difficulty badge
    const diffEl =
      document.querySelector('[diff]') ||
      document.querySelector('[class*="diff-"]') ||
      document.querySelector('.difficulty-label') ||
      Array.from(document.querySelectorAll('span')).find(
        el => ['Easy', 'Medium', 'Hard'].includes(el.textContent.trim())
      );
    if (diffEl) meta.difficulty = diffEl.textContent.trim();

    // Tags
    const tagEls = document.querySelectorAll(
      'a[href*="/tag/"], [class*="topic-tag"], [data-topic]'
    );
    meta.tags = Array.from(tagEls).map(el => el.textContent.trim()).filter(Boolean);

    // Slug from URL
    const slugMatch = window.location.pathname.match(/\/problems\/([^/]+)/);
    if (slugMatch) meta.slug = slugMatch[1];

    return meta;
  }

  /**
   * Extracts code from the Monaco editor on LeetCode
   */
  static extractCodeFromEditor() {
    // Monaco editor model — most reliable method
    if (window.monaco && window.monaco.editor) {
      const editors = window.monaco.editor.getEditors();
      if (editors.length > 0) {
        return editors[0].getValue();
      }
    }

    // Fallback: CodeMirror
    const cmInstance = document.querySelector('.CodeMirror');
    if (cmInstance && cmInstance.CodeMirror) {
      return cmInstance.CodeMirror.getValue();
    }

    // Fallback: textarea with code
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (ta.value && ta.value.length > 10) return ta.value;
    }

    // DOM scrape fallback
    const codeLines = document.querySelectorAll('.view-line');
    if (codeLines.length > 0) {
      return Array.from(codeLines).map(l => l.textContent).join('\n');
    }

    return null;
  }

  /**
   * Extracts selected language from LeetCode UI
   */
  static extractLanguage() {
    // Language selector button text
    const langBtn =
      document.querySelector('[id*="lang"] button') ||
      document.querySelector('button[id*="headlessui"] span') ||
      document.querySelector('[data-cy="lang-select"] span') ||
      Array.from(document.querySelectorAll('button')).find(
        btn => /^(C\+\+|Java|Python|Python3|JavaScript|TypeScript|Go|Rust|Kotlin|C|C#|Swift)$/i.test(btn.textContent.trim())
      );

    return langBtn ? langBtn.textContent.trim() : 'Unknown';
  }

  /**
   * Parses a submission result API response (GraphQL)
   */
  static parseSubmissionResult(data) {
    if (!data) return null;

    // GraphQL submissionDetails response
    const sub = data.submissionDetails || data.submission || data;

    if (!sub) return null;

    const statusDisplay = sub.statusDisplay || sub.status_display || '';
    if (!statusDisplay.toLowerCase().includes('accepted')) return null;

    return {
      id: sub.question?.questionId || sub.questionId,
      title: sub.question?.title || sub.title,
      slug: sub.question?.titleSlug || sub.titleSlug,
      difficulty: sub.question?.difficulty || sub.difficulty,
      tags: (sub.question?.topicTags || []).map(t => t.name),
      language: sub.lang || sub.language,
      runtime: sub.runtime ? `${sub.runtime} ms` : null,
      memory: sub.memory ? `${sub.memory} MB` : null,
      code: sub.code,
      submittedAt: sub.timestamp
    };
  }

  /**
   * Checks if current page shows an Accepted result
   */
  static isAcceptedPage() {
    // Check submission result page
    const resultText = document.body.innerText || '';

    // Check for "Accepted" text in result elements
    const acceptedEl =
      document.querySelector('[data-e2e-locator="submission-result"]') ||
      document.querySelector('.success__3Ai7') ||
      document.querySelector('[class*="accepted"]') ||
      Array.from(document.querySelectorAll('span, div, h3')).find(
        el => el.textContent.trim() === 'Accepted'
      );

    return !!acceptedEl;
  }
}
