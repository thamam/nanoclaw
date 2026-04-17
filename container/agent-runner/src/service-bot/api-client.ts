/**
 * API Client — provides key fallback/retry logic for X's API calls.
 * When an auth call fails (401/403), automatically switches to backup key and retries.
 */

import * as fs from 'node:fs';

export interface AuthFailureAlert {
  timestamp: string;
  endpoint: string;
  initialKey: 'alpha' | 'beta';
  retryKey: 'alpha' | 'beta';
  error1: string;
  error2: string;
}

/**
 * Wrapper around fetch that handles auth failures with key fallback.
 * On 401/403: switches key, retries once, then throws if both fail.
 */
export async function fetchWithKeyFallback(
  url: string,
  options: RequestInit & { currentKey: 'alpha' | 'beta'; onKeySwitch?: (newKey: 'alpha' | 'beta') => Promise<void> }
): Promise<Response> {
  const { currentKey, onKeySwitch, ...fetchOpts } = options;
  let key = currentKey;

  try {
    const res = await fetch(url, fetchOpts);
    if (res.status === 401 || res.status === 403) {
      console.log(`[API-Fallback] Auth failed with key '${key}' on ${url}`);
      
      // Switch to backup key
      const newKey = key === 'alpha' ? 'beta' : 'alpha';
      console.log(`[API-Fallback] Switching from '${key}' to '${newKey}'`);
      
      if (onKeySwitch) {
        await onKeySwitch(newKey);
      }
      
      // Retry with new key — update Authorization header
      const newOpts = { ...fetchOpts };
      if (newOpts.headers && typeof newOpts.headers === 'object') {
        (newOpts.headers as Record<string, string>)['Authorization'] = `Bearer ${newKey}`;
      }
      
      const retryRes = await fetch(url, newOpts);
      if (retryRes.status === 401 || retryRes.status === 403) {
        const error1 = `${res.status} ${res.statusText}`;
        const error2 = `${retryRes.status} ${retryRes.statusText}`;
        console.error(`[API-Fallback] Both keys failed for ${url}: ${error1} then ${error2}`);
        
        // Log alert for operator
        const alert: AuthFailureAlert = {
          timestamp: new Date().toISOString(),
          endpoint: url,
          initialKey: key,
          retryKey: newKey,
          error1,
          error2,
        };
        
        // Write to alert log
        try {
          const alertLog = '/tmp/api-auth-failures.log';
          fs.appendFileSync(alertLog, JSON.stringify(alert) + '\n');
          console.log(`[API-Fallback] Alert logged to ${alertLog}`);
        } catch (e) {
          console.error(`[API-Fallback] Failed to log alert: ${e}`);
        }
        
        return retryRes; // Return the error response
      }
      
      console.log(`[API-Fallback] Retry succeeded with key '${newKey}'`);
      return retryRes;
    }
    
    return res;
  } catch (err) {
    console.error(`[API-Fallback] Network error on ${url}:`, err);
    throw err;
  }
}
