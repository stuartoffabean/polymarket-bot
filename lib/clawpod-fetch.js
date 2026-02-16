#!/usr/bin/env node
/**
 * ClawPod-powered web fetching utility
 * 
 * Two main exports:
 * 1. clawpodFetch(url, opts) - Always uses Massive Unblocker proxy
 * 2. smartFetch(url, opts) - Intelligently routes between ClawPod and direct fetch
 * 
 * Uses Massive Unblocker API for proxy-backed fetching with JS rendering,
 * CAPTCHA solving, and anti-bot protection bypass.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const MASSIVE_UNBLOCKER_TOKEN = process.env.MASSIVE_UNBLOCKER_TOKEN || '';
const UNBLOCKER_API = 'https://unblocker.joinmassive.com/browser';

// Default options
const DEFAULT_OPTS = {
  maxChars: 5000,
  delay: null,
  expiration: 0, // 0 = no cache, always fresh
  format: 'rendered', // 'rendered' or 'raw'
  timeout: 120000, // 2 minutes (API can take time with CAPTCHAs)
};

/**
 * Import node-html-markdown for HTML -> Markdown conversion
 * Requires: NODE_PATH=$(npm root -g) when calling node
 */
let NodeHtmlMarkdown = null;
try {
  NodeHtmlMarkdown = require('node-html-markdown').NodeHtmlMarkdown;
} catch (e) {
  console.warn('[clawpod-fetch] node-html-markdown not available, will return raw HTML');
}

/**
 * Convert HTML to markdown using node-html-markdown
 * Falls back to raw HTML if conversion fails
 */
function htmlToMarkdown(html) {
  if (!NodeHtmlMarkdown) return html;
  try {
    return NodeHtmlMarkdown.translate(html);
  } catch (e) {
    console.warn('[clawpod-fetch] Markdown conversion failed:', e.message);
    return html;
  }
}

/**
 * Generic HTTP GET helper (for direct fetches)
 */
function httpGet(url, timeoutMs = 10000, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'PolymarketScanner/1.0 (ClawPod)',
        ...headers,
      },
    }, res => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs, headers)
          .then(resolve)
          .catch(reject);
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data,
        });
      });
    });
    
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Fetch a URL via Massive Unblocker (ClawPod)
 * Returns: { ok: boolean, data: string (markdown), error?: string }
 * 
 * @param {string} url - Target URL to fetch
 * @param {Object} opts - Options: maxChars, delay, expiration, format, timeout
 */
async function clawpodFetch(url, opts = {}) {
  if (!MASSIVE_UNBLOCKER_TOKEN) {
    return {
      ok: false,
      error: 'MASSIVE_UNBLOCKER_TOKEN not set in environment',
    };
  }

  const options = { ...DEFAULT_OPTS, ...opts };
  
  try {
    // Build query string
    const params = new URLSearchParams({ url });
    if (options.expiration !== null && options.expiration !== undefined) {
      params.append('expiration', String(options.expiration));
    }
    if (options.delay) params.append('delay', String(options.delay));
    if (options.format) params.append('format', options.format);
    
    const apiUrl = `${UNBLOCKER_API}?${params.toString()}`;
    
    // Fetch via Massive Unblocker
    const result = await httpGet(apiUrl, options.timeout, {
      'Authorization': `Bearer ${MASSIVE_UNBLOCKER_TOKEN}`,
    });
    
    if (!result.ok) {
      return {
        ok: false,
        error: `Unblocker API returned ${result.status}`,
        status: result.status,
      };
    }
    
    // Convert HTML to markdown
    let text = htmlToMarkdown(result.data);
    
    // Truncate if needed
    if (options.maxChars && text.length > options.maxChars) {
      text = text.slice(0, options.maxChars) + '\n\n[... truncated ...]';
    }
    
    return {
      ok: true,
      data: text,
      status: result.status,
    };
    
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Smart fetch: intelligently routes between ClawPod and direct fetch
 * 
 * ClawPod routing rules:
 * - Always use for: polymarket.com
 * - Always use for: domains in opts.proxyDomains array
 * - Direct fetch for: newsapi.org, api.*, raw JSON endpoints
 * - Default: try direct first, fall back to ClawPod if it fails
 * 
 * @param {string} url - Target URL
 * @param {Object} opts - Options (same as clawpodFetch) + proxyDomains array
 */
async function smartFetch(url, opts = {}) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const proxyDomains = opts.proxyDomains || [];
  
  // Always use ClawPod for these domains
  const alwaysProxy = [
    'polymarket.com',
    'www.polymarket.com',
    ...proxyDomains,
  ];
  
  // Always use direct fetch for these
  const alwaysDirect = [
    'newsapi.org',
  ];
  
  // Check for API endpoints (api.* or /api/ in path)
  const isApiEndpoint = hostname.startsWith('api.') || parsed.pathname.includes('/api/');
  
  // Routing decision
  const shouldUseProxy = alwaysProxy.some(d => hostname.includes(d));
  const shouldUseDirect = alwaysDirect.some(d => hostname.includes(d)) || isApiEndpoint;
  
  // Force ClawPod
  if (shouldUseProxy) {
    return clawpodFetch(url, opts);
  }
  
  // Force direct
  if (shouldUseDirect) {
    try {
      const result = await httpGet(url, opts.timeout || 10000);
      if (!result.ok) {
        return {
          ok: false,
          error: `Direct fetch failed with status ${result.status}`,
          status: result.status,
        };
      }
      
      let text = result.data;
      
      // Try to convert HTML to markdown if it looks like HTML
      if (text.trim().startsWith('<') && NodeHtmlMarkdown) {
        try {
          text = htmlToMarkdown(text);
        } catch (e) {
          // Keep as-is if conversion fails (likely JSON)
        }
      }
      
      // Truncate if needed
      if (opts.maxChars && text.length > opts.maxChars) {
        text = text.slice(0, opts.maxChars) + '\n\n[... truncated ...]';
      }
      
      return {
        ok: true,
        data: text,
        status: result.status,
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error),
      };
    }
  }
  
  // Default: try direct first, fall back to ClawPod
  try {
    const directResult = await httpGet(url, opts.timeout || 10000);
    
    // If direct fetch worked and returned content, use it
    if (directResult.ok && directResult.data && directResult.data.trim().length > 0) {
      let text = directResult.data;
      
      // Try markdown conversion if HTML
      if (text.trim().startsWith('<') && NodeHtmlMarkdown) {
        try {
          text = htmlToMarkdown(text);
        } catch (e) {
          // Keep raw
        }
      }
      
      if (opts.maxChars && text.length > opts.maxChars) {
        text = text.slice(0, opts.maxChars) + '\n\n[... truncated ...]';
      }
      
      return {
        ok: true,
        data: text,
        status: directResult.status,
      };
    }
    
    // Direct fetch failed or returned empty, fall back to ClawPod
    console.log(`[smartFetch] Direct fetch failed/empty for ${hostname}, falling back to ClawPod`);
    return clawpodFetch(url, opts);
    
  } catch (error) {
    // Direct fetch threw error, fall back to ClawPod
    console.log(`[smartFetch] Direct fetch error for ${hostname} (${error.message}), falling back to ClawPod`);
    return clawpodFetch(url, opts);
  }
}

module.exports = {
  clawpodFetch,
  smartFetch,
};

// CLI test interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const url = args[0];
  
  if (!url) {
    console.error('Usage: node clawpod-fetch.js <url>');
    process.exit(1);
  }
  
  const testOpts = {
    maxChars: 2000,
    expiration: 0,
  };
  
  console.log(`\n=== Testing clawpodFetch("${url}") ===\n`);
  clawpodFetch(url, testOpts).then(result => {
    if (result.ok) {
      console.log(result.data);
      console.log(`\n[OK] ${result.data.length} chars fetched`);
    } else {
      console.error(`[ERROR] ${result.error}`);
      process.exit(1);
    }
  });
}
