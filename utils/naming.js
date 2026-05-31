// File naming and path utilities

const LANGUAGE_EXTENSIONS = {
  'cpp': 'cpp',
  'c++': 'cpp',
  'java': 'java',
  'python': 'py',
  'python3': 'py',
  'javascript': 'js',
  'typescript': 'ts',
  'go': 'go',
  'rust': 'rs',
  'kotlin': 'kt',
  'c': 'c',
  'csharp': 'cs',
  'c#': 'cs',
  'swift': 'swift',
  'scala': 'scala',
  'ruby': 'rb',
  'php': 'php'
};

const TOPIC_FOLDER_MAP = {
  'array': 'Arrays',
  'string': 'Strings',
  'hash table': 'Hash Tables',
  'dynamic programming': 'DP',
  'math': 'Math',
  'sorting': 'Sorting',
  'greedy': 'Greedy',
  'depth-first search': 'Graphs',
  'breadth-first search': 'Graphs',
  'binary search': 'Binary Search',
  'tree': 'Trees',
  'binary tree': 'Trees',
  'binary search tree': 'Trees',
  'graph': 'Graphs',
  'two pointers': 'Two Pointers',
  'sliding window': 'Sliding Window',
  'stack': 'Stack',
  'queue': 'Queue',
  'heap': 'Heap',
  'priority queue': 'Heap',
  'linked list': 'Linked Lists',
  'recursion': 'Recursion',
  'backtracking': 'Backtracking',
  'bit manipulation': 'Bit Manipulation',
  'union find': 'Union Find',
  'trie': 'Trie',
  'design': 'Design',
  'simulation': 'Simulation',
  'matrix': 'Matrix'
};

function cleanText(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizePathSegment(value, fallback = 'Unknown') {
  const cleaned = cleanText(value, 120)
    .replace(/[<>:"\\|?*]/g, '_')
    .replace(/[/.]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

export function getExtension(language) {
  return LANGUAGE_EXTENSIONS[(language || '').toLowerCase()] || 'txt';
}

export function formatProblemId(id, style = 'padded') {
  if (style === 'padded') {
    return String(id).padStart(4, '0');
  }
  return String(id);
}

export function formatFileName(problem, settings = {}) {
  const { namingStyle = 'padded', includeDifficulty = false } = settings;
  const ext = getExtension(problem.language);
  const slug = sanitizePathSegment(problem.title || 'Unknown Problem', 'Unknown_Problem');
  const id = sanitizePathSegment(formatProblemId(problem.id, settings.namingStyle), '0000');
  const title = sanitizePathSegment(problem.title || 'Unknown Problem', 'Unknown_Problem');

  let base;
  if (namingStyle === 'padded') {
    base = `${id}_${slug}`;
  } else if (namingStyle === 'plain') {
    base = `${id}_${title}`;
  } else {
    base = slug;
  }

  if (includeDifficulty && problem.difficulty) {
    base += `_${sanitizePathSegment(problem.difficulty, 'Unknown')}`;
  }

  return `${base}.${ext}`;
}

export function getTopicFolder(tags = []) {
  for (const tag of tags) {
    const lower = cleanText(tag, 80).toLowerCase();
    for (const [key, folder] of Object.entries(TOPIC_FOLDER_MAP)) {
      if (lower.includes(key)) return folder;
    }
  }
  return 'Misc';
}

export function getFolderPath(problem, settings = {}) {
  const { folderOrganization = 'topic' } = settings;

  switch (folderOrganization) {
    case 'topic':
      return getTopicFolder(problem.tags || []);
    case 'difficulty':
      return sanitizePathSegment(problem.difficulty || 'Unknown');
    case 'language':
      return sanitizePathSegment(getExtension(problem.language).toUpperCase());
    case 'flat':
    default:
      return '';
  }
}

export function getFilePath(problem, settings = {}) {
  const folder = sanitizePathSegment(getFolderPath(problem, settings), '');
  const fileName = formatFileName(problem, settings);
  return folder ? `${folder}/${fileName}` : fileName;
}

export function formatCommitMessage(template, problem) {
  return cleanText(template, 200)
    .replace('{id}', cleanText(problem.id, 40))
    .replace('{title}', cleanText(problem.title, 120))
    .replace('{language}', cleanText(problem.language, 40))
    .replace('{difficulty}', cleanText(problem.difficulty || '', 20))
    .replace('{runtime}', cleanText(problem.runtime || '', 40))
    .replace('{memory}', cleanText(problem.memory || '', 40));
}

export function generateFileHeader(problem) {
  const lines = [
    `/**`,
    ` * Problem: ${cleanText(problem.id, 40)}. ${cleanText(problem.title, 120)}`,
    ` * Difficulty: ${cleanText(problem.difficulty || 'Unknown', 20)}`,
    ` * URL: https://leetcode.com/problems/${sanitizePathSegment(problem.slug, '')}/`,
    ` * Language: ${cleanText(problem.language, 40)}`,
  ];
  if (problem.runtime) lines.push(` * Runtime: ${cleanText(problem.runtime, 40)}`);
  if (problem.memory) lines.push(` * Memory: ${cleanText(problem.memory, 40)}`);
  if (problem.tags && problem.tags.length) {
    lines.push(` * Topics: ${problem.tags.map(tag => cleanText(tag, 60)).join(', ')}`);
  }
  lines.push(` * Synced: ${new Date().toISOString()}`);
  lines.push(` */`);
  lines.push('');
  return lines.join('\n');
}

export function generateReadmeContent(stats, repo) {
  const total = stats.totalSynced || 0;
  const easy = stats.easy || 0;
  const medium = stats.medium || 0;
  const hard = stats.hard || 0;

  const langTable = Object.entries(stats.languages || {})
    .sort(([, a], [, b]) => b - a)
    .map(([lang, count]) => `| ${lang} | ${count} |`)
    .join('\n');

  return `# 🧩 LeetCode Solutions

> Auto-synced via [LeetCode → GitHub Sync](https://github.com/utsav-02-20/LeetCode-Github-Sync) Chrome Extension

## 📊 Progress

![Total](https://img.shields.io/badge/Total-${total}-blue)
![Easy](https://img.shields.io/badge/Easy-${easy}-brightgreen)
![Medium](https://img.shields.io/badge/Medium-${medium}-orange)
![Hard](https://img.shields.io/badge/Hard-${hard}-red)

| Difficulty | Count | Progress |
|-----------|-------|---------|
| 🟢 Easy | ${easy} | ${'█'.repeat(Math.floor(easy / Math.max(total, 1) * 20))}${'░'.repeat(20 - Math.floor(easy / Math.max(total, 1) * 20))} |
| 🟡 Medium | ${medium} | ${'█'.repeat(Math.floor(medium / Math.max(total, 1) * 20))}${'░'.repeat(20 - Math.floor(medium / Math.max(total, 1) * 20))} |
| 🔴 Hard | ${hard} | ${'█'.repeat(Math.floor(hard / Math.max(total, 1) * 20))}${'░'.repeat(20 - Math.floor(hard / Math.max(total, 1) * 20))} |

## 💻 Languages

| Language | Solutions |
|----------|-----------|
${langTable}

## 📁 Structure

Solutions are organized by topic:
\`\`\`
${repo}/
├── Arrays/
├── Strings/
├── Trees/
├── Graphs/
├── DP/
├── Binary Search/
├── Two Pointers/
├── Sliding Window/
└── ...
\`\`\`

---
*Last updated: ${new Date().toUTCString()}*
`;
}
