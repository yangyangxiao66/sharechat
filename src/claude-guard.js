// Claude is not available in mainland China. Check the current egress IP right
// before a local Claude launch; fail closed when the region cannot be verified.
const CACHE_MS = 60_000;

const ENDPOINTS = [
  {
    url: 'https://ipwho.is/',
    parse: (text) => {
      try {
        const data = JSON.parse(text);
        return typeof data.country_code === 'string' ? data.country_code.toUpperCase() : '';
      } catch {
        return '';
      }
    },
  },
  {
    url: 'https://ipwhois.app/json/',
    parse: (text) => {
      try {
        const data = JSON.parse(text);
        return typeof data.country_code === 'string' ? data.country_code.toUpperCase() : '';
      } catch {
        return '';
      }
    },
  },
  {
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    parse: (text) => text.match(/^loc=([A-Z]{2})$/m)?.[1] || '',
  },
  {
    url: 'https://ipinfo.io/json',
    parse: (text) => {
      try {
        const data = JSON.parse(text);
        return typeof data.country === 'string' ? data.country.toUpperCase() : '';
      } catch {
        return '';
      }
    },
  },
];

let cache = { at: 0, value: null };

export function resetClaudeGuardCache() {
  cache = { at: 0, value: null };
}

async function countryFromEndpoint(fetchImpl, endpoint, timeoutMs) {
  const response = await fetchImpl(endpoint.url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/plain, application/json' },
  });
  if (!response.ok) throw new Error(`geolocation HTTP ${response.status}`);
  const country = endpoint.parse(await response.text());
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('geolocation returned no country');
  return country;
}

export async function detectCountry({ fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  for (const endpoint of ENDPOINTS) {
    try {
      return await countryFromEndpoint(fetchImpl, endpoint, timeoutMs);
    } catch {
      // Try the next endpoint.
    }
  }
  return '';
}

export async function checkClaudeRegion(options = {}) {
  const now = Date.now();
  if (!options.noCache && cache.value && now - cache.at < CACHE_MS) return cache.value;
  const country = await detectCountry(options);
  const value = country
    ? { allowed: country !== 'CN', country, reason: country === 'CN' ? 'mainland' : 'ok' }
    : { allowed: false, country: '', reason: 'unknown' };
  cache = { at: now, value };
  return value;
}

export async function assertClaudeLaunchAllowed(options = {}) {
  const result = await checkClaudeRegion(options);
  if (!result.allowed) {
    throw new Error(result.reason === 'mainland'
      ? `检测到当前出口 IP 位于中国大陆（${result.country}），已禁止启动 Claude Code。`
      : '无法确认当前网络地区，已禁止启动 Claude Code。');
  }
  return result;
}
