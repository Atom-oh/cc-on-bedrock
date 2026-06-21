'use strict';

/**
 * DevEnv Session Validator — Lambda@Edge (Viewer Request)
 *
 * Validates NextAuth session cookie for *.dev.atomai.click requests.
 * Ensures each user can only access their own subdomain (X-Auth-User injection).
 * Dashboard requests pass through untouched.
 *
 * Replaces the previous Cognito OAuth Lambda@Edge (devenv-auth-edge) with a
 * simpler cookie-only validator — no OAuth flow, no JWKS, no token exchange.
 *
 * Config: NEXTAUTH_SECRET is stored in SSM Parameter Store and read on cold start.
 * Static values (__DEV_DOMAIN__, __DASHBOARD_URL__, __SSM_REGION__) are baked in at CDK synth time.
 */

const crypto = require('crypto');
const https = require('https');

// Static config (replaced by sed at CDK synth time)
const DEV_DOMAIN = '__DEV_DOMAIN__';
const DASHBOARD_LOGIN_URL = '__DASHBOARD_URL__/login';
const SSM_REGION = '__SSM_REGION__';
const SSM_PARAM_NAME = '/cc-on-bedrock/nextauth-secret';

// Config cache (loaded from SSM on cold start)
let encryptionKey = null;
let configPromise = null;

// ─── SSM Config Loading ───

function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    try {
      const secret = await ssmGetParameter(SSM_REGION, SSM_PARAM_NAME);
      // Derive encryption key same as NextAuth: HKDF(SHA-256, secret, '', info, 32)
      encryptionKey = crypto.hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32);
      return encryptionKey;
    } catch (e) {
      configPromise = null;
      throw e;
    }
  })();
  return configPromise;
}

// Self-contained SigV4 signed SSM:GetParameter — avoids any SDK dependency
// (Lambda@Edge Node 20 runtime does not ship aws-sdk v2; v3 needs bundling).
function ssmGetParameter(region, name) {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN || '';
  if (!accessKey || !secretKey) {
    return Promise.reject(new Error('Lambda IAM credentials not present in env'));
  }
  const service = 'ssm';
  const host = `ssm.${region}.amazonaws.com`;
  const target = 'AmazonSSM.GetParameter';
  const body = JSON.stringify({ Name: name, WithDecryption: true });

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const baseHeaders = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  };
  if (sessionToken) baseHeaders['x-amz-security-token'] = sessionToken;
  const sortedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = sortedHeaderNames.map(h => `${h}:${baseHeaders[h]}\n`).join('');
  const signedHeaders = sortedHeaderNames.join(';');
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = crypto.createHmac('sha256', 'AWS4' + secretKey).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': target,
        'X-Amz-Date': amzDate,
        Authorization: authHeader,
        ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`SSM HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (!parsed.Parameter || !parsed.Parameter.Value) {
            return reject(new Error(`SSM response missing Parameter.Value: ${data}`));
          }
          resolve(parsed.Parameter.Value);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('SSM request timeout')));
    req.write(body);
    req.end();
  });
}

// ─── JWE Decryption (NextAuth v4 uses A256GCM with direct key agreement) ───

function decryptNextAuthJwe(token) {
  if (!encryptionKey) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 5) return null;

    const [headerB64, encKeyB64, ivB64, ciphertextB64, tagB64] = parts;
    const header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));

    // NextAuth uses "dir" key management (direct encryption with derived key)
    if (header.alg !== 'dir' || header.enc !== 'A256GCM') return null;

    const iv = base64urlDecode(ivB64);
    const ciphertext = base64urlDecode(ciphertextB64);
    const tag = base64urlDecode(tagB64);

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    // AAD is the base64url-encoded header per JWE spec
    decipher.setAAD(Buffer.from(headerB64, 'ascii'));

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function base64urlDecode(str) {
  // Pad base64url to base64 and decode
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ─── Cookie Parsing ───

function parseCookies(headers) {
  const cookies = {};
  if (!headers.cookie) return cookies;
  for (const entry of headers.cookie) {
    for (const pair of entry.value.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      if (name) cookies[name.trim()] = rest.join('=').trim();
    }
  }
  return cookies;
}

// ─── Response Helpers ───

function redirectToLogin(originalHost, request) {
  const originalUrl = `https://${originalHost}${request.uri}${request.querystring ? '?' + request.querystring : ''}`;
  const loginUrl = `${DASHBOARD_LOGIN_URL}?callbackUrl=${encodeURIComponent(originalUrl)}`;
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: loginUrl }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store' }],
    },
  };
}

function forbidden(message) {
  return {
    status: '403',
    statusDescription: 'Forbidden',
    headers: { 'content-type': [{ key: 'Content-Type', value: 'text/plain' }] },
    body: message || 'Forbidden',
  };
}

// ─── Handler ───

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const host = (headers.host && headers.host[0].value) || '';

  // Pass through non-devenv requests (dashboard traffic)
  if (!host.endsWith(`.${DEV_DOMAIN}`)) return request;

  // Health check bypass (NLB health checks)
  const uri = request.uri;
  if (uri === '/health' || uri === '/nginx-status') return request;

  // Extract subdomain from Host header
  const subdomain = host.slice(0, -(DEV_DOMAIN.length + 1));
  if (!subdomain || subdomain.includes('.')) return forbidden('Invalid subdomain');

  // Load encryption key from SSM (cached after cold start)
  try {
    await loadConfig();
  } catch (e) {
    console.error('Failed to load config:', e);
    return { status: '500', statusDescription: 'Internal Server Error', body: 'Auth config unavailable' };
  }

  // Read NextAuth session cookie
  const cookies = parseCookies(headers);
  const sessionToken = cookies['__Secure-next-auth.session-token'] || cookies['next-auth.session-token'];
  if (!sessionToken) return redirectToLogin(host, request);

  // Decrypt JWE token
  const payload = decryptNextAuthJwe(sessionToken);
  if (!payload) return redirectToLogin(host, request);

  // Check token expiration
  if (payload.exp && Date.now() / 1000 > payload.exp) return redirectToLogin(host, request);

  // Subdomain ownership check: user can only access their own environment
  if (payload.subdomain !== subdomain) return forbidden('Not authorized for this environment');

  // Inject X-Auth-User header for Nginx defense-in-depth
  request.headers['x-auth-user'] = [{ key: 'X-Auth-User', value: subdomain }];

  return request;
};
