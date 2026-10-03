// Main-world script injected into leetcode.com
// Intercepts window.fetch calls to capture LeetCode GraphQL responses (e.g. submissionDetails, submit)

(function () {
  'use strict';

  if (window.__leetsync_injected) return;
  window.__leetsync_injected = true;

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = args[0]?.toString() || '';
      if (url.includes('leetcode.com/graphql')) {
        const cloned = response.clone();
        cloned.json().then(data => {
          if (!data) return;

          // Process GraphQL submission details or result payload
          if (data.data) {
            const d = data.data;

            if (d.submissionDetails) {
              const sub = d.submissionDetails;
              const status = sub.statusDisplay || sub.status_display || sub.status_msg || '';
              if (status.toLowerCase().includes('accepted')) {
                dispatchSubmission(sub);
              }
            } else if (d.submissionCheck) {
              const sub = d.submissionCheck;
              const status = sub.statusDisplay || sub.status_display || sub.status_msg || '';
              if (status.toLowerCase().includes('accepted')) {
                dispatchSubmission(sub);
              }
            }
          }
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[LeetSync Main-World] Error intercepting fetch:', e);
    }

    return response;
  };

  function dispatchSubmission(sub) {
    try {
      window.dispatchEvent(new CustomEvent('LEETSYNC_GRAPHQL_SUBMISSION', {
        detail: JSON.stringify(sub)
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('LEETSYNC_GRAPHQL_SUBMISSION', {
        detail: sub
      }));
    }
  }

  console.log('[LeetSync] Main-world interceptor loaded.');
})();
