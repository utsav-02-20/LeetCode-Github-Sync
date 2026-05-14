🚀 Overview
LeetSync is a Chrome Extension designed to transform your LeetCode journey into a professional-grade GitHub portfolio. Unlike basic sync tools, LeetSync features a Smart-Log Engine that tracks your submission history to ensure your repository stays updated without redundant commits or wasted API calls.

✨ Key Features
Instant Automation: Automatically pushes code to GitHub the moment you hit "Accepted."

Incremental Sync Logic: Uses a sync_log.json file to compare submission IDs, ensuring only new or improved solutions are uploaded.

Chronological Backups: Reconstructs your LeetCode history in order, so your GitHub contribution graph reflects your actual progress.

Professional Organization: Categorizes solutions by difficulty and topic with customizable file-naming conventions.

Live Analytics Dashboard: Track your problem-solving stats, language distribution, and sync history directly from the extension popup.

3. The Technical Highlights (For your "Portfolio")
If you are showing this to a recruiter or a peer, use this description to highlight the engineering behind it:

Architecture: Built using Manifest V3 for modern security and performance.

API Integration: Leverages GitHub REST API v3 for repository management and file manipulation.

State Management: Implements an asynchronous sync queue to handle high-frequency submissions and prevent race conditions.

Data Integrity: Developed a Remote-Log Synchronization strategy that allows the extension to remain "stateless" across different browsers by fetching the current sync state directly from the GitHub repository.
