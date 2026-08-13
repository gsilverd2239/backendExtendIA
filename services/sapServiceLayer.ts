import https from 'https';
import http from 'http';

export interface SapRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  sessionId?: string;
  routeId?: string;
  timeout?: number;
}

export interface SapResponse {
  status: number;
  data: any;
  headers: any;
}

// Helper to make SAP B1 Service Layer HTTPS/HTTP requests ignoring self-signed certs
export const makeSapRequest = async (
  serverUrl: string,
  endpoint: string,
  options: SapRequestOptions
): Promise<SapResponse> => {
  const url = `${serverUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
  const isHttps = url.startsWith('https://');

  const agent = isHttps
    ? new https.Agent({ rejectUnauthorized: false })
    : new http.Agent();

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  if (options.sessionId) {
    reqHeaders['Cookie'] = `B1SESSION=${options.sessionId}${options.routeId ? `; ROUTEID=${options.routeId}` : ''}`;
  }

  const timeoutMs = options.timeout || 45000;

  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const requestLib = isHttps ? https : http;

      const req = requestLib.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method,
          headers: reqHeaders,
          agent: agent,
          timeout: timeoutMs,
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            try {
              const data = rawData ? JSON.parse(rawData) : {};
              resolve({ status: res.statusCode || 200, data, headers: res.headers });
            } catch (e) {
              resolve({ status: res.statusCode || 200, data: { raw: rawData }, headers: res.headers });
            }
          });
        }
      );

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`SAP Service Layer request timed out after ${timeoutMs}ms`));
      });

      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
};
