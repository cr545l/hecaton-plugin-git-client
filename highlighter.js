/**
 * Syntax highlighting module using highlight.js with ANSI output.
 * Similar to Crush's chroma-based approach but for JavaScript.
 */

const path = require('path');

// Load highlight.js from local directory
const hljs = require('./highlight/highlight.min.js');

const CSI = '\x1b[';

// ANSI color definitions (matching Crush's dark theme palette)
const theme = {
  // Token types -> ANSI codes
  keyword: CSI + '94m',       // bright blue
  built_in: CSI + '96m',      // bright cyan
  type: CSI + '93m',          // bright yellow
  literal: CSI + '92m',       // bright green
  number: CSI + '92m',        // bright green
  string: CSI + '33m',        // yellow (cumin-like)
  comment: CSI + '90m',       // bright black (dim)
  function: CSI + '92m',      // bright green (guac-like)
  variable: CSI + '95m',      // bright magenta
  operator: CSI + '91m',      // bright red (salmon-like)
  punctuation: CSI + '93m',   // bright yellow (zest-like)
  class_: CSI + '4m',         // underline
  decorator: CSI + '93m',     // bright yellow (citron-like)
  property: CSI + '96m',      // bright cyan
  default: '',                // no color change - preserve existing foreground
};

// Language detection cache
const langCache = new Map();

// Highlighted line cache (content -> highlighted)
const highlightCache = new Map();
const MAX_CACHE_SIZE = 1000;

/**
 * Get language from file path
 */
function getLanguage(filePath) {
  if (!filePath) return null;

  if (langCache.has(filePath)) {
    return langCache.get(filePath);
  }

  const ext = path.extname(filePath).toLowerCase().slice(1);
  const langMap = {
    'js': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'jsx': 'javascript',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'cs': 'csharp',
    'java': 'java',
    'kt': 'kotlin',
    'scala': 'scala',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'ps1': 'powershell',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'md': 'markdown',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'sql': 'sql',
    'php': 'php',
    'lua': 'lua',
    'r': 'r',
    'vue': 'vue',
    'svelte': 'svelte',
    'dockerfile': 'dockerfile',
    'make': 'makefile',
    'mk': 'makefile',
    'cmake': 'cmake',
    'ini': 'ini',
    'cfg': 'ini',
    'conf': 'nginx',
    'nginx': 'nginx',
    'xml': 'xml',
    'svg': 'xml',
    'markdown': 'markdown',
  };

;
  const lang = langMap[ext] || ext;

  // Check if language is supported
  if (hljs.getLanguage(lang)) {
    langCache.set(filePath, lang);
    return lang;
  }

  return null;
}
/**
 * Map highlight.js class names to ANSI codes
 */
function getAnsiForClass(className) {
  if (!className) return theme.default;
;
  const cls = className.toLowerCase();

  if (cls.includes('keyword')) return theme.keyword;
  if (cls.includes('built_in')) return theme.built_in;
  if (cls.includes('type')) return theme.type;
  if (cls.includes('literal')) return theme.literal;
  if (cls.includes('number')) return theme.number;
  if (cls.includes('string')) return theme.string;
  if (cls.includes('comment')) return theme.comment;
  if (cls.includes('function')) return theme.function;
  if (cls.includes('variable')) return theme.variable;
  if (cls.includes('operator')) return theme.operator;
  if (cls.includes('punctuation')) return theme.punctuation;
  if (cls.includes('class')) return theme.class_;
  if (cls.includes('decorator') || cls.includes('meta')) return theme.decorator;
  if (cls.includes('property') || cls.includes('attr')) return theme.property;
  if (cls.includes('title')) return theme.function;
  if (cls.includes('params')) return theme.variable;
  if (cls.includes('symbol')) return theme.keyword;
  if (cls.includes('regexp')) return theme.string;
  if (cls.includes('template')) return theme.string;
  if (cls.includes('subst')) return theme.variable;
;
  return theme.default;
}

/**
 * Custom formatter that outputs ANSI instead of HTML
 * IMPORTANT: Does NOT reset colors to preserve background colors set by caller
 * Only changes foreground color, never resets to default
 */
function formatToAnsi(result) {
  const { value } = result;
  if (!value) return '';

  let output = '';
  let currentColor = null;

  // Parse HTML span tags and convert to ANSI
  const spanRegex = /<span class="([^"]+)">([^<]*)<\/span>|([^<]+)/g;
  let match;

  while ((match = spanRegex.exec(value)) !== null) {
    if (match[3] !== undefined) {
      // Plain text - don't reset, just output as-is
      output += match[3];
    } else {
      // Styled span
      const className = match[1];
      const text = match[2];
      const color = getAnsiForClass(className);

      if (color !== currentColor) {
        if (color) {
          output += color;
        }
        currentColor = color;
      }
      output += text;
    }
  }

  return output;
}

/**
 * Highlight a single line of code
 */
function highlightLine(line, lang) {
  if (!lang || !line || !line.trim()) {
    return line;
  }

  // Check cache
  const cacheKey = lang + ':' + line;
  if (highlightCache.has(cacheKey)) {
    return highlightCache.get(cacheKey);
  }

  try {
    const result = hljs.highlight(line, { language: lang, ignoreIllegals: true });
    const highlighted = formatToAnsi(result);

    // Manage cache size
    if (highlightCache.size >= MAX_CACHE_SIZE) {
      const firstKey = highlightCache.keys().next().value;
      highlightCache.delete(firstKey);
    }

    highlightCache.set(cacheKey, highlighted);
    return highlighted;
  } catch (e) {
    return line;
  }
}
/**
 * Highlight code with background color support
 * @param {string} code - The code to highlight
 * @param {string} filePath - File path for language detection
 * @param {object} bgColor - Background color {r, g, b} (for future use)
 * @returns {string} ANSI highlighted code
 */
function highlightCode(code, filePath, bgColor) {
  if (!code) return code;

  const lang = getLanguage(filePath);
  if (!lang) return code;

  // For multi-line code, highlight each line
  const lines = code.split('\n');
  const highlighted = lines.map(line => highlightLine(line, lang));

  return highlighted.join('\n');
}
/**
 * Clear the highlight cache (call when content changes significantly)
 */
function clearCache() {
  highlightCache.clear();
}
/**
 * Get supported languages
 */
function getSupportedLanguages() {
  return hljs.listLanguages();
}
module.exports = {
  highlightCode,
  highlightLine,
  getLanguage,
  clearCache,
  getSupportedLanguages,
  theme,
};
